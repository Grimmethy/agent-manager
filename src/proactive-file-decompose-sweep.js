'use strict';

// proactive-file-decompose-sweep.js (2026-09-14, screaminggoatclubmt: "how do we make
// [chipping away at an oversized file] a standard part of agent-manager hygiene so that
// when working on future projects it just automatically happens" -- confirmed live: this
// whole session's app.py work was ME picking the next slice, filing it, and waiting for a
// go-ahead every single time, with no waiting task ever forcing the issue).
//
// decompose-loop-autoroute.js's sweep already authors + files a moves[] plan for an
// oversized file -- but only REACTIVELY, when a task is already stuck against it
// (stalenessFlag.reason === 'decompose-loop'). A file that file-length-scan.js still
// flags but that nothing is currently blocked on (exactly app.py's state after a session
// of manually clearing its backlog) never gets touched -- there's no waiting task to
// react to, so the reactive sweep finds nothing to do every single tick, forever.
//
// This is the proactive counterpart: for any still-oversized file with no existing
// file-decompose-request/hub and no active task stuck on it, author + file a fresh plan
// the SAME way (same runFileDecomposePlanPass, same file-decompose-to-hub.js
// materialisation) with no waiting task required at all. Reuses everything
// decompose-loop-autoroute.js already built rather than reimplementing any of it -- the
// two sweeps differ only in what they iterate over and what happens to the (nonexistent,
// here) stuck task afterward.
//
// NO upfront hot-file skip here (2026-09-14 fix -- screaminggoatclubmt: "we need these
// things broken down into manageable chunks as we build them... why is that timer set to
// a week" -- found live: app.py's flask-blueprint plan is Tier-1-eligible, a single
// deterministic one-pass commit that can't go stale, but the old upfront check ran BEFORE
// a plan even existed, so it had no way to know that and blocked it for a full week
// anyway). file-decompose-to-hub.js's fileHub() now applies the hot-file check itself,
// AFTER every Tier-1 short-circuit has had its chance, so it only ever defers the
// multi-day Tier-2 hub case this guard actually exists for.
//
// Bounded to ONE new plan per run (MAX_FILES_PER_RUN) -- same "small, scoped, don't dump
// the whole backlog on the pipeline at once" discipline as this session's manual slicing.
//
// THROTTLE (2026-09-14, screaminggoatclubmt: "why not remove the max files per run
// altogether? ... make sure the process continues by spawning the next task after the
// task is finished, otherwise if the next task is only queued by the 24 hour scan").
// A flat daily quota was never tied to anything that actually mattered -- not worker
// capacity, not review throughput, not the risk of filing many attempts against a
// still-young mechanism at once. Replaced with a self-regulating cap on how many
// decompose-derived branches are currently APPLIED BUT NOT YET MERGED
// (countOutstandingDecomposeBranches), split Tier1 (fast, single atomic commit, safe --
// looser cap) vs Tier2 (multi-day per-move hub, worker-hungry -- stricter cap). Merging
// one frees a slot immediately: task-log-reconcile.js already stamps a task's `merged`
// history stage on EVERY watchdog tick (scripts/queue-watcher.sh's main loop runs every
// ORC_TICK_SECS, default 60s), so the very next tick after a merge sees the freed
// capacity -- no separate "on merge" event hook needed, just a short time floor
// (CHECK_INTERVAL_MS, now minutes not a day) so a full oversized-file scan + plan-pass
// attempt doesn't re-run on literally every 60s tick when there's nothing new to do.
// PLUS an on-demand --force flag for the "project just became the active target" trigger
// (see app.py's _start_pipeline, which spawns this in the background on every project
// switch/start) -- force bypasses the time floor but NOT the outstanding-branches cap.
//
// Kill switch: AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE=false.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { runFileDecomposePlanPass } = require('./file-decompose-plan-pass.js');
const { sweep: fileDecomposeToHubSweep } = require('./file-decompose-to-hub.js');
const { oversizedFiles } = require('./decompose-loop-autoroute.js');
const { listArchivedMonthDirs } = require('./done-archive.js');

