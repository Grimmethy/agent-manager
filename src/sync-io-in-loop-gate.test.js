'use strict';

// Unit tests for the sync-io-in-loop pre-dispatch gate detector (gateSyncIoInLoop,
// registered in deterministic-recheck-registry.js). 2026-09-30: startup bounded-loop
// exemption (brain-dump bd-1788781713129) -- a 2026-09-16 triage window ended 25/25
// "false-positive dismissal" because the rule flagged startup-time bounded loops
// (hardcoded arrays, 3-10 directory walks) identically to request-hot-path loops.
// The two cases the acceptance criteria require:
//   (a) a startup bounded loop over a <= 10-element hardcoded array asserts NO flag
//       (verdict 'archive');
//   (b) a request-handler loop with an unbounded/large count asserts a flag IS still
//       emitted (verdict 'investigate').
// Style follows pre-dispatch-gate.test.js (node:test + node:assert/strict, CommonJS).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getPreDispatchGate,
  clearPreDispatchGateRegistry,
  registerPreDispatchGate,
  gateSyncIoInLoop,
} = require('./deterministic-recheck-registry.js');

function getSyncIoGate() {
  // Module load auto-registers under 'sync-io-in-loop'; re-register after a clear so
  // this helper is safe from test-to-test state.
  clearPreDispatchGateRegistry();
  registerPreDispatchGate('sync-io-in-loop', gateSyncIoInLoop);
  const gate = getPreDispatchGate('sync-io-in-loop');
  assert.equal(typeof gate, 'function');
  return gate;
}

test('(a) startup bounded loop over a 5-element hardcoded array is NOT flagged', () => {
  const gate = getSyncIoGate();
  const snippet = [
    'function bootstrapServices() {',
    "  for (const dir of ['cache', 'logs', 'tmp', 'bin', 'data']) {",
    '    fs.readdirSync(path.join(root, dir));',
    '  }',
    '}',
  ].join('\n');
  assert.deepStrictEqual(gate(snippet), {
    verdict: 'archive',
    reason: 'Bounded (<=10) loop in startup/initialization scope: one-time bounded work, not a hot-path violation',
  });
});

test('(b) request-handler loop over 1000 iterations IS still flagged', () => {
  const gate = getSyncIoGate();
  const snippet = [
    "app.get('/jobs', (req, res) => {",
    '  for (let i = 0; i < 1000; i++) {',
    '    fs.readFileSync(jobFile(i));',
    '  }',
    '  res.end();',
    '});',
  ].join('\n');
  assert.deepStrictEqual(gate(snippet), {
    verdict: 'investigate',
    reason: 'Sync I/O inside a loop in request/socket hot-path scope',
  });
});

test('startup bounded loop with numeric literal bound 10 is NOT flagged', () => {
  const gate = getSyncIoGate();
  const snippet = [
    'function main() {',
    '  for (let i = 0; i < 10; i++) {',
    '    fs.readFileSync(path.join(base, `part-${i}`));',
    '  }',
    '}',
  ].join('\n');
  assert.deepStrictEqual(gate(snippet), {
    verdict: 'archive',
    reason: 'Bounded (<=10) loop in startup/initialization scope: one-time bounded work, not a hot-path violation',
  });
});

test('startup bounded loop with numeric literal bound 5 is NOT flagged', () => {
  const gate = getSyncIoGate();
  const snippet = [
    'function init() {',
    '  for (let i = 0; i < 5; i++) {',
    '    fs.readFileSync(`config-${i}.json`);',
    '  }',
    '}',
  ].join('\n');
  assert.deepStrictEqual(gate(snippet).verdict, 'archive');
});

test('startup loop with bound 1000 IS still flagged (exemption is narrow, not a disable)', () => {
  const gate = getSyncIoGate();
  const snippet = [
    'function main() {',
    '  for (let i = 0; i < 1000; i++) {',
    '    fs.readFileSync(file(i));',
    '  }',
    '}',
  ].join('\n');
  assert.deepStrictEqual(gate(snippet).verdict, 'investigate');
});

test('hardcoded 15-element array at startup IS still flagged (array bound above 10)', () => {
  const gate = getSyncIoGate();
  const fifteen = Array.from({ length: 15 }, (_, k) => `'d${k}'`).join(', ');
  const snippet = [
    'function setup() {',
    `  for (const d of [${fifteen}]) {`,
    '    fs.readdirSync(d);',
    '  }',
    '}',
  ].join('\n');
  assert.deepStrictEqual(gate(snippet).verdict, 'investigate');
});

test('bounded loop in request-handler scope IS still flagged (hot-path outranks the bound)', () => {
  const gate = getSyncIoGate();
  const snippet = [
    'function handleRequest(req, res) {',
    '  for (let i = 0; i < 5; i++) {',
    '    fs.readFileSync(item(i));',
    '  }',
    '  res.end();',
    '}',
  ].join('\n');
  assert.deepStrictEqual(gate(snippet), {
    verdict: 'investigate',
    reason: 'Sync I/O inside a loop in request/socket hot-path scope',
  });
});

