'use strict';

// Auto-confirm review sweep (2026-09-02). queue/awaiting-confirm/ used to be a pure human
// gate: a task that apply-task.js returned { needsConfirmation: true } for sat there until
// someone clicked Confirm (stamp a *ConfirmedAt field, back to queue/approved/ for a real
// re-run) or Deny (archive). Grimmethy: "If it's important to have a review gate, feed it
// to the review worker." -- so this sweep makes that call automatically.
//
// Two gates currently reach awaiting-confirm/ (see apply-task.js:296 and
// apply-group-a.js:applyForensicsReport):
//   1. a Group B batch containing a { mode: 'delete' } item  -> held before any git/disk op
//   2. a pipeline_forensics ranked root-cause report         -> held before its RECOMMENDED
//      FOLLOW-UP FIX is filed as an AC-NNN candidate in Docs/PIPELINE_FIX_CANDIDATES.md
//
// For each held task this sweep runs a small local majority vote (CONFIRM / DENY):
//   CONFIRM (confident)  -> stamp the gate's *ConfirmedAt + move to queue/approved/; the
//                           next apply tick re-runs it exactly as the human click would.
//   DENY    (confident)  -> archive to queue/done/_archived_no_action/ (the Deny button).
//   inconclusive         -> leave it here for a human (buttons still work); stamp
//                           autoConfirmReviewedAt so we don't re-burn votes every tick.
// All votes hard-failing (infra) is NOT stamped -- retried next tick.
//
// Cheap by construction: readdirSync of a usually-empty dir; only pays for LLM calls when
// something is actually held. Runs unconditionally on the watchdog tick, same discipline
// as coordinator-sweep.js / reject-retry-check.js. Kill switch:
// AGENT_MANAGER_AUTO_CONFIRM_REVIEW=false restores the pure-manual gate.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');
const { batchContainsDeleteMode } = require('./apply-group-b.js');
const { parseJsonMaybeFenced } = require('./json-fence.js');

const AUTO_CONFIRM_VOTES = Number(process.env.AGENT_MANAGER_AUTO_CONFIRM_VOTES) || 3;
const AUTO_CONFIRM_MIN_AGREEING = Number(process.env.AGENT_MANAGER_AUTO_CONFIRM_MIN_AGREEING) || 2;

// Same classify helper inline-duplicated in review-task.js:246 and local-client.js's CLI.
// Kept local here too (extracting the trio into src/classify-vote.js is a follow-up).
function classifyVote(markers, minReasoningChars) {
  return (text) => {
    const lower = text.toLowerCase();
    const marker = markers.find((m) => lower.includes(m.toLowerCase()));
    if (!marker) return null;
    if (minReasoningChars > 0) {
      const stripped = text.replace(new RegExp(`${marker}\\s*:?`, 'i'), '').trim();
      if (stripped.length < minReasoningChars) return null;
    }
    return marker;
  };
}

function clip(s, n) {
  const str = (s || '').toString();
  return str.length > n ? `${str.slice(0, n)}\n...[truncated ${str.length - n} chars]` : str;
}

// --- forensics gate -----------------------------------------------------------

function buildForensicsConfirmPrompt(task, candidatesDocText) {
  return [
    'You are the confirmation gate for a pipeline_forensics root-cause report.',
    'The report has ALREADY passed a review that judged it well-formed. Your ONLY decision',
    'now: should its RECOMMENDED FOLLOW-UP FIX be filed as an AC-NNN candidate in',
    'Docs/PIPELINE_FIX_CANDIDATES.md? Once filed, pipeline_forensics_fix turns it into a',
    'real code change to this pipeline.',
    '',
    `TITLE: ${task.title || '(none)'}`,
    '',
    'THE REPORT:',
    clip(task.implementResponse, 4500),
    '',
    'EXISTING FILED CANDIDATES (Docs/PIPELINE_FIX_CANDIDATES.md):',
    clip(candidatesDocText || '(doc is empty or missing)', 6000),
    '',
    'CONFIRM only if ALL of these hold:',
    '  - the RECOMMENDED FOLLOW-UP FIX names real src/ file(s) and a specific mechanism change,',
    '  - it states (or makes trivially checkable) an acceptance check,',
    '  - the ROOT CAUSE RANKING has at least one cause with a real counterfactual,',
    '  - it is NOT a restatement of a candidate already in the doc above (same mechanism /',
    '    same files / same signature = already covered).',
    'DENY if: the report is "NO CLEAR ROOT CAUSE"; or the fix restates an existing AC-NNN',
    '  candidate; or the fix is vague / not actionable; or it proposes re-attempting the',
    '  failed task or hand-building the feature instead of fixing the pipeline mechanism.',
    '',
    'If you genuinely cannot decide, do not force it -- a non-answer leaves it for a human.',
    'Answer with EXACTLY one line, nothing after it:',
    'CONFIRM: <one sentence why this fix is worth filing and not a duplicate>',
    'or',
    'DENY: <one sentence why not>',
  ].join('\n');
}

// --- delete gate ------------------------------------------------------------

