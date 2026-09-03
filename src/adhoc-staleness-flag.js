'use strict';

// Adhoc "dead task" flag sweep (2026-09-03, Grimmethy: "there still needs to be a
// systematic way to identify that these tasks are no longer valid" -- deleting stays a
// human decision, but a human needs a signal telling them WHICH tasks and WHY).
//
// Runs every watchdog tick over queue/blocked/ + queue/needs-clarification/. For each task
// that trips a deterministic staleness criterion (staleness-audit.js's findStaleness
// Candidates, now with `already-implemented` / `invalid-premise` / `duplicate-of` /
// `decompose-loop`) it stamps a `stalenessFlag` on the task IN PLACE -- it never moves,
// archives, or deletes anything. A human acts on it from the dashboard (the existing
// /api/task/<state>/<id>/archive button, or the new "Keep" button that sets a cooldown).
//
//   high confidence   -> stamp the flag directly, no model call
//   medium confidence -> a local CONFIRM/DENY majority vote (auto-confirm-review.js's
//                        pattern) can promote it to high or drop it with a cooldown;
//                        inconclusive leaves the medium flag for the human
//   stale-age only    -> left entirely to the staleness_audit SOURCE's model recheck
//
// Idempotent: a task that already carries a fresh flag for the same reason, or an
// unexpired `stalenessKeep` cooldown, is skipped. Kill switch:
// AGENT_MANAGER_ADHOC_STALENESS_FLAG=false.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');
const { findStalenessCandidates } = require('./staleness-audit.js');
const { classifyVote } = require('./auto-confirm-review.js');

const SCAN_DIRS = ['blocked', 'needs-clarification'];
const CORPUS_DIRS = ['pending', 'drafting', 'blocked', 'needs-clarification', 'coordinating', 'adhoc', 'approved', 'review'];
const DONE_STATES = new Set(['done', 'merged', 'applied-direct', 'archived', 'filed']);
const FLAG_TTL_MS = 3 * 24 * 60 * 60 * 1000;        // re-evaluate a stamped flag after this long
const KEEP_COOLDOWN_MS = 21 * 24 * 60 * 60 * 1000;  // "Keep" suppresses re-flagging for this long
const RECENT_DONE_LIMIT = 400;
const VOTES = Number(process.env.AGENT_MANAGER_ADHOC_STALENESS_VOTES) || 3;
const MIN_AGREEING = Number(process.env.AGENT_MANAGER_ADHOC_STALENESS_MIN_AGREEING) || 2;
// The medium-confidence CONFIRM/DENY vote is OFF by default: each candidate is 3 local
// 27B calls that contend on the GPU single-flight lock with the workers, and a sweep with
// 7 candidates blocked the whole watchdog loop for ~6 minutes a tick (caught live
// 2026-09-03). A medium flag + its evidence is already enough for the human to act on.
// Turn the vote on with AGENT_MANAGER_ADHOC_STALENESS_VOTE=true; even then it is capped
// at MAX_VOTES_PER_SWEEP per tick (unvoted mediums stamp directly and get a turn later).
const VOTE_ENABLED = process.env.AGENT_MANAGER_ADHOC_STALENESS_VOTE === 'true';
const MAX_VOTES_PER_SWEEP = Number(process.env.AGENT_MANAGER_ADHOC_STALENESS_MAX_VOTES_PER_SWEEP) || 2;

// --- classification -----------------------------------------------------------------

