'use strict';

// Context-trim sweep (2026-09-05, Grimmethy: "I'd like to plan a task that automatically
// goes through stalled or blocked tasks for whatever reason and trims the context down.")
//
// observability-fix-ac-111 (54KB blocked task) surfaced a real, reproducible failure
// class shared by every candidate-fulfillment-style source (observability_fix,
// performance_fix, function_length_fix, arch_review, arch_import_review,
// change_review_fix, backlog_fulfillment, pipeline_forensics_fix): a task's grounding
// (promptContext.fetchedFiles) is a snapshot taken ONCE at candidate-creation time. If the
// real file has since moved -- the frozen Snippet no longer matches, or the candidate's
// quoted symbols have become too common (or vanished) -- every retry re-anchors against
// the exact same stale, noisy window and reproduces the exact same rejection forever. The
// generation-time fix (src/sdk/candidate-fulfillment.js, 2026-09-05) stops NEW tasks from
// accumulating this way; this sweep re-anchors already-blocked tasks against CURRENT file
// content and requeues them when that measurably helps.
//
// Runs every watchdog tick over queue/blocked/ only (see CANDIDATE_FULFILLMENT_SOURCES).
// Never votes -- "did re-anchoring change anything measurable" is a mechanical comparison,
// not a judgment call (contrast adhoc-staleness-flag.js's medium-confidence bucket, which
// DOES vote because "is this task actually dead" genuinely is one). Kill switch:
// AGENT_MANAGER_CONTEXT_TRIM_SWEEP=false.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');
const { windowFetchedFileContent } = require('./sdk/candidate-fulfillment.js');
const { isCandidateFulfillmentSource } = require('./local-draft.js');

const FLAG_TTL_MS = Number(process.env.AGENT_MANAGER_CONTEXT_TRIM_SWEEP_FLAG_TTL_DAYS || 3) * 24 * 60 * 60 * 1000;
const KEEP_COOLDOWN_MS = Number(process.env.AGENT_MANAGER_CONTEXT_TRIM_SWEEP_KEEP_COOLDOWN_DAYS || 21) * 24 * 60 * 60 * 1000;
const MAX_REQUEUES = Number(process.env.AGENT_MANAGER_CONTEXT_TRIM_SWEEP_MAX_REQUEUES) || 2;

// A material content delta at the SAME confidence tier -- the real file may have simply
// moved (AC-111's own `_reports_root()` no longer existing is exactly this) even when the
// anchor mechanism didn't change tier. Ships as a documented placeholder threshold, not a
// tuned constant -- cheap to retune later against more real data than exists today.
const MATERIAL_DELTA_RATIO = 0.05;

const CONFIDENCE_RANK = { none: 0, weak: 1, strong: 2 };

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listBlockedTasks(pipelineDir) {
  const dir = path.join(pipelineDir, 'queue', 'blocked');
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    const task = readJson(filePath);
    if (task && task.id) out.push({ task, filePath });
  }
  return out;
}

function existingFlagIsFresh(task, now) {
  const f = task.contextTrimFlag;
  if (!f) return false;
  const t = Date.parse(f.flaggedAt || '');
  return Number.isFinite(t) && now - t < FLAG_TTL_MS;
}

function keepCooldownActive(task, now) {
  const k = task.contextTrimKeep;
  if (!k) return false;
  const until = Date.parse(k.until || '');
  return Number.isFinite(until) && until > now;
}

// A stronger, more final verdict from the sibling sweep ("this work doesn't need doing at
// all") shouldn't be simultaneously re-anchored by this sweep in the same tick.
function hasFreshRetireFlag(task, now) {
  const f = task.stalenessFlag;
  if (!f || f.disposition !== 'retire') return false;
  const t = Date.parse(f.flaggedAt || '');
  return Number.isFinite(t) && now - t < FLAG_TTL_MS;
}