function parseDeleteItems(implementResponse) {
  let parsed;
  try {
    parsed = parseJsonMaybeFenced(implementResponse);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.filter((i) => i && i.mode === 'delete' && typeof i.file === 'string');
}

// Deterministic reference scan: for each file being deleted, grep its repo-relative path
// and its basename-sans-extension across grepDirs, excluding the file itself. Returns a
// { file -> summary string } map fed into the prompt so the model isn't guessing.
function gatherDeleteReferences(repoRoot, grepDirs, deleteFiles) {
  const dirs = (grepDirs && grepDirs.length ? grepDirs : ['src', 'python', 'scripts', 'docs'])
    .filter((d) => {
      try { return fs.existsSync(path.join(repoRoot, d)); } catch { return false; }
    });
  const out = {};
  for (const rel of deleteFiles) {
    const base = path.basename(rel).replace(/\.[^.]+$/, '');
    const needles = [...new Set([rel, base].filter(Boolean))];
    const hits = [];
    for (const needle of needles) {
      if (!needle || needle.length < 3) continue;
      try {
        const raw = execFileSync(
          'grep',
          ['-rnI', '--fixed-strings', `--exclude=${path.basename(rel)}`, '--', needle, ...dirs],
          { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 20, timeout: 15000 },
        );
        for (const line of raw.split('\n')) {
          if (line.trim() && !line.startsWith(`${rel}:`)) hits.push(line.trim());
        }
      } catch (e) {
        // grep exits 1 with no output when there are zero matches -- that's the good case.
        if (e && e.stdout) {
          for (const line of e.stdout.toString().split('\n')) {
            if (line.trim() && !line.startsWith(`${rel}:`)) hits.push(line.trim());
          }
        }
      }
    }
    const uniq = [...new Set(hits)];
    out[rel] = uniq.length
      ? `${uniq.length} possible reference line(s):\n${uniq.slice(0, 25).join('\n')}`
      : 'no references found in ' + dirs.join(', ');
  }
  return out;
}

function buildDeleteConfirmPrompt(task, deleteItems, refMap) {
  const refBlock = deleteItems
    .map((i) => `--- ${i.file} ---\n${refMap[i.file] || '(not scanned)'}`)
    .join('\n\n');
  return [
    'You are the confirmation gate for an apply batch that will DELETE files from the repo',
    '(and commit + push the change to an agent/<id> branch). The batch has already been',
    'reviewed and approved as a whole; your ONLY decision is whether the DELETE(s) are safe',
    'and intended.',
    '',
    `TASK: ${task.title || '(none)'}`,
    '',
    'WHAT THE TASK ASKED FOR (plan):',
    clip(task.planResponse || task.lastGoodPlan || (task.promptContext && task.promptContext.rawText), 2500),
    '',
    'THE FULL BATCH (implement draft):',
    clip(task.implementResponse, 3000),
    '',
    `FILES TO DELETE: ${deleteItems.map((i) => i.file).join(', ')}`,
    '',
    'REFERENCE SCAN (grep across the code dirs, excluding each file itself):',
    refBlock,
    '',
    'CONFIRM only if: every file being deleted is clearly dead -- the reference scan is',
    '  empty, OR the remaining references are themselves removed/edited elsewhere in this',
    '  same batch -- AND the task plan actually calls for removing it.',
    'DENY if: any deleted file still has live references not handled in this batch; or it',
    '  looks like an incidental removal of a config/data/doc file the task did not ask to',
    '  delete; or the task never asked for a delete at all (the draft added it on its own).',
    '',
    'If you genuinely cannot tell whether the references are dead, do not force it.',
    'Answer with EXACTLY one line, nothing after it:',
    'CONFIRM: <one sentence: which files, why each is safe to remove>',
    'or',
    'DENY: <one sentence: which file and which live reference or reason>',
  ].join('\n');
}

// --- the sweep -------------------------------------------------------------

function readCandidatesDoc(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function moveTaskFile(srcFile, destDir, name, task) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, name);
  if (fs.existsSync(dest)) return false; // don't clobber
  fs.writeFileSync(dest, JSON.stringify(task, null, 2));
  fs.unlinkSync(srcFile);
  return true;
}

function voteReason(vote, marker) {
  const sample = (vote.votes || []).find((v) => v.verdict === marker);
  if (!sample) return `${marker} (votes: ${vote.realVoteCount}/${vote.requestedVotes})`;
  const m = sample.response.match(new RegExp(`${marker}:\\s*(.+)`, 'i'));
  return (m ? m[1] : sample.response).trim().slice(0, 300);
}

