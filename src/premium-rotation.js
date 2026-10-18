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

/** True when `instanceId` should NOT claim this task: it is on the task's avoidLanes, another lane exists and it is not pinned here. */
function laneAvoided(task, instanceId, laneCount, env = process.env) {
  if (!task || !laneAvoidanceEnabled(env)) return false;
  if (!Array.isArray(task.avoidLanes) || !task.avoidLanes.includes(instanceId)) return false;
  if (task.pinnedWorker === instanceId) return false;
  return Number(laneCount) > 1;
}

/** Adds the lane of the latest draft attempt to task.avoidLanes (set semantics). Returns the lane, or null when nothing was added. */
function recordAvoidedLane(task, laneCount, env = process.env) {
  if (!task || !laneAvoidanceEnabled(env) || !(Number(laneCount) > 1)) return null;
  const attempts = Array.isArray(task.draftAttempts) ? task.draftAttempts : [];
  const lane = attempts.length ? attempts[attempts.length - 1].lane : null;
  if (typeof lane !== 'string' || !lane) return null;
  const avoid = Array.isArray(task.avoidLanes) ? task.avoidLanes : [];
  if (avoid.includes(lane)) return null;
  task.avoidLanes = [...avoid, lane];
  return lane;
}

module.exports = {
  ROTATION_DEMOTED_PRIORITY, DEFAULT_ATTEMPTS, DEFAULT_WINDOW_MIN,
  recentBlockedAttempts, rotationDemoted, laneAvoided, recordAvoidedLane, rotationEnabled, laneAvoidanceEnabled,
};