function writeFlag(filePath, task, evidence, confidence, now) {
  task.contextTrimFlag = {
    reason: 'stale-grounding-unrecoverable',
    disposition: 'needs-human-regrounding',
    confidence,
    evidence,
    flaggedAt: new Date(now).toISOString(),
    votedAt: null,
    voteResult: null,
  };
  appendHistoryEvent(task, 'advisory',
    `context-trim flag: stale-grounding-unrecoverable (${confidence}) -- ${evidence[0] || ''}`.slice(0, 400));
  fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
}

// Re-reads one declared file off disk and re-windows it against the task's own candidate
// body. Best-effort: a deleted/moved file is not an error here, just "no change possible."
function reAnchorFile(repoRoot, fetched, body) {
  if (!fetched || !fetched.path) return null;
  try {
    const full = path.resolve(repoRoot, fetched.path);
    if (full !== path.resolve(repoRoot) && !full.startsWith(path.resolve(repoRoot) + path.sep)) return null;
    const content = fs.readFileSync(full, 'utf8');
    const windowed = windowFetchedFileContent(content, body);
    return { fetched, windowed };
  } catch {
    return null;
  }
}

// Compares OLD vs NEW anchoring for one file, in priority order: (a) a Snippet
// fuzzy-match flip -- the strongest staleness signal; (b) confidence tier improved;
// (c) a material content delta even at the same tier (the file simply moved).
function describeImprovement(oldEntry, windowed) {
  const oldUsedFuzzy = !!oldEntry.usedSnippetFuzzyMatch;
  const newUsedFuzzy = windowed.usedSnippetFuzzyMatch;
  if (oldUsedFuzzy !== newUsedFuzzy) {
    return `Snippet fuzzy-match ${oldUsedFuzzy}->${newUsedFuzzy} for ${oldEntry.path}`;
  }

  const oldConfidence = oldEntry.anchorConfidence || 'none';
  const oldRank = CONFIDENCE_RANK[oldConfidence] ?? 0;
  const newRank = CONFIDENCE_RANK[windowed.confidence] ?? 0;
  if (newRank > oldRank) {
    return `anchor confidence ${oldConfidence}->${windowed.confidence} for ${oldEntry.path}`;
  }

  const oldLen = (oldEntry.content || '').length;
  const newLen = (windowed.text || '').length;
  const base = Math.max(oldLen, newLen, 1);
  if (Math.abs(newLen - oldLen) / base >= MATERIAL_DELTA_RATIO) {
    return `re-anchored window changed materially (${oldLen}->${newLen} chars) for ${oldEntry.path}`;
  }

  return null;
}

// product_spec_section is registered candidateFulfillment:true (shares the same reader)
// but its "file" is a spec-outline doc, not application code -- a stale-grounding flag
// phrased around "code anchors" wouldn't read sensibly there. Left out of v1; revisit only
// if spec-outline tasks are actually observed getting stuck this way.
const EXCLUDED_SOURCES = new Set(['product_spec_section']);

function isSweepEligible(task) {
  return isCandidateFulfillmentSource(task.source) && !EXCLUDED_SOURCES.has(task.source);
}

