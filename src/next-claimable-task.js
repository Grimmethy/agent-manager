'use strict';

const fs = require('fs');
const path = require('path');

// Extracted from scripts/local-worker.sh's inline claim-ranking script (the 2026-08-22
// priority+mtime fix) plus its separate per-item reasoningTierFor() filter -- both now
// live in one tested module instead of two untested `node -e` blocks in the shell
// script. See local-worker.sh's own comments for why priority+mtime ordering and the
// tier split exist; this module adds the operator "assign this task to this worker"
// override on top (2026-09-06, Grimmethy: "I need to be able to select the task I want
// each worker to run... this should override the automated system").
//
// `pinnedWorker` on a pending task's JSON, when present, is an explicit operator
// assignment (stamped by the dashboard's POST /api/instances/<id>/assign-task route):
// a task pinned to THIS instance always wins, skipping the tier filter and priority
// sort entirely (that's the override); a task pinned to ANY OTHER instance is excluded
// from this instance's candidate list so a faster-polling lane can't steal it first.
//
// listAssignableTasks() (2026-09-07, Grimmethy after live-testing the above: "the only
// tasks I have access to... are pipeline debrief tasks. The task I want, autodecomp, is
// in drafting. I need access to the full list of available jobs, they should however be
// whats available for that specific worker type") backs the Workers tab's assign-task
// dropdown: pending/ alone is too narrow a candidate pool -- the task an operator wants
// to reassign is usually already claimed by some other lane -- so this also surfaces
// every OTHER lane's queue/drafting/ contents, tier-filtered the same way.

// Bot-vs-human adhoc sub-prioritization + the persistent "premium priority" pin
// (2026-09-07, Grimmethy: "Adhoc has bloomed immensely because of the brain dump entries
// being fed tangentially. It's lost its effectiveness as a sorting mechanism. We need to
// make sure that tasks that come from bot findings get sorted into a lower priority than
// human entered adhoc tasks... I'll need a way in app to be able to set that premium
// priority slot for any specific task. I am getting tired of manually selecting it for
// the worker queue every pass.").
//
// Root cause of the first half: EVERY task filed under queue/adhoc/ -- a human running
// queue-adhoc-task.js, a human clicking Brain Dump's "Process this now", brain_dump_sort's
// own fully-autonomous actionable-classification, file-decompose-to-hub.js's move
// children, product-spec-to-hub.js's section children, decompose-loop-autoroute.js's
// re-routed children -- all resolve to the SAME registered source name ('adhoc',
// task-source-registry.js's resolveSourceName()) and therefore the SAME static priority
// number (10, currently tied for the best in the whole registry). task-sources.js's own
// nextAdhocTask() loader force-overrides id/domain/source/title on every file it reads
// from queue/adhoc/ -- including whatever `source` a bot writer originally stamped
// (confirmed live: a file-decompose move child and an apply-group-a.js brain-dump-spawned
// task both come back source:'manual' regardless of what they were written with) -- so by
// the time a task reaches claim-ranking, there is no live signal left to tell a human's
// explicit ask apart from a bot's autonomous output. `humanQueued: true` is a NEW,
// top-level, opt-IN field stamped ONLY by the two genuinely human-initiated adhoc entry
// points (queue-adhoc-task.js's queueAdhocTask(), and app.py's api_brain_dump_prioritize
// -- a human clicking "Process this now" on a captured note, as opposed to
// brain_dump_sort's own automatic actionable-classification queueing the identical shape
// with no human decision about THIS specific task) -- everything else defaults to
// bot-originated without needing to name every current or future bot source. It survives
// every requeue path checked live (task-sources.js's nextAdhocTask spread, the
// needs-clarification /resolve route, reject-retry-check.js) because none of them strip
// unrecognized top-level fields.
//
// `premiumPriority: true` is a second, independent, OPERATOR-SET field (new
// POST /api/task-anywhere/<id>/premium-priority route) -- always sorts a task ahead of
// EVERY other task regardless of source or the bot/human split above, and (unlike
// pinnedWorker, which local-draft.js deletes the instant a task is claimed -- a
// deliberate one-shot override) is never auto-cleared, so it survives every retry/
// requeue cycle until the operator turns it off or the task reaches a terminal state and
// stops being read by this ranking at all. This is what actually closes "I am getting
// tired of manually selecting it every pass" -- pinnedWorker still exists for "run THIS
// on THAT specific lane right now"; premiumPriority is for "keep this at the front of
// the queue no matter which lane gets to it next, for as long as it takes."
//
// Shared by pickClaimableTasks and listAssignableTasks so the two can never disagree --
// same discipline this file's own resolvesToTier() header already documents for the tier
// split, and the exact class of bug the "ghost in the machine" concept's own
// standing-mechanism-vs-one-time-check lesson (AGENTS.md) warns to watch for: a rule that
// only ever gets applied in ONE of two places that are supposed to agree.
const BOT_ADHOC_PRIORITY_PENALTY = 30; // 10 -> 40, landing alongside brain_dump_sort (42) / secondbrain (40) -- thematically apt, since most bot-adhoc IS brain_dump_sort's own continued output
function effectivePriority(task, basePriority, resolveSourceNameFn) {
  if (task && task.premiumPriority) return -Infinity;
  if (task && resolveSourceNameFn(task) === 'adhoc' && !task.humanQueued) return basePriority + BOT_ADHOC_PRIORITY_PENALTY;
  return basePriority;
}

