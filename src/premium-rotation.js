'use strict';

// Premium head-of-line starvation guards (2026-10-15).
//
// Live evidence: ten premium adhoc tasks sat unclaimed for hours behind ONE premium hub child (HUB0148-01) that the P40 lane
// kept claiming and blocking with "Plan pass degenerate: truncated" -- every pass it returned to the same rank, ahead of every
// other premium task. premiumPriority sorts a task ahead of everything, and nothing looked at how often it had already failed.
//
//   1. ROTATION: a premium task with >= ATTEMPTS blocked draft attempts inside WINDOW minutes is "demoted": it still beats every
//      non-premium task (it keeps its flag), but fresh premium tasks go before it. AGENT_MANAGER_PREMIUM_ROTATION=off disables.
//   2. LANE AVOIDANCE: a plan-degenerate block records the lane it happened on (task.avoidLanes); the claim loop skips that
//      lane for the task while another lane exists. A single-lane setup, or an explicit pin to the lane, still runs it.
//      AGENT_MANAGER_LANE_AVOIDANCE=off disables.
//
// Pure functions (env and clock are parameters) so both the generation sort and the claim ranking share one definition.

const DEFAULT_ATTEMPTS = 2;
const DEFAULT_WINDOW_MIN = 180;
// Rank used by the claim ranking for a demoted premium task: after fresh premium (-Infinity), before the hub tier (-1000)
// and every registered source priority.
const ROTATION_DEMOTED_PRIORITY = -1e9;

function off(value) {
  return String(value || '').trim().toLowerCase() === 'off';
}
function rotationEnabled(env = process.env) { return !off(env.AGENT_MANAGER_PREMIUM_ROTATION); }
function laneAvoidanceEnabled(env = process.env) { return !off(env.AGENT_MANAGER_LANE_AVOIDANCE); }

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Number of draftAttempts with outcome 'blocked' that finished (else started) inside the window ending at `now`. */
function recentBlockedAttempts(task, windowMs, now = Date.now()) {
  const attempts = Array.isArray(task && task.draftAttempts) ? task.draftAttempts : [];
  let n = 0;
  for (const a of attempts) {
    if (!a || a.outcome !== 'blocked') continue;
    const t = Date.parse(a.finishedAt || a.at || '');
    if (Number.isFinite(t) && now - t <= windowMs && now - t >= -60_000) n += 1;
  }
  return n;
}

/** True for a premiumPriority task that keeps getting blocked: it should rotate behind fresh premium work. */
function rotationDemoted(task, env = process.env, now = Date.now()) {
  if (!task || !task.premiumPriority || !rotationEnabled(env)) return false;
  const attempts = positiveNumber(env.AGENT_MANAGER_PREMIUM_ROTATION_ATTEMPTS, DEFAULT_ATTEMPTS);
  const windowMs = positiveNumber(env.AGENT_MANAGER_PREMIUM_ROTATION_WINDOW_MIN, DEFAULT_WINDOW_MIN) * 60_000;
  return recentBlockedAttempts(task, windowMs, now) >= attempts;
}

/**
 * True when `instanceId` should NOT claim this task: it is on the task's avoidLanes, another lane exists and it is not pinned here.
 *
 * `ctx` ({ lanes, source, alive }, optional) closes the limbo case (2026-10-17): a premium task whose avoidLanes named both the biggest lane and the other full
 * lane was claimable by NO lane, because the only remaining lane had a taskClasses allowlist that did not include its source. With ctx.lanes (an array) a lane
 * is skipped only while at least one OTHER lane exists that is not in avoidLanes, is allowed to claim ctx.source (lanes.js laneAllowsSource) and is alive
 * (ctx.alive(id), a fresh heartbeat). Avoidance steers a task to somewhere else; it must never leave it nowhere to go. Without ctx the behaviour is unchanged.
 */
function laneAvoided(task, instanceId, laneCount, env = process.env, ctx = null) {
  if (!task || !laneAvoidanceEnabled(env)) return false;
  if (!Array.isArray(task.avoidLanes) || !task.avoidLanes.includes(instanceId)) return false;
  if (task.pinnedWorker === instanceId) return false;
  if (!(Number(laneCount) > 1)) return false;
  if (!ctx || !Array.isArray(ctx.lanes)) return true;
  const { laneAllowsSource } = require('./lanes.js');
  const alive = typeof ctx.alive === 'function' ? ctx.alive : () => true;
  return ctx.lanes.some((l) => l && l.id !== instanceId && !task.avoidLanes.includes(l.id) && laneAllowsSource(l, ctx.source) && alive(l.id));
}