async function autoConfirmReview({ pipelineDir, repoRoot, grepDirs, majorityVote, candidatesPath }) {
  const summary = { checked: 0, confirmed: 0, denied: 0, escalated: 0, errors: 0 };
  if (process.env.AGENT_MANAGER_AUTO_CONFIRM_REVIEW === 'false') return summary;

  const dir = path.join(pipelineDir, 'queue', 'awaiting-confirm');
  const approvedDir = path.join(pipelineDir, 'queue', 'approved');
  const archiveDir = path.join(pipelineDir, 'queue', 'done', '_archived_no_action');
  const fixCandidatesPath = candidatesPath || (getConfig().pipelineFixCandidatesPath);

  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return summary; // no awaiting-confirm/ dir -- nothing to do
  }

  for (const name of names) {
    const file = path.join(dir, name);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue;
    }
    if (task.autoConfirmReviewedAt) continue; // already reviewed once -- left for a human

    summary.checked += 1;
    const isForensics = task.source === 'pipeline_forensics';
    const deleteItems = isForensics ? [] : parseDeleteItems(task.implementResponse);

    let prompt;
    let gateStamp;
    if (isForensics) {
      prompt = buildForensicsConfirmPrompt(task, readCandidatesDoc(fixCandidatesPath));
      gateStamp = 'forensicsReportConfirmedAt';
    } else if (deleteItems.length && batchContainsDeleteMode(task.implementResponse)) {
      const refMap = gatherDeleteReferences(repoRoot, grepDirs, deleteItems.map((i) => i.file));
      prompt = buildDeleteConfirmPrompt(task, deleteItems, refMap);
      gateStamp = 'deleteConfirmedAt';
    } else {
      // A hold we don't recognise -- don't guess. Leave it for a human, but stamp so we
      // don't re-check every tick.
      task.autoConfirmReviewedAt = new Date().toISOString();
      task.autoConfirmDecision = 'escalate';
      task.autoConfirmReviewNote = 'auto-confirm review does not recognise this hold type -- left for a human';
      appendHistoryEvent(task, 'advisory', task.autoConfirmReviewNote);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); summary.escalated += 1; }
      catch { summary.errors += 1; }
      continue;
    }

    let vote;
    try {
      vote = await majorityVote({
        prompt,
        classify: classifyVote(['CONFIRM', 'DENY'], 15),
        n: AUTO_CONFIRM_VOTES,
        minAgreeing: AUTO_CONFIRM_MIN_AGREEING,
        temperature: 0.2,
        source: task.source,
      });
    } catch (e) {
      // Every vote hard-failed (infra). Do NOT stamp -- next tick retries.
      appendHistoryEvent(task, 'advisory', `auto-confirm review could not run (${(e && e.message || 'vote error').slice(0, 160)}) -- will retry`);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); } catch { /* best-effort */ }
      summary.errors += 1;
      continue;
    }

    const now = new Date().toISOString();
    if (vote.confident && vote.verdict === 'CONFIRM') {
      const reason = voteReason(vote, 'CONFIRM');
      task[gateStamp] = now; // 'forensicsReportConfirmedAt' or 'deleteConfirmedAt' -- the field apply-task.js's gate checks
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'confirm';
      task.autoConfirmReviewNote = reason;
      task.status = 'approved';
      appendHistoryEvent(task, 'approved', `auto-confirmed (votes: ${vote.realVoteCount}/${vote.requestedVotes}): ${reason}`);
      try {
        if (moveTaskFile(file, approvedDir, name, task)) summary.confirmed += 1;
        else summary.errors += 1;
      } catch { summary.errors += 1; }
    } else if (vote.confident && vote.verdict === 'DENY') {
      const reason = voteReason(vote, 'DENY');
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'deny';
      task.autoConfirmReviewNote = reason;
      task.status = 'done';
      task.doneMarker = `auto-denied at confirm gate: ${reason}`;
      appendHistoryEvent(task, 'archived', `auto-denied (votes: ${vote.realVoteCount}/${vote.requestedVotes}): ${reason}`);
      try {
        if (moveTaskFile(file, archiveDir, name, task)) summary.denied += 1;
        else summary.errors += 1;
      } catch { summary.errors += 1; }
    } else {
      // No confident majority -- leave for a human.
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'escalate';
      task.autoConfirmReviewNote = `no confident CONFIRM/DENY majority (votes: ${vote.realVoteCount}/${vote.requestedVotes})`;
      appendHistoryEvent(task, 'advisory', `auto-confirm review inconclusive (${task.autoConfirmReviewNote}) -- held for a human`);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); summary.escalated += 1; }
      catch { summary.errors += 1; }
    }
  }

  return summary;
}

module.exports = {
  autoConfirmReview,
  classifyVote,
  buildForensicsConfirmPrompt,
  buildDeleteConfirmPrompt,
  parseDeleteItems,
  gatherDeleteReferences,
};

if (require.main === module) {
  const cfg = getConfig();
  const { majorityVote } = require('./local-client.js');
  const grepDirs = (process.env.AGENT_MANAGER_GREP_DIRS || 'src,python,scripts,docs')
    .split(',').map((s) => s.trim()).filter(Boolean);
  Promise.resolve(autoConfirmReview({
    pipelineDir: cfg.pipelineDir,
    repoRoot: cfg.repoRoot,
    grepDirs,
    majorityVote,
    candidatesPath: cfg.pipelineFixCandidatesPath,
  }))
    .then((s) => process.stdout.write(JSON.stringify(s)))
    .catch((e) => { process.stderr.write(`auto-confirm-review failed: ${e && e.stack || e}\n`); process.exit(1); });
}
