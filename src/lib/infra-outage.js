'use strict';

// infra-outage.js: pure helpers that tell an infrastructure outage (the model host is unreachable or failing)
// apart from a content error (the request reached a healthy host and was rejected on its merits).
//
//   classifyError(err) -> 'infra' | 'content'
//   backoffDelayMs(attempt, { baseMs, capMs }) -> number of milliseconds (deterministic, no jitter)
//   formatGiveUpText(lastErr, cls) -> non-empty string
//
// Purity contract: no I/O, no environment reads, no clock reads, no randomness. Everything is an argument.

const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const DEFAULT_BASE_MS = 1000;
const DEFAULT_CAP_MS = 30000;
const GIVE_UP_PREFIX = 'gave up after infra outage: ';

function isTimeout(err) {
  if (!err || typeof err !== 'object') return false;
  const name = String(err.name || '');
  const code = String(err.code || '');
  if (/timeout/i.test(name) || /timeout/i.test(code)) return true;
  return /timeout/i.test(String(err.message || ''));
}

function classifyError(err) {
  if (err === null || err === undefined) return 'content';
  if (typeof err !== 'object' && typeof err !== 'function') return 'content';
  if (TRANSPORT_CODES.has(err.code)) return 'infra';
  if (/transport/i.test(String(err.name || ''))) return 'infra';
  if (isTimeout(err)) return 'infra';
  const status = Number.isInteger(err.status) ? err.status : err.statusCode;
  if (Number.isInteger(status) && status >= 500 && status <= 599) return 'infra';
  return 'content';
}

function backoffDelayMs(attempt, opts = {}) {
  const baseMs = opts.baseMs !== undefined ? opts.baseMs : DEFAULT_BASE_MS;
  const capMs = opts.capMs !== undefined ? opts.capMs : DEFAULT_CAP_MS;
  const n = Number.isFinite(attempt) && attempt >= 1 ? attempt : 1;
  return Math.min(capMs, baseMs * 2 ** (n - 1));
}

function formatGiveUpText(lastErr, cls) {
  let detail = null;
  if (typeof lastErr === 'string') {
    if (lastErr.trim()) detail = lastErr.trim();
  } else if (lastErr && typeof lastErr === 'object') {
    const status = lastErr.status !== undefined ? lastErr.status : lastErr.statusCode;
    if (status !== undefined && status !== null && status !== '') {
      detail = `status ${status}`;
    } else if (typeof lastErr.message === 'string' && lastErr.message.trim()) {
      detail = lastErr.message.trim();
    } else if (isTimeout(lastErr)) {
      detail = 'timeout';
    }
  }
  if (detail === null) {
    const c = cls !== undefined && cls !== null && cls !== '' ? cls : classifyError(lastErr);
    detail = `no error detail captured (class=${c})`;
  }
  return GIVE_UP_PREFIX + detail;
}

module.exports = { classifyError, backoffDelayMs, formatGiveUpText, TRANSPORT_CODES };