// Was 24h -- now just a floor against re-scanning every single ~60s watchdog tick, not
// the thing standing between a merge and the next slice being filed (see THROTTLE above).
const CHECK_INTERVAL_MS = (() => {
  const v = process.env.AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE_INTERVAL_MS;
  return v === undefined ? 5 * 60 * 1000 : Number(v);
})();
const MAX_FILES_PER_RUN = 1;

// Outstanding-branches cap (see THROTTLE above). Tier1 = a single deterministic one-pass
// commit (script-extract/node-module/flask-blueprint short-circuit) -- fast, atomic,
// twice real-import-verified this session. Tier2 = the multi-day per-move hub -- each
// move is its own model-drafted, individually-reviewed task, competing with the rest of
// the pipeline for the same local-model worker lanes. Looser cap for the cheap tier,
// stricter for the expensive one.
const TIER1_CAP = (() => {
  const v = process.env.AGENT_MANAGER_DECOMPOSE_TIER1_CAP;
  return v === undefined ? 3 : Number(v);
})();
const TIER2_CAP = (() => {
  const v = process.env.AGENT_MANAGER_DECOMPOSE_TIER2_CAP;
  return v === undefined ? 1 : Number(v);
})();

function schedulePath(instancesDir) {
  return path.join(instancesDir, '.proactive-file-decompose-schedule.json');
}

function isDue(instancesDir, now = new Date()) {
  let schedule;
  try {
    schedule = JSON.parse(fs.readFileSync(schedulePath(instancesDir), 'utf8'));
  } catch {
    return true; // never run before -- due immediately.
  }
  const last = schedule.lastCheckedAt;
  if (!last) return true;
  return now.getTime() - new Date(last).getTime() >= CHECK_INTERVAL_MS;
}

function markChecked(instancesDir, now = new Date()) {
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(schedulePath(instancesDir), JSON.stringify({ lastCheckedAt: now.toISOString() }, null, 2));
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'x';
}