test('while(true) loop at startup IS still flagged (unbounded, fail-safe)', () => {
  const gate = getSyncIoGate();
  const snippet = [
    'function main() {',
    '  while (true) {',
    '    fs.readFileSync(next());',
    '  }',
    '}',
  ].join('\n');
  assert.deepStrictEqual(gate(snippet).verdict, 'investigate');
});

test('sync I/O with no loop construct at all IS still flagged (nothing to exempt)', () => {
  const gate = getSyncIoGate();
  const snippet = 'function main() { const buf = fs.readFileSync("seed.dat"); }';
  assert.deepStrictEqual(gate(snippet), {
    verdict: 'investigate',
    reason: 'No loop construct found in flagged snippet; sync I/O outside a loop cannot be exempted',
  });
});

test('gateSyncIoInLoop throws TypeError for non-string or empty input', () => {
  getSyncIoGate();
  assert.throws(() => gateSyncIoInLoop(null), TypeError);
  assert.throws(() => gateSyncIoInLoop(''), TypeError);
});

test('detector registers cleanly under both the canonical and alias rule IDs', () => {
  // Self-contained: start from a clean registry, register under both IDs (mirroring the
  // module-level registration in deterministic-recheck-registry.js), and confirm both
  // are retrievable while a duplicate registration is rejected.
  clearPreDispatchGateRegistry();
  registerPreDispatchGate('sync-io-in-loop', gateSyncIoInLoop);
  registerPreDispatchGate('sync io in loop', gateSyncIoInLoop);
  assert.equal(typeof getPreDispatchGate('sync-io-in-loop'), 'function');
  assert.equal(typeof getPreDispatchGate('sync io in loop'), 'function');
  assert.throws(() => registerPreDispatchGate('sync-io-in-loop', gateSyncIoInLoop), /already registered/);
  assert.throws(() => registerPreDispatchGate('sync io in loop', gateSyncIoInLoop), /already registered/);
});


// --- the 2026-09-30 defect: the startup exemption ran ahead of the hot-path check, and a CALL to loadConfig()/init() counted as startup scope ---------
test('a request handler that also calls loadConfig() is hot-path, not startup: investigate, not archive', () => {
  const gate = getSyncIoGate();
  const snippet = [
    "app.get('/x', (req, res) => {",
    '  loadConfig();',
    '  for (let i = 0; i < 3; i++) {',
    '    fs.readFileSync(files[i]);',
    '  }',
    '});',
  ].join('\n');
  assert.deepStrictEqual(gate(snippet), { verdict: 'investigate', reason: 'Sync I/O inside a loop in request/socket hot-path scope' });
});

test('a socket handler that also calls init() is hot-path: investigate', () => {
  const gate = getSyncIoGate();
  const snippet = "socket.on('data', () => { for (let i = 0; i < 5; i++) fs.readFileSync(p); init(); })";
  assert.equal(gate(snippet).verdict, 'investigate');
});

test('a plain helper that merely CALLS a startup-named function is not startup scope: investigate', () => {
  const gate = getSyncIoGate();
  const snippet = [
    'function processBatch(items) {',
    '  loadConfig();',
    '  for (let i = 0; i < 3; i++) {',
    '    fs.readFileSync(items[i]);',
    '  }',
    '}',
  ].join('\n');
  const out = gate(snippet);
  assert.equal(out.verdict, 'investigate');
  assert.match(out.reason, /exemption not confirmed/);
});

test('startup scope can also be an arrow or function expression assigned to a startup name', () => {
  const gate = getSyncIoGate();
  for (const head of ['const bootstrapAll = () => {', 'const setupDirs = async (root) => {', 'let initCache = function () {', 'const loadAll = path => {']) {
    const snippet = [head, '  for (let i = 0; i < 4; i++) {', '    fs.readFileSync(parts[i]);', '  }', '};'].join('\n');
    assert.equal(gate(snippet).verdict, 'archive', head);
  }
  assert.equal(gate(['function startServer() {', '  for (let i = 0; i < 4; i++) fs.readFileSync(parts[i]);', '}'].join('\n')).verdict, 'archive');
  assert.equal(gate(['def setup():', '  for (let i = 0; i < 4; i++) fs.readFileSync(parts[i]);'].join('\n')).verdict, 'archive');
});

test('a directory NAMED client inside a startup list is not a request path (quoted text is ignored), but a real client identifier still is', () => {
  const gate = getSyncIoGate();
  const named = [
    'function bootstrapDirs() {',
    "  for (const dir of ['client', 'server', 'request', 'shared']) {",
    '    fs.readdirSync(path.join(root, dir));',
    '  }',
    '}',
  ].join('\n');
  assert.equal(gate(named).verdict, 'archive');
  const real = [
    'function bootstrapDirs(client) {',
    '  for (let i = 0; i < 3; i++) {',
    '    fs.readFileSync(client.files[i]);',
    '  }',
    '}',
  ].join('\n');
  assert.equal(gate(real).verdict, 'investigate');
});