// candidate: { task, reasons[], evidence[], duplicateOf, touchedFiles[] } from
// findStalenessCandidates. Returns { reason, disposition, confidence, evidence[] } or null
// (nothing this module acts on -- e.g. stale-age only).
function classifyStaleTask(candidate) {
  const r = new Set(candidate.reasons || []);
  const dup = candidate.duplicateOf || null;
  const ev = Array.isArray(candidate.evidence) ? candidate.evidence.slice() : [];

  const mk = (reason, disposition, confidence, extra = []) => ({
    reason, disposition, confidence, evidence: [...ev, ...extra],
  });

  // High-confidence deterministic -- nothing left to build.
  if (r.has('already-implemented-strong')) return mk('already-implemented', 'retire', 'high');
  if (r.has('invalid-premise')) return mk('invalid-premise', 'retire', 'high');
  if (dup && DONE_STATES.has(String(dup.state))) {
    return mk('duplicate-of', 'retire', 'high', [`the matched task ${dup.id} is already ${dup.state}`]);
  }

  // Medium -- a human (or a vote) should confirm.
  if (dup) return mk('duplicate-of', 'retire', 'medium', [`overlaps live task ${dup.id} (${dup.state || 'queued'})`]);
  if (r.has('decompose-loop')) {
    return mk('decompose-loop', 're-scope', 'medium',
      ['every draft attempt chose to decompose and never produced usable pieces -- re-file as a product_spec or split into smaller adhoc tasks by hand']);
  }
  if (r.has('possibly-resolved') && (r.has('retries-exhausted') || r.has('fabrication-repeat'))) {
    ev.push(`(also: files this task names were committed to after it was filed: ${(candidate.touchedFiles || []).join(', ')})`);
  }
  if (r.has('fabrication-repeat')) {
    return mk('fabrication-repeat', 'capability-ceiling', 'medium',
      ['repeatedly rejected for fabricated/ungrounded content -- the local model cannot ground this; needs a human or a Claude-opt-in run']);
  }
  if (r.has('retries-exhausted')) {
    return mk('retries-exhausted', 'capability-ceiling', 'medium',
      ['the pipeline exhausted its automatic retries and will never touch this again on its own -- needs a human decision or a Claude-opt-in run']);
  }

  // possibly-resolved alone, or stale-age alone -> the staleness_audit source's model
  // recheck owns these; nothing for this module to stamp.
  return null;
}

// --- flag write ---------------------------------------------------------------------

function existingFlagIsFresh(task, reason, now) {
  const f = task.stalenessFlag;
  if (!f || f.reason !== reason) return false;
  const t = Date.parse(f.flaggedAt || '');
  return Number.isFinite(t) && now - t < FLAG_TTL_MS;
}

function keepCooldownActive(task, now) {
  const k = task.stalenessKeep;
  if (!k) return false;
  const until = Date.parse(k.until || '');
  return Number.isFinite(until) && until > now;
}

function writeFlag(taskFilePath, task, flag, now) {
  task.stalenessFlag = {
    reason: flag.reason,
    disposition: flag.disposition,
    confidence: flag.confidence,
    evidence: flag.evidence,
    flaggedAt: new Date(now).toISOString(),
    votedAt: flag.votedAt || null,
    voteResult: flag.voteResult || null,
  };
  appendHistoryEvent(task, 'advisory',
    `staleness flag: ${flag.reason} (${flag.confidence}, ${flag.disposition}) -- ${flag.evidence[0] || ''}`.slice(0, 400));
  fs.writeFileSync(taskFilePath, JSON.stringify(task, null, 2));
}

function writeKeep(taskFilePath, task, reason, now) {
  delete task.stalenessFlag;
  task.stalenessKeep = { until: new Date(now + KEEP_COOLDOWN_MS).toISOString(), by: 'staleness-vote', reason };
  appendHistoryEvent(task, 'advisory', `staleness flag dropped by CONFIRM/DENY vote -- ${reason}`.slice(0, 300));
  fs.writeFileSync(taskFilePath, JSON.stringify(task, null, 2));
}

// --- vote (medium confidence only) ------------------------------------------------