// True if ANY file-decompose-request (proactive, reactive, or hand-authored -- e.g. this
// session's own manually-filed ones) already targets this exact source file, whether or
// not it's been processed into a hub/one-pass task yet. One outstanding request per file
// at a time; a file with real content changes gets picked up again on a later run once
// its earlier split has actually merged and file-length-scan re-flags it (or doesn't).
//
// Real bug, caught live on this feature's own first production run (2026-09-14): app.py
// had EIGHT resolved requests already sitting in queue/file-decompose-requests/ (this
// session's own manual slices, each stamped hubId/onePassTaskId once processed) -- the
// original version of this check counted every one of them as still "outstanding" and
// would have skipped app.py FOREVER, since a file this large legitimately needs many
// successive requests over time, not just one. A request only actually blocks a NEW one
// for the same file while its linked hub/one-pass task hasn't reached a terminal state
// yet (queue/done/, whether that's a real completion or an operator dismiss/discard) --
// once it has, that slice is done and the file is free to be sliced again.
function isRequestResolved(pipelineDir, req) {
  const linkedId = req.onePassTaskId || req.hubId;
  if (!linkedId) return false; // never even processed by file-decompose-to-hub yet
  const candidates = [
    path.join(pipelineDir, 'queue', 'done', `${linkedId}.json`),
    path.join(pipelineDir, 'queue', 'done', '_archived_no_action', `${linkedId}.json`),
    // done-archive.js's routine sweep relocates old done/ tasks into dated done/_archived/
    // <YYYY-MM>/ buckets on its own retention schedule -- caught live 2026-09-14: two of
    // app.py's own resolved hubs (decompose-app-py-01, blueprints-2026-09-09) had already
    // aged into that bucket by the time this sweep's first forced run checked them, so they
    // still read as unresolved and kept blocking a fresh request. listArchivedMonthDirs is
    // the same helper task-anywhere.js/system-report.js already use to look past this
    // rolling cutoff, reused here instead of hand-duplicating the month-dir glob.
    ...listArchivedMonthDirs(pipelineDir).map((dir) => path.join(dir, `${linkedId}.json`)),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

function hasExistingRequestFor(pipelineDir, targetFile) {
  const reqDir = path.join(pipelineDir, 'queue', 'file-decompose-requests');
  let names;
  try { names = fs.readdirSync(reqDir).filter((n) => n.endsWith('.json')); } catch { return false; }
  for (const name of names) {
    const req = readJson(path.join(reqDir, name));
    if (req && req.sourceFile === targetFile && !isRequestResolved(pipelineDir, req)) return true;
  }
  return false;
}

// Counts decompose-derived tasks that are APPLIED (a real `agent/...` branch exists) but
// NOT YET MERGED, split Tier1/Tier2 -- see the THROTTLE header note. Works entirely off
// queue task records (the same `applied`/`merged` history stages task-log-reconcile.js
// already maintains every watchdog tick), not git branch-name parsing -- no branch-naming
// convention to keep in sync as file-decompose-to-hub.js's own conventions evolve.
//
// A task is decompose-derived if `promptContext.decomposedFrom` names either a plain
// file-decompose request (file-decompose-<slug>, the Tier1 one-pass shape) or a hub
// (file-decompose-hub-<slug>, the Tier2 per-move shape). A coordinator HUB record itself
// never has an `applied` history stage (it coordinates, it doesn't apply a diff), so it's
// naturally excluded without a separate check. Tier1 is identified by
// `promptContext.deterministicApply`, a field only fileOnePassTask ever sets.
//
// Caveat: the legacy STACKED Tier2 model (AGENT_MANAGER_DECOMPOSE_STACKED=legacy, opt-in
// only, not the live default) puts every move on ONE shared branch -- this would count
// each move task as its own outstanding branch, over-counting for that mode. Not fixed
// here since stacked mode isn't the active path; worth revisiting if that ever changes.
function countOutstandingDecomposeBranches(pipelineDir) {
  const counts = { tier1: 0, tier2: 0 };
  const dirs = ['pending', 'adhoc', 'drafting', 'review', 'approved', 'coordinating', 'done']
    .map((d) => path.join(pipelineDir, 'queue', d));
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      const rec = readJson(path.join(dir, name));
      if (!rec) continue;
      const decomposedFrom = rec.promptContext && rec.promptContext.decomposedFrom;
      if (!decomposedFrom || !/^file-decompose/.test(decomposedFrom)) continue;
      const history = rec.history || [];
      const applied = history.some((h) => h.stage === 'applied');
      const merged = !!rec.mergedAt || history.some((h) => h.stage === 'merged');
      if (!applied || merged) continue;
      const isTier1 = !!(rec.promptContext && rec.promptContext.deterministicApply);
      if (isTier1) counts.tier1 += 1; else counts.tier2 += 1;
    }
  }
  return counts;
}

