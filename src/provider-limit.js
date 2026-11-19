'use strict';

// Provider plan-limit classifier (HUB0737 1/3). Pure: no I/O, timers or network; never throws.
//
// parseProviderLimit(result[, {now}]) -> {resetsAt: <ms epoch>, resetsAtIso} | null
//   A failure is a plan limit when it is HTTP 429 (status field, or an `ollama http 429: {json}` reason) and its JSON body carries a usable reset:
//   `resetsAt` (absolute: ms epoch, epoch seconds, or a date string) or, only when resetsAt is absent, `retryAfter` / `retry-after` (RELATIVE seconds
//   from now). A present-but-invalid resetsAt returns null.
// isLegacyPlanLimitBlock(reason) -> boolean: the old `draft call failed N times in a row ... five-hour limit reached` blocked text.
// extractLegacyResetsAt(reason[, {now}]) -> ms epoch | null: an ISO timestamp in that text, else a `HH:MM UTC` / `3pm UTC` clock time (UTC math only).

const SEC_EPOCH_CEILING = 1e11; // numbers below this are epoch seconds, at or above are ms
const MAX_DATE_MS = 8.64e15;

function nowFrom(opts) {
  const n = opts && typeof opts === 'object' ? opts.now : undefined;
  return typeof n === 'number' && Number.isFinite(n) ? n : Date.now();
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validMs(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_MS ? ms : null;
}

// Absolute reset value -> ms epoch, or null.
function toResetsAtMs(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return validMs(value < SEC_EPOCH_CEILING ? value * 1000 : value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return toResetsAtMs(Number(s));
    return validMs(Date.parse(s));
  }
  return null;
}

// Relative delay in seconds (number or numeric string) -> finite number >= 0, or null.
function toRetrySeconds(value) {
  let n = null;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)) n = Number(value);
  return n !== null && Number.isFinite(n) && n >= 0 ? n : null;
}

function parseJsonObjectFrom(text, fromIdx) {
  const start = text.indexOf('{', fromIdx);
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start));
    return isPlainObject(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function parseProviderLimit(result, opts) {
  try {
    let text = '';
    let status = null;
    let body = null;
    if (typeof result === 'string') {
      text = result;
    } else if (isPlainObject(result)) {
      for (const k of ['reason', 'error', 'message']) {
        if (typeof result[k] === 'string' && result[k]) { text = result[k]; break; }
      }
      for (const k of ['status', 'httpStatus', 'statusCode']) {
        if (Number(result[k]) === 429) { status = 429; break; }
      }
      if (isPlainObject(result.body)) body = result.body;
      else if (isPlainObject(result.error)) body = result.error;
    } else {
      return null;
    }
    const m = /http\s*429\b/i.exec(text);
    if (m) status = 429;
    if (status !== 429) return null;
    if (!body) body = m ? parseJsonObjectFrom(text, m.index + m[0].length) : parseJsonObjectFrom(text, 0);
    if (!body) return null;

    let ms = null;
    if (body.resetsAt !== undefined && body.resetsAt !== null) {
      ms = toResetsAtMs(body.resetsAt); // invalid -> null, no fallthrough
    } else {
      const secs = [body.retryAfter, body['retry-after'], body.retryAfterSec]
        .map(toRetrySeconds).find((x) => x !== null);
      if (secs !== undefined) ms = validMs(nowFrom(opts) + secs * 1000);
    }
    if (ms === null) return null;
    return { resetsAt: ms, resetsAtIso: new Date(ms).toISOString() };
  } catch (e) {
    return null;
  }
}

function isLegacyPlanLimitBlock(reason) {
  if (typeof reason !== 'string') return false;
  return /draft call failed\s+\d+\s+times in a row/i.test(reason) && /five[- ]hour limit reached/i.test(reason);
}

function extractLegacyResetsAt(reason, opts) {
  try {
    if (!isLegacyPlanLimitBlock(reason)) return null;
    const now = nowFrom(opts);
    const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(reason);
    if (iso) {
      const s = /(Z|[+-]\d{2}:?\d{2})$/.test(iso[0]) ? iso[0] : `${iso[0]}Z`;
      const ms = validMs(Date.parse(s));
      if (ms !== null) return ms;
    }
    let h = null;
    let min = 0;
    let m = /\b(\d{1,2}):(\d{2})\s*UTC\b/i.exec(reason);
    if (m) { h = Number(m[1]); min = Number(m[2]); }
    else if ((m = /\b(\d{1,2})\s*(am|pm)\s*UTC\b/i.exec(reason))) {
      h = Number(m[1]);
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (m[2].toLowerCase() === 'pm' ? 12 : 0);
    }
    if (h === null || h > 23 || min > 59) return null;
    const d = new Date(now);
    let ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min);
    if (ms <= now) ms += 24 * 60 * 60 * 1000;
    return validMs(ms);
  } catch (e) {
    return null;
  }
}

module.exports = { parseProviderLimit, isLegacyPlanLimitBlock, extractLegacyResetsAt };
