'use strict';

// Capability routing (docs/design-notes/capability-routing-and-benchmarking.md, steps 2 and 4): a lane leaves a task alone while a LOWER-tier lane
// that has proven itself on that task's source is alive, for a bounded grace. "Proven" comes from the capability ledger's scorecard, or from an
// operator's `reserve: "always"` plus the lane's taskClasses. Default mode is SHADOW: the decision is made and logged, never applied.
//   AGENT_MANAGER_CAPABILITY_ROUTING  off | shadow (default) | enforce
//   _MIN_ATTEMPTS (8)  _MARGIN (0.10)  _MIN_OK_RATE (0.85)  AGENT_MANAGER_RESERVATION_GRACE_SECS (300)  _WINDOW_DAYS (14)
// Pure decision functions take their inputs; only auditReservation / cachedScorecard touch disk, best-effort.

const fs = require('fs');
const path = require('path');
const { readScorecard } = require('./capability-ledger.js');
const { logPipelineEvent } = require('./pipeline-history.js');
const { laneAllowsSource } = require('./lanes.js');

const HEARTBEAT_FRESH_MS = 90 * 1000;
const SCORECARD_TTL_MS = 60 * 1000;

function num(raw, dflt) {
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

function routingConfig(env = process.env) {
  const mode = String(env.AGENT_MANAGER_CAPABILITY_ROUTING || 'shadow').toLowerCase();
  return {
    mode: mode === 'off' || mode === 'enforce' ? mode : 'shadow',
    minAttempts: num(env.AGENT_MANAGER_CAPABILITY_MIN_ATTEMPTS, 8),
    margin: num(env.AGENT_MANAGER_CAPABILITY_MARGIN, 0.10),
    minOkRate: num(env.AGENT_MANAGER_CAPABILITY_MIN_OK_RATE, 0.85),
    graceMs: Math.max(0, num(env.AGENT_MANAGER_RESERVATION_GRACE_SECS, 300)) * 1000,
    windowDays: num(env.AGENT_MANAGER_CAPABILITY_WINDOW_DAYS, 14),
  };
}

// Has `lane` earned `source`? Enough attempts, and either close to the best larger tier's lower bound or (no larger-tier data) above the floor.
function passesGate(lane, source, rows, cfg) {
  const mine = rows.find((r) => r.source === source && r.model === lane.model);
  if (!mine || mine.n < cfg.minAttempts) return false;
  const refs = rows.filter((r) => r.source === source && r.tier != null && lane.tier != null && r.tier > lane.tier && r.n >= cfg.minAttempts);
  if (refs.length) return mine.lower >= Math.max(...refs.map((r) => r.lower)) - cfg.margin;
  return mine.okRate >= cfg.minOkRate;
}

// -> 'allowlist' | 'scorecard' | null: how (if at all) `lane` is qualified for `source`.
function qualification(lane, source, rows, cfg) {
  if (lane.reserve === false) return null;
  if (!laneAllowsSource(lane, source)) return null; // it could not claim the task anyway
  if (lane.reserve === 'always' && Array.isArray(lane.taskClasses)) return 'allowlist';
  return passesGate(lane, source, rows, cfg) ? 'scorecard' : null;
}

// Should `thisLane` hold off on a task of `source`? -> null | { holder, evidence }. `isAlive(laneId)` is the heartbeat test; `avoided(laneId)` says
// the task already failed on that lane (escalated), in which case nothing is held for it.
function decideReservation({ source, thisLane, lanes, rows, ageMs, cfg, isAlive, avoided = () => false }) {
  if (!source || !thisLane || thisLane.tier == null || ageMs >= cfg.graceMs) return null;
  const candidates = [];
  for (const l of lanes || []) {
    if (l.id === thisLane.id || l.tier == null || !(l.tier < thisLane.tier)) continue;
    if (avoided(l.id) || !isAlive(l.id)) continue;
    const evidence = qualification(l, source, rows || [], cfg);
    if (evidence) candidates.push({ holder: l.id, tier: l.tier, evidence });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.tier - b.tier);
  return { holder: candidates[0].holder, evidence: candidates[0].evidence };
}

function laneAliveFromHeartbeat(instancesDir, laneId, now = Date.now()) {
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(instancesDir, `${laneId}.json`), 'utf8'));
    const age = now - Date.parse(hb.lastHeartbeat);
    return Number.isFinite(age) && age >= 0 && age <= HEARTBEAT_FRESH_MS;
  } catch (_) { return false; }
}

const cache = new Map();
function cachedScorecard(pipelineDir, cfg, now = Date.now()) {
  const hit = cache.get(pipelineDir);
  if (hit && now - hit.at < SCORECARD_TTL_MS) return hit.rows;
  let rows = [];
  try { rows = readScorecard(pipelineDir, { windowDays: cfg.windowDays, now }); } catch (_) { rows = []; }
  cache.set(pipelineDir, { at: now, rows });
  return rows;
}

// One audit line per (task, lane, holder) -- the claim loop re-evaluates every tick, so a seen-set file keeps the log to decisions, not ticks.
function auditReservation(pipelineDir, instancesDir, entry) {
  try {
    const seenFile = path.join(instancesDir, 'reservation-seen.json');
    let seen = {};
    try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch (_) { seen = {}; }
    const key = `${entry.taskId}|${entry.lane}|${entry.holder}`;
    if (seen[key]) return;
    seen[key] = Date.now();
    const keys = Object.keys(seen);
    if (keys.length > 500) for (const k of keys.sort((a, b) => seen[a] - seen[b]).slice(0, keys.length - 500)) delete seen[k];
    fs.mkdirSync(instancesDir, { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify(seen));
    logPipelineEvent(pipelineDir, 'reservation', entry);
  } catch (_) { /* best-effort */ }
}

module.exports = { routingConfig, passesGate, qualification, decideReservation, laneAliveFromHeartbeat, cachedScorecard, auditReservation };
