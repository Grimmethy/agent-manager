'use strict';

// Pure cloud-first review routing. No file I/O, network, timers or spawning.
// Assumed record fields (not yet verified in this repo): enqueuedAt (ISO string or ms number), leasedTo (non-null when claimed), fromNode (non-empty string for a node draft).
// Assumed lane fields (not yet verified): cloud (boolean), free (boolean), reviews (false disables the lane).

const DEFAULT_THRESHOLD = 5;
const DEFAULT_MAX_WAIT_S = 900;

function resolveThreshold(threshold) {
  if (threshold !== undefined) return threshold;
  const raw = (process.env.AGENT_MANAGER_REVIEW_CLOUD_THRESHOLD || '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_THRESHOLD;
}

function ageS(record, now) {
  const t = record.enqueuedAt;
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(ms) ? (now - ms) / 1000 : null;
}

function isClaimed(record) {
  return record.leasedTo !== undefined && record.leasedTo !== null;
}

function isNodeDraft(record) {
  return typeof record.fromNode === 'string' && record.fromNode !== '';
}

// Returns { unchanged, assignments } where assignments is [{ record, lane }] in dispatch order.
// When unchanged is true, every input record is listed in input order with lane null.
function routeReviewOrder({ records = [], lanes = [], threshold, maxWaitS = DEFAULT_MAX_WAIT_S, now } = {}) {
  const limit = resolveThreshold(threshold);
  const stale = records.some(r => {
    const a = ageS(r, now);
    return a !== null && a > maxWaitS;
  });
  if (records.length <= limit && !stale) {
    return { unchanged: true, assignments: records.map(record => ({ record, lane: null })) };
  }

  const freeLanes = lanes.filter(l => l.reviews !== false && l.free === true);
  const cloudFree = freeLanes.filter(l => l.cloud === true);
  const localFree = freeLanes.filter(l => l.cloud !== true);

  const open = records.filter(r => !isClaimed(r));
  const ordered = [...open.filter(isNodeDraft), ...open.filter(r => !isNodeDraft(r))];

  const assignments = [];
  for (const record of ordered) {
    const lane = cloudFree.length ? cloudFree.shift() : localFree.shift();
    if (!lane) break;
    assignments.push({ record, lane });
  }
  return { unchanged: false, assignments };
}

module.exports = { routeReviewOrder };