async function sweep({ pipelineDir, repoRoot, dryRun = false, now = Date.now() }) {
  const summary = { scanned: 0, requeued: 0, flagged: 0, skipped: 0, errors: 0, wouldRequeue: [], wouldFlag: [] };
  if (process.env.AGENT_MANAGER_CONTEXT_TRIM_SWEEP === 'false') return summary;

  const blocked = listBlockedTasks(pipelineDir).filter(({ task }) => isSweepEligible(task));
  summary.scanned = blocked.length;
  if (blocked.length === 0) return summary;

  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  const nowIso = new Date(now).toISOString();

  for (const { task, filePath } of blocked) {
    try {
      if (keepCooldownActive(task, now)) { summary.skipped += 1; continue; }
      if (hasFreshRetireFlag(task, now)) { summary.skipped += 1; continue; }
      if (existingFlagIsFresh(task, now)) { summary.skipped += 1; continue; }

      const pc = task.promptContext || {};
      const body = pc.body || '';
      const declared = (pc.fetchedFiles || []).filter((f) => f && !f.context);
      if (declared.length === 0) { summary.skipped += 1; continue; }

      const improvements = [];
      const newFetchedByPath = new Map();
      let anyStrong = false;
      for (const entry of declared) {
        const result = reAnchorFile(repoRoot, entry, body);
        if (!result) continue;
        const { windowed } = result;
        if (windowed.confidence === 'strong') anyStrong = true;
        newFetchedByPath.set(entry.path, windowed);
        const improvement = describeImprovement(entry, windowed);
        if (improvement) improvements.push(improvement);
      }

      const attempts = Number(task.contextTrimAttempts || 0);
      if (improvements.length === 0) {
        if (dryRun) {
          summary.wouldFlag.push({ id: task.id, reason: 'no measurable improvement from re-anchoring' });
          summary.flagged += 1;
          continue;
        }
        writeFlag(filePath, task, ['re-anchoring against current file content found no measurable change'],
          anyStrong ? 'weak' : 'none', now);
        summary.flagged += 1;
        continue;
      }

      if (attempts >= MAX_REQUEUES) {
        if (dryRun) {
          summary.wouldFlag.push({ id: task.id, reason: `attempt cap reached (${attempts}/${MAX_REQUEUES})`, improvements });
          summary.flagged += 1;
          continue;
        }
        writeFlag(filePath, task,
          [`re-anchoring keeps changing but never resolves (attempt cap ${MAX_REQUEUES} reached)`, ...improvements],
          'weak', now);
        summary.flagged += 1;
        continue;
      }

      if (dryRun) {
        summary.wouldRequeue.push({ id: task.id, improvements, attempt: attempts + 1 });
        summary.requeued += 1;
        continue;
      }

      const refreshedFetchedFiles = (pc.fetchedFiles || []).map((f) => {
        if (!f || !f.path || !newFetchedByPath.has(f.path)) return f;
        const windowed = newFetchedByPath.get(f.path);
        return { ...f, content: windowed.text, anchorConfidence: windowed.confidence };
      });

      const fresh = {
        id: task.id,
        domain: task.domain,
        source: task.source,
        title: task.title,
        promptContext: { ...pc, fetchedFiles: refreshedFetchedFiles },
        contextTrimAttempts: attempts + 1,
        status: 'pending',
        createdAt: nowIso,
        history: [{
          status: 'pending', at: nowIso,
          note: `auto-requeued by context-trim-sweep: ${improvements.join('; ')} -- attempt ${attempts + 1}/${MAX_REQUEUES}`,
        }],
      };

      const destPath = path.join(pendingDir, path.basename(filePath));
      if (fs.existsSync(destPath)) { summary.skipped += 1; continue; }

      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(destPath, JSON.stringify(fresh, null, 2));
      fs.unlinkSync(filePath);
      summary.requeued += 1;
    } catch (e) {
      console.error(`[context-trim-sweep] ${task.id}: ${e && e.message}`);
      summary.errors += 1;
    }
  }

  return summary;
}

module.exports = { sweep, FLAG_TTL_MS, KEEP_COOLDOWN_MS, MAX_REQUEUES };

// --- CLI --------------------------------------------------------------------------
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const { pipelineDir, repoRoot } = getConfig();
  sweep({ pipelineDir, repoRoot, dryRun })
    .then((s) => {
      if (dryRun) {
        for (const w of s.wouldRequeue) {
          console.log(`\n[requeue] ${w.id} (attempt ${w.attempt})`);
          for (const imp of w.improvements) console.log(`  - ${imp}`);
        }
        for (const w of s.wouldFlag) {
          console.log(`\n[flag] ${w.id} -- ${w.reason}`);
          for (const imp of w.improvements || []) console.log(`  - ${imp}`);
        }
        console.log(`\nwould requeue ${s.requeued}, would flag ${s.flagged} / scanned ${s.scanned}`);
      } else {
        console.log(`context-trim-sweep: scanned=${s.scanned} requeued=${s.requeued} flagged=${s.flagged} skipped=${s.skipped} errors=${s.errors}`);
      }
      process.exit(0);
    })
    .catch((e) => { console.error('[context-trim-sweep]', e && e.stack || e); process.exit(0); });
}
