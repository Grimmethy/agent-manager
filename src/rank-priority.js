'use strict';

// The rank priority of one task, with the registry already loaded (roadmap step 1, piece P4). Moved out of workflow-priority.js so task-sources.js
// (whose CLI block has already called ensureRegistered()) can rank in-flight tasks without requiring next-claimable-task.js -> workflow-priority.js,
// which lazily requires task-sources.js (a cycle). workflow-priority.js keeps rankPriorityOfTask as a wrapper that loads the registry first and re-exports
// effectivePriority and BOT_ADHOC_PRIORITY_PENALTY, so every other importer is unchanged.

const { HUB_TIER_PRIORITY, isHubTierTask } = require('./hub-priority.js');
const { bandedPriority, readClaimBands } = require('./workflow-claim-order.js');

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
// Hub-work tier (2026-09-30, Grimmethy: hub sub-tasks handled ahead of ordinary work but below a human-pinned premium task):
// `hubTier` is true for an `atomic` decompose child or a child of a LIVE coordinating hub (hub-priority.js isHubTierTask, resolved
// through the source's hubOrder hook so an override is honored). Ranks HUB_TIER_PRIORITY (-1000): after premiumPriority
// (-Infinity), before every registered source priority. Derived from live hub membership at rank time -- never stamped on the task
// -- so it cannot drift. Within the tier the existing hub key (hubPriority, hub createdAt) and mtime decide.
const BOT_ADHOC_PRIORITY_PENALTY = 30; // 10 -> 40, landing alongside brain_dump_sort (42) / secondbrain (40) -- thematically apt, since most bot-adhoc IS brain_dump_sort's own continued output
function effectivePriority(task, basePriority, resolveSourceNameFn, hubTier = false) {
  if (task && task.premiumPriority) return -Infinity;
  if (hubTier) return HUB_TIER_PRIORITY;
  if (task && resolveSourceNameFn(task) === 'adhoc' && !task.humanQueued) return basePriority + BOT_ADHOC_PRIORITY_PENALTY;
  return basePriority;
}

// The rank priority of one task (lower number = claimed sooner): its source's registered priority with the
// bot-adhoc penalty / premium override applied. Infinity when unresolvable (sorts last, still listed). Shared by
// pickClaimableTasks (claim ranking) and task-sources.js's generation throttle, so "how important is this
// in-flight task" can never disagree between the two.
//
// `opts.hubTier` (boolean) is supplied by pickClaimableTasks, which already resolved it through the task's source hubOrder hook;
// when absent (the generation throttle) it is derived from the live coordinating/ records under `opts.pipelineDir` (default: the
// configured pipeline dir). The hub tier is applied BEFORE the derived_task early return below so a derived hub child gets it too;
// a premiumPriority task still ranks -Infinity.
function rankPriorityResolved(task, opts = {}) {
  if (!task) return Infinity;
  let hubTier = opts.hubTier;
  if (hubTier === undefined) {
    try {
      const pipelineDir = opts.pipelineDir || require('./config.js').getConfig().pipelineDir;
      hubTier = isHubTierTask(pipelineDir, task, opts.hubKeyCache);
    } catch (_) { hubTier = false; /* no config / unreadable hub records -- ordinary ranking */ }
  }
  if (hubTier) return task.premiumPriority ? -Infinity : HUB_TIER_PRIORITY;
  const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
  try {
    const bands = readClaimBands(); // null unless AGENT_MANAGER_PRIORITY_MODE=group and the workflow file has groups
    // A derived_task carries domain:'adhoc' (so every draft/apply path treats it exactly like adhoc --
    // resolveSourceName() sends it there), but it must RANK at its own registered priority (48,
    // self-maintenance band), never adhoc's base 10 + BOT_ADHOC_PRIORITY_PENALTY. Look it up by its
    // literal source name.
    if (task.source === 'derived_task') {
      const dt = getRegisteredSource('derived_task');
      return (dt && typeof dt.priority === 'number') ? bandedPriority('derived_task', dt.priority, bands) : Infinity;
    }
    const source = getRegisteredSource(resolveSourceName(task));
    if (source && typeof source.priority === 'number') return effectivePriority(task, bandedPriority(source.name, source.priority, bands), resolveSourceName);
  } catch (_) { /* unresolvable -- Infinity */ }
  return Infinity;
}

module.exports = { BOT_ADHOC_PRIORITY_PENALTY, effectivePriority, rankPriorityResolved };
