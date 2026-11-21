'use strict';

// Request log line (node server, multi-node plan): formats one registry request (heartbeat, claim, event or release) as ONE log line, so the
// node server's log says what was asked, by which node, with what status and how long it took. Pure formatting: no I/O, no timers, no network.
// Only the fields listed here are printed. Any other property of the argument (a token, an address) is ignored and never reaches the line.
//
// Line shape:  <at> <route> node=<nodeId> status=<status> ms=<ms>   (single spaces, no trailing newline)
//   at      an ISO-8601 string, or a number of milliseconds, printed as an ISO string
//   nodeId  printed when it matches the node id rule; otherwise node=-
//   ms      rounded to a whole number with Math.round; negative values print as 0
//
// Validation order when several fields are wrong: route, status, at, ms. nodeId never throws; a bad one prints node=- instead.

const ROUTES = ['/heartbeat', '/claim', '/event', '/release'];
// Restated from src/node-registry.js (NODE_ID_RE). Not imported, so this module stays free of registry code; keep the two in step by hand.
const NODE_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const AT_MESSAGE = 'at must be an ISO string or a number';

// Throws TypeError('unknown route') unless route is one of the four routes.
function checkRoute(route) {
  if (!ROUTES.includes(route)) throw new TypeError('unknown route');
}

// Throws RangeError unless status is an integer from 100 to 599.
function checkStatus(status) {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RangeError('status must be an integer from 100 to 599');
  }
}

// Returns the ISO-8601 form of at. Throws TypeError when at is not a string or number, a non-finite number, or does not name a real date.
function isoOf(at) {
  if (typeof at !== 'string' && typeof at !== 'number') throw new TypeError(AT_MESSAGE);
  if (typeof at === 'number' && !Number.isFinite(at)) throw new TypeError(AT_MESSAGE);
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) throw new TypeError(AT_MESSAGE);
  return d.toISOString();
}

// Returns the nodeId as printed: the id itself when it is a string matching the rule, otherwise '-'.
function nodeField(nodeId) {
  return typeof nodeId === 'string' && NODE_ID_RE.test(nodeId) ? nodeId : '-';
}

// Returns ms rounded to a whole number, with negative values clamped to 0. Throws TypeError when ms is not a finite number.
function msWhole(ms) {
  if (!Number.isFinite(ms)) throw new TypeError('ms must be a finite number');
  return Math.max(0, Math.round(ms));
}

// Formats one request as one log line. Throws TypeError or RangeError for a field that cannot be printed honestly.
function formatRequestLine({ route, nodeId, status, ms, at } = {}) {
  checkRoute(route);
  checkStatus(status);
  const iso = isoOf(at);
  const whole = msWhole(ms);
  return `${iso} ${route} node=${nodeField(nodeId)} status=${status} ms=${whole}`;
}

// Exported: formatRequestLine only. The helpers above stay private.
module.exports = { formatRequestLine };