function buildStalenessVotePrompt(task, flag) {
  const ctx = task.promptContext || {};
  return [
    'You are deciding whether a stuck pipeline task is DEAD -- meaning: the work it asks for',
    'is already done, it duplicates another task, its premise no longer matches the code, or',
    'it can never be built as written and should be retired rather than left in the queue.',
    '',
    `TASK: ${task.title || task.id}`,
    `CURRENT STATE: ${task.status || 'unknown'} | last blocked reason: ${(task.blockedReason || '(none)').slice(0, 300)}`,
    '',
    'ORIGINAL REQUEST:',
    (ctx.rawText || task.title || '(none)').slice(0, 1800),
    '',
    `A deterministic check flagged this as "${flag.reason}" (${flag.disposition}). Evidence:`,
    ...flag.evidence.map((e) => `- ${e}`),
    '',
    'Answer with CONFIRM or DENY on its own line, then 1-3 sentences of reasoning:',
    '- CONFIRM = yes, this task is dead / should be retired or re-scoped (the evidence holds up).',
    '- DENY = no, this is still valid work the pipeline should keep trying (the evidence is wrong or weak).',
  ].join('\n');
}

async function runVote(task, flag, majorityVote) {
  const vote = await majorityVote({
    prompt: buildStalenessVotePrompt(task, flag),
    classify: classifyVote(['CONFIRM', 'DENY'], 15),
    n: VOTES,
    minAgreeing: MIN_AGREEING,
    temperature: 0.2,
    source: 'staleness_audit',
  });
  return vote;
}

// --- sweep ------------------------------------------------------------------------

function readTasks(pipelineDir, dirNames) {
  const out = [];
  for (const d of dirNames) {
    const dir = path.join(pipelineDir, 'queue', d);
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of names) {
      if (ent.isDirectory()) {
        // drafting/<instance>/ subdirs
        try {
          for (const f of fs.readdirSync(path.join(dir, ent.name))) {
            if (f.endsWith('.json')) pushTask(out, path.join(dir, ent.name, f), d);
          }
        } catch { /* skip */ }
        continue;
      }
      if (ent.name.endsWith('.json')) pushTask(out, path.join(dir, ent.name), d);
    }
  }
  return out;
}

function pushTask(arr, filePath, state) {
  try {
    const task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (task && task.id) arr.push({ task, filePath, state });
  } catch { /* malformed -- skip */ }
}

function recentDoneTasks(pipelineDir, limit) {
  const dir = path.join(pipelineDir, 'queue', 'done');
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, m: safeMtime(path.join(dir, f)) }))
      .sort((a, b) => b.m - a.m).slice(0, limit);
  } catch { return []; }
  const out = [];
  for (const { f } of entries) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (t && t.id) { t.state = 'done'; out.push(t); }
    } catch { /* skip */ }
  }
  return out;
}

function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