function readTaskSafe(fullPath) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch (_) { /* file vanished mid-scan */ }
  let task = null;
  try { task = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch (_) { /* corrupt/partial write -- still listed, worst priority, matching prior behavior */ }
  return { task, mtimeMs };
}

// Shared by pickClaimableTasks (claim ranking) and listAssignableTasks (the operator's
// "what could I assign here" dropdown) so the two can never disagree about which tasks
// belong on a given lane -- both must ask model-provider.js's reasoningTierFor(), never
// re-derive tier some other way. Requires task-sources.js itself (not just
// model-provider.js) -- registerTaskSource() calls populate task-source-registry.js's
// registry as a load-time side effect that reasoningTierFor() depends on to resolve a
// source's registered tier; skipping this require silently defaults every task to 'low'
// (confirmed live 2026-09-07: listAssignableTasks originally omitted this and inverted
// every tier filter as a result -- caught by testing against the real queue before
// shipping, not by the unit tests, which mock the registry away).
function resolvesToTier(task, isReasoningLane) {
  require('./task-sources.js');
  const { reasoningTierFor } = require('./model-provider.js');
  let tier = 'low';
  if (task) {
    try { tier = reasoningTierFor(task); } catch (_) { /* default 'low' */ }
  }
  return isReasoningLane ? tier === 'high' : tier !== 'high';
}

// Returns every filename in pendingDir this instance may claim, in claim-attempt order:
// tasks pinned to this instance first (oldest first), then everything else ranked by
// resolved source priority ascending, then mtime ascending. The caller
// (local-worker.sh) iterates this list attempting an atomic claim (mv -n) on each in
// turn, same as it did with the old inline script's output.
function pickClaimableTasks(pendingDir, instanceId, { isReasoningLane = false } = {}) {
  let names;
  try {
    names = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return [];
  }

  // Side-effect requires: task-sources.js's registerTaskSource() calls populate
  // task-source-registry.js's registry as a load-time side effect -- must be required
  // before getRegisteredSource() can resolve anything (see local-worker.sh's own
  // comment on this same gotcha, confirmed live 2026-08-17: requiring model-provider.js
  // alone reported every source as 'low' every time).
  require('./task-sources.js');
  const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');

  const pinned = [];
  const rankable = [];
  for (const name of names) {
    const { task, mtimeMs } = readTaskSafe(path.join(pendingDir, name));
    const pinnedWorker = task && task.pinnedWorker;
    if (pinnedWorker && pinnedWorker !== instanceId) continue; // pinned to another instance -- not a candidate for this one
    if (pinnedWorker === instanceId) {
      pinned.push({ name, mtimeMs });
      continue;
    }

    let priority = Infinity;
    if (task) {
      try {
        // A derived_task carries domain:'adhoc' (so every draft/apply path treats it
        // exactly like adhoc -- resolveSourceName() sends it there), but it must RANK at
        // its own registered priority (48, self-maintenance band), never adhoc's base 10
        // + BOT_ADHOC_PRIORITY_PENALTY. Look it up by its literal source name.
        if (task.source === 'derived_task') {
          const dt = getRegisteredSource('derived_task');
          priority = (dt && typeof dt.priority === 'number') ? dt.priority : Infinity;
        } else {
          const source = getRegisteredSource(resolveSourceName(task));
          if (source && typeof source.priority === 'number') priority = effectivePriority(task, source.priority, resolveSourceName);
        }
      } catch (_) { /* unresolvable -- Infinity priority, sorts last, still listed */ }
    }
    if (!resolvesToTier(task, isReasoningLane)) continue;
    rankable.push({ name, priority, mtimeMs });
  }

  pinned.sort((a, b) => a.mtimeMs - b.mtimeMs);
  rankable.sort((a, b) => (a.priority - b.priority) || (a.mtimeMs - b.mtimeMs));
  return [...pinned.map((r) => r.name), ...rankable.map((r) => r.name)];
}