/** Numeric tier of a lane (billions of parameters), or null when unknown. */
function laneTier(lane) {
  return lane && typeof lane.tier === 'number' && Number.isFinite(lane.tier) ? lane.tier : null;
}

/** True when `lane` may be steered away from: its tier is known and some OTHER lane has a strictly bigger known tier (the rule capability-routing.js escalationLane uses). */
function hasBiggerLane(lane, lanes) {
  const mine = laneTier(lane);
  if (mine == null) return false;
  return lanes.some((l) => l && l.id !== lane.id && laneTier(l) != null && laneTier(l) > mine);
}

/**
 * Adds the lane of the latest draft attempt to task.avoidLanes (set semantics). Returns the lane, or null when nothing was added.
 *
 * `lanes` (optional array of lane definitions, lanes.js getLanes()) applies the tier rule: a lane whose tier is KNOWN and that has no strictly BIGGER lane above
 * it (the biggest lane, or a tie for biggest) is never recorded -- avoidance is for steering away from a smaller lane, and a task that has failed on the biggest
 * one needs a systemic fix (describeTopTierFailure), not a block that strands it. A lane with an unknown tier, or one missing from the list, can still be
 * recorded (nothing proves it is the biggest, and laneAvoided's ctx guard means such a record cannot strand the task). Without `lanes` the behaviour is unchanged.
 */
function recordAvoidedLane(task, laneCount, env = process.env, lanes = null) {
  if (!task || !laneAvoidanceEnabled(env) || !(Number(laneCount) > 1)) return null;
  const attempts = Array.isArray(task.draftAttempts) ? task.draftAttempts : [];
  const lane = attempts.length ? attempts[attempts.length - 1].lane : null;
  if (typeof lane !== 'string' || !lane) return null;
  if (Array.isArray(lanes)) {
    // Refuse only a lane KNOWN to be the biggest (tier known, nothing strictly bigger). An unknown tier proves nothing, so the lane may still be recorded: the
    // reader (laneAvoided ctx) guarantees such a record can never strand the task, which is the property this rule exists to protect.
    const def = lanes.find((l) => l && l.id === lane);
    if (def && laneTier(def) != null && !hasBiggerLane(def, lanes)) return null;
  }
  const avoid = Array.isArray(task.avoidLanes) ? task.avoidLanes : [];
  if (avoid.includes(lane)) return null;
  task.avoidLanes = [...avoid, lane];
  return lane;
}

/**
 * The systemic finding for a failure on the biggest lane, where recordAvoidedLane deliberately records nothing: { title, body } or null.
 * Built from the failure class, lane id and model ONLY, so the same failure on the same lane and model is the same text and the side-finding sweep merges the
 * repeats into one entry (the task id goes in the inbox metadata, not here). Null when the lane is not in the list, or when it is a lane that avoidance would
 * have steered away from (then avoidance, not a finding, is the response).
 */
function describeTopTierFailure(task, lanes, failureClass = 'plan-pass degenerate') {
  if (!task || !Array.isArray(lanes)) return null;
  const attempts = Array.isArray(task.draftAttempts) ? task.draftAttempts : [];
  const laneId = attempts.length ? attempts[attempts.length - 1].lane : null;
  const lane = typeof laneId === 'string' ? lanes.find((l) => l && l.id === laneId) : null;
  if (!lane || laneTier(lane) == null || hasBiggerLane(lane, lanes)) return null;
  const model = lane.model || 'unknown model';
  return {
    title: `${failureClass} on the biggest lane (${lane.id}, ${model})`,
    body: [
      `A draft attempt hit "${failureClass}" on ${lane.id} running ${model}, which is the biggest-tier lane, so there is no bigger lane to steer the retry to and the task was NOT marked to avoid it.`,
      'Lane avoidance is for moving a task off a smaller lane. A repeat failure on the biggest lane is a systemic problem (prompt size, output budget, think mode, model), not something to route around.',
      'Look at the draft-attempt records of tasks carrying this failure on this lane: their output length versus the cap, whether thinking was on, and the plan prompt size.',
    ].join('\n\n'),
  };
}

module.exports = {
  ROTATION_DEMOTED_PRIORITY, DEFAULT_ATTEMPTS, DEFAULT_WINDOW_MIN,
  recentBlockedAttempts, rotationDemoted, laneAvoided, recordAvoidedLane, describeTopTierFailure, hasBiggerLane, rotationEnabled, laneAvoidanceEnabled,
};
