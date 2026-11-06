'use strict';

// Guard for ADR-0024 ("triggers, not polls") on the dashboard page: no timer may drive a fetch or a redraw.
// Every recurring timer (setInterval) and every delayed call (setTimeout) in static/js (tests excluded) and in the
// inline script of templates/index.html must be listed below with the reason it is allowed. A new timer fails this test
// until a person adds it here and states why no event exists for it. Page updates come from the /api/stream events
// (live-updates.js); the only interval that fetches is the fallback refresh while the stream is closed.
//
// Run: node --test python/dashboard/static/js/no-timer-redraws.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = __dirname;
const INDEX = path.join(JS_DIR, '..', '..', 'templates', 'index.html');

// file -> { setInterval: n, setTimeout: n } and a reason per file. Counts are exact: removing a timer must update the list too.
const ALLOWED = {
  'live-updates.js': { setInterval: 1, setTimeout: 0, why: 'the fallback refresh, only while the event stream is closed (FALLBACK_POLL_MS)' },
  'templates/index.html': { setInterval: 1, setTimeout: 0, why: 'the 1 s display counter updateStaleTimers: rewrites two text nodes from the clock and the heartbeat already on the page; no fetch, no redraw' },
  'core-ui.js': { setInterval: 0, setTimeout: 2, why: 'a request abort timeout and the toast auto-hide: one-shot, started by a user action' },
  'branch-projects.js': { setInterval: 0, setTimeout: 1, why: 'a request abort timeout: one-shot' },
  'brain-dump-and-second-brain.js': { setInterval: 0, setTimeout: 2, why: 'a button label reset 1.2 s after a click: one-shot, display only' },
  'sidebar-and-claude-panels.js': { setInterval: 0, setTimeout: 1, why: 'a status text reset 2 s after an action: one-shot, display only' },
  'branches-joblist-hardware-tabs.js': { setInterval: 0, setTimeout: 1, why: 'one re-render 1.5 s after a merge that restarts the dashboard, waiting for the restart: one-shot, started by a user action' },
  'task-detail-modal.js': { setInterval: 0, setTimeout: 1, why: 'closes the modal 1.2 s after ending a discussion: one-shot, started by a user action' },
};

// Whole-line and trailing // comments go first: a comment such as "queue/*-flags.json" must not open a block comment.
function stripComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

function count(text, name) {
  return (stripComments(text).match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
}

function sources() {
  const out = {};
  for (const f of fs.readdirSync(JS_DIR)) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) out[f] = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
  }
  out['templates/index.html'] = fs.readFileSync(INDEX, 'utf8');
  return out;
}

test('every timer in the page code is on the allow list, with an exact count', () => {
  const found = {};
  for (const [file, text] of Object.entries(sources())) {
    const si = count(text, 'setInterval');
    const st = count(text, 'setTimeout');
    if (si || st) found[file] = { setInterval: si, setTimeout: st };
  }
  const expected = {};
  for (const [file, a] of Object.entries(ALLOWED)) expected[file] = { setInterval: a.setInterval, setTimeout: a.setTimeout };
  assert.deepEqual(found, expected);
});

test('the allow list gives a reason for each entry', () => {
  for (const [file, a] of Object.entries(ALLOWED)) assert.ok(a.why && a.why.length > 20, file);
});

test('the only interval that fetches is the stream fallback', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'live-updates.js'), 'utf8');
  assert.match(src, /fallbackTimer = setIntervalFn\(\(\) => \{ Promise\.resolve\(deps\.poll\(\)\)/);
  assert.match(src, /const FALLBACK_POLL_MS = 5000;/);
});

test('the 1 s stale-timer ticker neither fetches nor redraws', () => {
  const src = fs.readFileSync(path.join(JS_DIR, 'workers-tab.js'), 'utf8');
  const start = src.indexOf('function updateStaleTimers()');
  assert.ok(start >= 0);
  const body = stripComments(src.slice(start, src.indexOf('\n}\n', start)));
  assert.doesNotMatch(body, /\bfetch\w*\s*\(|render\w*\s*\(|refresh\w*\s*\(|innerHTML/);
  assert.match(body, /textContent/);
});

test('the counter helper detects the call forms it must (self-check)', () => {
  assert.equal(count('setInterval(a, 1); x = setInterval;', 'setInterval'), 2);
  assert.equal(count('// setInterval(a,1)\n/* setTimeout(b) */', 'setInterval'), 0);
  assert.equal(count('const f = deps.setIntervalFn || setInterval;', 'setInterval'), 1);
  assert.equal(count('// see queue/*-flags.json\nsetInterval(a, 1);', 'setInterval'), 1);
});