// Single-winner convenience form. local-worker.sh itself uses pickClaimableTasks()
// directly (it claims as many pending items as fit in one tick, not just one); this
// exists for callers/tests that only care about "what would this instance claim next."
function pickNextPendingTask(pendingDir, instanceId, opts) {
  const [first] = pickClaimableTasks(pendingDir, instanceId, opts);
  return first || null;
}

// The Workers tab's "assign a task to this worker" dropdown (2026-09-06/07, Grimmethy:
// "I need access to the full list of available jobs, they should however be whats
// available for that specific worker type"). pickClaimableTasks() alone isn't enough for
// this: it only looks at queue/pending/, but the task an operator actually wants to
// reassign is usually already claimed -- sitting in some OTHER lane's
// queue/drafting/<lane>/ (either actively running there, or just queued as that lane's
// own backlog; local-worker.sh processes several leftover drafting items per tick before
// claiming anything new). This lists BOTH: pending/ candidates (same tier filter
// pickClaimableTasks applies) plus every OTHER lane's drafting/ contents (never this
// instance's own -- reassigning a task to the lane already running it is a pure no-op
// the assign route already short-circuits, no point cluttering the list with it), each
// tagged with `location` so the dashboard can label a stolen in-flight task distinctly
// from idle pending work.
function listAssignableTasks(queueDir, instanceId, { isReasoningLane = false } = {}) {
  const out = [];

  const pendingDir = path.join(queueDir, 'pending');
  let pendingNames = [];
  try {
    pendingNames = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json'));
  } catch (_) { /* no pending/ dir yet */ }
  for (const name of pendingNames) {
    const { task } = readTaskSafe(path.join(pendingDir, name));
    if (!task) continue;
    // 2026-09-07, Grimmethy after finding the SAME task in worker-reasoning's list but
    // not worker-reasoning-p40's: "why do the 2 reasoning workers have different lists?
    // they really should share the same task list." A pin to one lane used to EXCLUDE a
    // task from every sibling lane's browsing list entirely -- correct for
    // pickClaimableTasks() (the real claim loop, where excluding it prevents a second
    // lane racing to steal it away from the one it's pinned to), wrong here: an operator
    // browsing worker-reasoning-p40's dropdown has no way to even discover a task that's
    // currently pinned to worker-reasoning, even though picking it here is a completely
    // legitimate "actually, reassign it to THIS lane instead" action the assign-task
    // route already supports (it just re-pins). List it for every tier-matching lane
    // either way; only tag it (pinnedTo) so the dashboard can show which lane currently
    // has first claim on it, same spirit as the drafting-elsewhere `location` tag below.
    if (!resolvesToTier(task, isReasoningLane)) continue;
    out.push({
      id: task.id || name.replace(/\.json$/, ''),
      title: task.title || null,
      source: task.source || null,
      location: 'pending',
      pinnedTo: (task.pinnedWorker && task.pinnedWorker !== instanceId) ? task.pinnedWorker : null,
      premiumPriority: !!task.premiumPriority,
    });
  }

  const draftingDir = path.join(queueDir, 'drafting');
  let lanes = [];
  try {
    lanes = fs.readdirSync(draftingDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== instanceId)
      .map((e) => e.name);
  } catch (_) { /* no drafting/ dir yet */ }
  for (const lane of lanes) {
    const laneDir = path.join(draftingDir, lane);
    let names = [];
    try {
      names = fs.readdirSync(laneDir).filter((f) => f.endsWith('.json'));
    } catch (_) { continue; }
    for (const name of names) {
      const { task } = readTaskSafe(path.join(laneDir, name));
      if (!task) continue;
      if (!resolvesToTier(task, isReasoningLane)) continue;
      out.push({
        id: task.id || name.replace(/\.json$/, ''),
        title: task.title || null,
        source: task.source || null,
        location: `drafting:${lane}`,
        premiumPriority: !!task.premiumPriority,
      });
    }
  }

  // queue/adhoc/ (2026-09-08, Grimmethy: "I also can't see the target when I try to
  // select it in the workers task select field" -- root-caused live: this function only
  // ever scanned pending/ and other lanes' drafting/, never adhoc/ itself, even though
  // adhoc/ is the single highest-volume holding pen in the whole pipeline (task-sources.js's
  // nextAdhocTask() reads a candidate from here on demand rather than a file ever being
  // written into pending/ for it) -- so nothing living there could ever show up in the
  // assign-task dropdown, decompose children included. Same tier filter, same shape as the
  // pending/ block above; sorted premiumPriority-first to match nextAdhocTask()'s own
  // now-fixed sort so the dropdown's ordering doesn't silently disagree with what the
  // automatic claim path would actually pick next.
  const adhocDir = path.join(queueDir, 'adhoc');
  let adhocNames = [];
  try {
    adhocNames = fs.readdirSync(adhocDir).filter((f) => f.endsWith('.json'));
  } catch (_) { /* no adhoc/ dir yet */ }
  const adhocRows = [];
  for (const name of adhocNames) {
    const { task } = readTaskSafe(path.join(adhocDir, name));
    if (!task) continue;
    if (!resolvesToTier(task, isReasoningLane)) continue;
    adhocRows.push({
      id: task.id || name.replace(/\.json$/, ''),
      title: task.title || null,
      source: task.source || null,
      location: 'adhoc',
      pinnedTo: (task.pinnedWorker && task.pinnedWorker !== instanceId) ? task.pinnedWorker : null,
      premiumPriority: !!task.premiumPriority,
    });
  }
  adhocRows.sort((a, b) => (a.premiumPriority === b.premiumPriority ? 0 : (a.premiumPriority ? -1 : 1)));
  out.push(...adhocRows);

  return out;
}