async function sweep({ pipelineDir, repoRoot, majorityVote, dryRun = false, now = Date.now() }) {
  const summary = { scanned: 0, flagged: 0, highConfidence: 0, voted: 0, confirmed: 0, dropped: 0, skipped: 0, errors: 0, wouldFlag: [] };
  if (process.env.AGENT_MANAGER_ADHOC_STALENESS_FLAG === 'false') return summary;

  // Scoped to adhoc / brain-dump / manual tasks -- the "dead adhoc task" question. Other
  // stuck sources (observability_fix, function_length_review, ...) have their own handling
  // (blocked-drain, the hygiene ceiling) and the staleness_audit source still covers them.
  const scanned = readTasks(pipelineDir, SCAN_DIRS)
    .filter(({ task }) => task.domain === 'adhoc' || task.source === 'manual' || String(task.id).startsWith('adhoc-'));
  summary.scanned = scanned.length;
  if (scanned.length === 0) return summary;

  const corpus = [
    ...readTasks(pipelineDir, CORPUS_DIRS).map(({ task, state }) => ({ ...task, state })),
    ...recentDoneTasks(pipelineDir, RECENT_DONE_LIMIT),
  ];

  const candidates = findStalenessCandidates(
    scanned.map((s) => s.task), {}, now, { repoRoot, corpusTasks: corpus },
  );
  const byId = new Map(scanned.map((s) => [s.task.id, s]));

  for (const candidate of candidates) {
    const entry = byId.get(candidate.task.id);
    if (!entry) continue;
    const { task, filePath } = entry;

    if (keepCooldownActive(task, now)) { summary.skipped += 1; continue; }

    const flag = classifyStaleTask(candidate);
    if (!flag) { summary.skipped += 1; continue; }
    if (existingFlagIsFresh(task, flag.reason, now)) { summary.skipped += 1; continue; }

    if (dryRun) {
      summary.wouldFlag.push({ id: task.id, state: entry.state, ...flag });
      summary.flagged += 1;
      continue;
    }

    try {
      if (flag.confidence === 'high') {
        writeFlag(filePath, task, flag, now);
        summary.flagged += 1; summary.highConfidence += 1;
        continue;
      }
      // medium -> optionally a capped CONFIRM/DENY vote; otherwise stamp directly.
      if (!VOTE_ENABLED || !majorityVote || summary.voted >= MAX_VOTES_PER_SWEEP) {
        writeFlag(filePath, task, flag, now); summary.flagged += 1; continue;
      }
      summary.voted += 1;
      let vote;
      try {
        vote = await runVote(task, flag, majorityVote);
      } catch (e) {
        // all votes hard-failed (infra) -- stamp the medium flag anyway so the human sees it
        writeFlag(filePath, task, { ...flag, voteResult: 'vote-error' }, now);
        summary.flagged += 1; summary.errors += 1;
        continue;
      }
      const votedAt = new Date(now).toISOString();
      if (vote.confident && vote.verdict === 'CONFIRM') {
        writeFlag(filePath, task, { ...flag, confidence: 'high', votedAt, voteResult: `CONFIRM ${vote.realVoteCount}/${vote.requestedVotes}` }, now);
        summary.flagged += 1; summary.confirmed += 1;
      } else if (vote.confident && vote.verdict === 'DENY') {
        writeKeep(filePath, task, `vote DENY ${vote.realVoteCount}/${vote.requestedVotes}`, now);
        summary.dropped += 1;
      } else {
        writeFlag(filePath, task, { ...flag, votedAt, voteResult: 'inconclusive' }, now);
        summary.flagged += 1;
      }
    } catch (e) {
      console.error(`[adhoc-staleness-flag] ${task.id}: ${e && e.message}`);
      summary.errors += 1;
    }
  }
  return summary;
}

module.exports = { classifyStaleTask, sweep, buildStalenessVotePrompt, FLAG_TTL_MS, KEEP_COOLDOWN_MS };

// --- CLI --------------------------------------------------------------------------
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const { pipelineDir, repoRoot } = getConfig();
  let majorityVote = null;
  if (!dryRun) {
    try { ({ majorityVote } = require('./local-client.js')); } catch { /* votes just won't run */ }
  }
  sweep({ pipelineDir, repoRoot, majorityVote, dryRun })
    .then((s) => {
      if (dryRun) {
        for (const w of s.wouldFlag) {
          console.log(`\n[${w.confidence}] ${w.id}  (${w.state})`);
          console.log(`  reason: ${w.reason} -> ${w.disposition}`);
          for (const e of w.evidence) console.log(`  - ${e}`);
        }
        console.log(`\nwould flag ${s.flagged} / scanned ${s.scanned}`);
      } else {
        console.log(`adhoc-staleness-flag: scanned=${s.scanned} flagged=${s.flagged} (high=${s.highConfidence} voted=${s.voted} confirmed=${s.confirmed} dropped=${s.dropped}) skipped=${s.skipped} errors=${s.errors}`);
      }
      process.exit(0);
    })
    .catch((e) => { console.error('[adhoc-staleness-flag]', e && e.stack || e); process.exit(0); });
}
