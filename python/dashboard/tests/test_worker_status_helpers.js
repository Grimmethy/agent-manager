// Node tests for the shared worker status helpers (HUB0323 piece W-A4a): fmtAge, statusBadgeClass, statusLabel.
// Loads the browser script into a bare vm context, the way worker-switch-ui.test.js does.
// Run: node --test python/dashboard/tests/test_worker_status_helpers.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', 'static', 'js', 'worker-status-helpers.js');

function load() {
  const ctx = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), ctx, { filename: SOURCE });
  return ctx;
}

const h = load();

test('fmtAge: seconds, minutes, hours and missing values', () => {
  assert.equal(h.fmtAge(0), '0s');
  assert.equal(h.fmtAge(59), '59s');
  assert.equal(h.fmtAge(60), '1m');
  assert.equal(h.fmtAge(3599), '60m');
  assert.equal(h.fmtAge(3600), '1h');
  assert.equal(h.fmtAge(86400), '24h');
  assert.equal(h.fmtAge(5399), '1h');
  assert.equal(h.fmtAge(5400), '2h');
  assert.equal(h.fmtAge(null), '?');
  assert.equal(h.fmtAge(undefined), '?');
});

test('statusBadgeClass: one class per status when the heartbeat is fresh', () => {
  const expected = {
    working: 'ok', checking: 'ok', idle: 'idle', offline: 'idle',
    queued: 'warn', warming: 'warn', paused: 'warn', disabled: 'warn', error: 'warn', 'no-such-status': 'warn',
  };
  for (const [status, cls] of Object.entries(expected)) {
    assert.equal(h.statusBadgeClass(status, false), cls, status);
    assert.equal(h.statusBadgeClass(status), cls, `${status} (stale omitted)`);
  }
});

test('statusBadgeClass: a stale heartbeat is always bad', () => {
  for (const status of ['working', 'idle', 'queued', 'warming', 'offline', 'disabled', 'paused', 'error', 'no-such-status', undefined]) {
    assert.equal(h.statusBadgeClass(status, true), 'bad', String(status));
  }
});

test('statusLabel: the two GPU-session states are spelled out, the rest pass through', () => {
  assert.equal(h.statusLabel('paused'), 'paused: GPU session');
  assert.equal(h.statusLabel('warming'), 'resuming: model warming');
  for (const status of ['working', 'idle', 'queued', 'offline', 'disabled', 'error', 'no-such-status']) {
    assert.equal(h.statusLabel(status), status);
  }
  assert.equal(h.statusLabel(undefined), undefined);
});

test('the guarded export gives require() the same three functions', () => {
  const mod = require(SOURCE);
  assert.deepEqual(Object.keys(mod).sort(), ['fmtAge', 'statusBadgeClass', 'statusLabel']);
  assert.equal(mod.fmtAge(120), '2m');
});

test('no other script in static/js defines these three names, and workers-tab.js stays under 500 lines', () => {
  const dir = path.join(__dirname, '..', 'static', 'js');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js') && n !== 'worker-status-helpers.js')) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const name of ['fmtAge', 'statusBadgeClass', 'statusLabel']) {
      assert.ok(!new RegExp(`function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b`).test(text), `${f} defines ${name}`);
    }
  }
  const lines = fs.readFileSync(path.join(dir, 'workers-tab.js'), 'utf8').split('\n').length;
  assert.ok(lines < 500, `workers-tab.js has ${lines} lines`);
});

test('index.html loads worker-status-helpers.js directly before workers-tab.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
  const a = html.indexOf('/static/js/worker-status-helpers.js');
  const b = html.indexOf('/static/js/workers-tab.js');
  assert.ok(a > 0 && b > a);
  assert.equal(html.slice(a, b).split('<script').length, 2, 'no other script tag between them');
});