module.exports = { pickClaimableTasks, pickNextPendingTask, listAssignableTasks, effectivePriority, BOT_ADHOC_PRIORITY_PENALTY };

// --- CLI --------------------------------------------------------------------------
// Two modes:
//
//   node next-claimable-task.js <pendingDir> <instanceId> <isReasoningLane:true|false>
//     Prints one claimable filename per line, in claim-attempt order (same contract the
//     removed inline `node -e` script had) -- local-worker.sh consumes this via
//     `while IFS= read -r name; do items+=("$name"); done < <(node ...)`.
//
//   node next-claimable-task.js --list-assignable <queueDir> <instanceId> <isReasoningLane:true|false>
//     Prints a single JSON array of {id, title, source, location} to stdout -- the
//     dashboard (python/dashboard/app.py's GET /api/instances/<id>/assignable-tasks)
//     shells out to this exactly the way it already shells out to
//     scripts/gpu-arbiter-cli.js for gpu-arbiter.js logic, so tier resolution can never
//     drift between the two languages.
if (require.main === module) {
  if (process.argv[2] === '--list-assignable') {
    const [queueDir, instanceId, isReasoningLaneArg] = process.argv.slice(3);
    try {
      const items = listAssignableTasks(queueDir, instanceId, { isReasoningLane: isReasoningLaneArg === 'true' });
      process.stdout.write(JSON.stringify(items));
    } catch (e) {
      process.stderr.write(`next-claimable-task --list-assignable: ${e.message}\n`);
      process.stdout.write('[]');
    }
  } else {
    const [pendingDir, instanceId, isReasoningLaneArg] = process.argv.slice(2);
    try {
      const items = pickClaimableTasks(pendingDir, instanceId, { isReasoningLane: isReasoningLaneArg === 'true' });
      for (const name of items) console.log(name);
    } catch (e) {
      // Best-effort, matching the removed inline script's own catch-and-fall-through --
      // caller already handles an empty listing safely.
    }
  }
}