async function sweep({ pipelineDir, repoRoot, call, force = false, now = Date.now() } = {}) {
  const summary = {
    checked: 0, filed: 0, deferred: 0, planFailed: 0, skipped: 0, errors: 0, due: false, capped: false,
  };
  if (process.env.AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE === 'false') return summary;

  let resolvedPipelineDir = pipelineDir;
  let resolvedRepoRoot = repoRoot;
  if (!resolvedPipelineDir || !resolvedRepoRoot) {
    try { ({ pipelineDir: resolvedPipelineDir, repoRoot: resolvedRepoRoot } = getConfig()); } catch { /* use whatever was passed */ }
  }
  if (!resolvedPipelineDir) return summary;

  const instancesDir = path.join(resolvedPipelineDir, 'instances');
  if (!force && !isDue(instancesDir, new Date(now))) return summary;
  summary.due = true;

  // Outstanding-branches cap (see THROTTLE above) -- force bypasses the time floor but
  // never this: filing more work while you already have unreviewed branches waiting
  // doesn't get anything merged faster, it just grows the backlog.
  const outstanding = countOutstandingDecomposeBranches(resolvedPipelineDir);
  summary.outstanding = outstanding;
  if (outstanding.tier1 >= TIER1_CAP && outstanding.tier2 >= TIER2_CAP) {
    summary.capped = true;
    markChecked(instancesDir, new Date(now));
    return summary;
  }

  const oversized = [...oversizedFiles(resolvedPipelineDir)];
  if (oversized.length === 0) {
    markChecked(instancesDir, new Date(now));
    return summary;
  }

  const reqDir = path.join(resolvedPipelineDir, 'queue', 'file-decompose-requests');
  let filedThisRun = 0;

  for (const targetFile of oversized) {
    if (filedThisRun >= MAX_FILES_PER_RUN) break;
    summary.checked += 1;

    if (hasExistingRequestFor(resolvedPipelineDir, targetFile)) { summary.skipped += 1; continue; }

    const requestId = `proactive-${slugify(targetFile)}-${new Date(now).toISOString().slice(0, 10)}`;
    try {
      const plan = await runFileDecomposePlanPass(targetFile, { repoRoot: resolvedRepoRoot, call, requestId });
      if (!plan || !plan.moves || plan.moves.length < 2) {
        summary.planFailed += 1;
        continue;
      }
      fs.mkdirSync(reqDir, { recursive: true });
      fs.writeFileSync(path.join(reqDir, `${requestId}.json`), `${JSON.stringify({
        ...plan,
        note: `Auto-authored by proactive-file-decompose-sweep (no waiting task -- ${targetFile} is still flagged oversized with nothing currently blocked on it). ${plan.planPassNote || ''}`,
      }, null, 2)}\n`);
      // Materialise the hub/one-pass task in this same run, matching decompose-loop-
      // autoroute.js's own reasoning (a request with no hub yet is invisible work). This
      // may DEFER rather than file (file-decompose-to-hub.js's own hot-file check on the
      // Tier-2 hub path -- see hot-file-guard.js) -- re-read the request to tell which.
      try { fileDecomposeToHubSweep({ pipelineDir: resolvedPipelineDir, repoRoot: resolvedRepoRoot, now }); } catch (e) {
        console.error(`[proactive-file-decompose-sweep] inline hub materialise failed for ${requestId}: ${e && e.message}`);
      }
      const written = readJson(path.join(reqDir, `${requestId}.json`)) || {};
      if (written.hubId || written.onePassTaskId) {
        summary.filed += 1;
        filedThisRun += 1;
      } else {
        summary.deferred += 1;
        // A deferred request still counts against MAX_FILES_PER_RUN -- don't spend the
        // rest of this tick's budget re-authoring plans for other files just because the
        // one we picked turned out to need the Tier-2 hub's own hot-file wait.
        filedThisRun += 1;
      }
    } catch (e) {
      console.error(`[proactive-file-decompose-sweep] ${targetFile}: ${e && e.message}`);
      summary.errors += 1;
    }
  }

  markChecked(instancesDir, new Date(now));
  return summary;
}

module.exports = {
  sweep, isDue, markChecked, hasExistingRequestFor, isRequestResolved, countOutstandingDecomposeBranches,
  CHECK_INTERVAL_MS, TIER1_CAP, TIER2_CAP,
};

if (require.main === module) {
  const { pipelineDir, repoRoot } = getConfig();
  let call;
  try { ({ call } = require('./local-client.js')); } catch { /* plan pass just won't run past Tier A */ }
  const force = process.argv.includes('--force');
  sweep({ pipelineDir, repoRoot, call, force })
    .then((s) => { console.log(`proactive-file-decompose-sweep: ${JSON.stringify(s)}`); process.exit(0); })
    .catch((e) => { console.error('[proactive-file-decompose-sweep]', (e && e.stack) || e); process.exit(0); });
}
