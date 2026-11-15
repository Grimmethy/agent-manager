'use strict';

/*
 * Pure next-due calculator for scheduled jobs. No I/O, no timers, no clock reads:
 * every instant comes from the arguments.
 *
 * nextDue(cadence, { now, lastDue, rules })
 *   now, lastDue: Date or epoch-ms number. lastDue may be omitted/null (no missed runs).
 *
 * Cadence shapes:
 *   { kind: 'at', time: 'HH:MM', weekday?: 0-6 }   wall-clock time in the system's local zone
 *                                                   (weekday 0 = Sunday). DST gaps/overlaps
 *                                                   follow Date local-time behavior.
 *   { kind: 'every', anchor: ms, interval: ms }      occurrences are anchor + k * interval
 *   { kind: 'rule', name: string }                   rules[name]({ now, lastDue }) returns the
 *                                                   next occurrence strictly after lastDue (ms or Date)
 *
 * Return value:
 *   - Epoch-ms number: the next occurrence strictly after now (0 or 1 occurrence missed).
 *   - { runNow: true, missedCount, nextDue }: two or more occurrences fell in (lastDue, now].
 *     missedCount = occurrences missed minus one; nextDue is strictly after now.
 *
 * Throws on an unknown rule name or an invalid cadence.
 */

const MAX_MISSED_SCAN = 10000;

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new TypeError('nextDue: time must be a Date or a finite epoch-ms number');
}

function parseHHMM(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) throw new Error(`nextDue: invalid time "${s}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`nextDue: invalid time "${s}"`);
  return { h, min };
}

function validateAt(cadence) {
  parseHHMM(cadence.time);
  if (cadence.weekday !== undefined && !(Number.isInteger(cadence.weekday) && cadence.weekday >= 0 && cadence.weekday <= 6)) {
    throw new Error(`nextDue: invalid weekday "${cadence.weekday}", expected 0-6`);
  }
}

function validateEvery(cadence) {
  if (!Number.isFinite(cadence.anchor)) throw new Error('nextDue: every-cadence needs a finite anchor (ms)');
  if (!(Number.isFinite(cadence.interval) && cadence.interval > 0)) {
    throw new Error('nextDue: every-cadence needs a positive interval (ms)');
  }
}

// First 'at' occurrence strictly after afterMs, in local wall-clock time.
function nextAt(cadence, afterMs) {
  const { h, min } = parseHHMM(cadence.time);
  const base = new Date(afterMs);
  for (let i = 0; i <= 14; i++) {
    const c = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, h, min, 0, 0);
    if (cadence.weekday !== undefined && c.getDay() !== cadence.weekday) continue;
    if (c.getTime() > afterMs) return c.getTime();
  }
  throw new Error('nextDue: no occurrence found for at-cadence');
}

// Index k of the every-occurrence at or before t: occurrence k is anchor + k * interval.
function everyIndex(cadence, t) {
  return Math.floor((t - cadence.anchor) / cadence.interval);
}

// First every-occurrence strictly after t, computed arithmetically.
function nextEvery(cadence, t) {
  const k = everyIndex(cadence, t);
  let c = cadence.anchor + (k + 1) * cadence.interval;
  while (c <= t) c += cadence.interval; // float guard
  while (c - cadence.interval > t) c -= cadence.interval; // float guard
  return c;
}

function nextDue(cadence, opts) {
  const { now, lastDue, rules = {} } = opts || {};
  if (now === undefined || now === null) throw new TypeError('nextDue: now is required');
  if (!cadence || typeof cadence !== 'object') throw new TypeError('nextDue: cadence must be an object');

  const nowMs = toMs(now);
  // lastDue undefined/null => no known previous run, so nothing can be missed.
  const lastMs = lastDue === undefined || lastDue === null ? null : toMs(lastDue);

  let next;
  let missed = 0; // occurrences in (lastMs, nowMs]

  switch (cadence.kind) {
    case 'at': {
      validateAt(cadence);
      if (lastMs !== null) {
        let t = nextAt(cadence, lastMs);
        while (t <= nowMs && missed < MAX_MISSED_SCAN) {
          missed++;
          t = nextAt(cadence, t);
        }
      }
      next = nextAt(cadence, nowMs);
      break;
    }
    case 'every': {
      validateEvery(cadence);
      next = nextEvery(cadence, nowMs);
      if (lastMs !== null) {
        missed = Math.max(0, everyIndex(cadence, nowMs) - everyIndex(cadence, lastMs));
      }
      break;
    }
    case 'rule': {
      const fn = Object.prototype.hasOwnProperty.call(rules, cadence.name) ? rules[cadence.name] : undefined;
      if (typeof fn !== 'function') throw new Error(`nextDue: unknown rule "${cadence.name}"`);
      let cursor = lastMs === null ? nowMs : lastMs;
      let t = toMs(fn({ now: nowMs, lastDue: cursor }));
      if (lastMs !== null) {
        while (t <= nowMs && missed < MAX_MISSED_SCAN) {
          if (t <= cursor) throw new Error(`nextDue: rule "${cadence.name}" did not advance`);
          missed++;
          cursor = t;
          t = toMs(fn({ now: nowMs, lastDue: cursor }));
        }
      }
      next = t;
      break;
    }
    default:
      throw new Error(`nextDue: unknown cadence kind "${cadence.kind}"`);
  }

  if (!(next > nowMs)) throw new Error('nextDue: computed next occurrence is not after now');

  if (missed >= 2) {
    return { runNow: true, missedCount: missed - 1, nextDue: next };
  }
  return next;
}

module.exports = { nextDue };
