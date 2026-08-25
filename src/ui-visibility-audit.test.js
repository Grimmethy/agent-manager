'use strict';

// Unit tests for ui-visibility-audit.js -- see its own header for the real detection
// tradeoffs confirmed against the ACTUAL agent-manager dashboard while building this
// (three distinct URL-building styles mixed in one template, a known accepted
// false-negative for prefix-only concatenation).
//
// Run: node --test src/ui-visibility-audit.test.js (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  auditUiVisibility, isDue, markChecked,
  extractFlaskRoutes, isAuditableRoute, isRouteReferenced,
} = require('./ui-visibility-audit.js');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- isDue / markChecked -------------------------------------------------------------

test('isDue is true when the schedule file has never been written', () => {
  const dir = tempDir('ui-visibility-due-test-');
  assert.equal(isDue(dir), true);
});

test('isDue is false immediately after markChecked, true again once the interval has elapsed', () => {
  const dir = tempDir('ui-visibility-due-test-');
  const now = new Date('2026-08-24T12:00:00.000Z');
  markChecked(dir, now);
  assert.equal(isDue(dir, new Date('2026-08-24T12:30:00.000Z')), false);
  assert.equal(isDue(dir, new Date('2026-08-24T13:00:01.000Z')), true);
});

// --- extractFlaskRoutes ----------------------------------------------------------------

test('extractFlaskRoutes finds a plain GET route with no explicit methods', () => {
  const src = '@app.route("/api/ping")\ndef api_ping():\n    return jsonify({})\n';
  const routes = extractFlaskRoutes(src);
  assert.deepEqual(routes, [{ path: '/api/ping', methods: ['GET'], line: 1 }]);
});

test('extractFlaskRoutes parses an explicit methods= list', () => {
  const src = '@app.route("/api/task/<state>/<task_id>/archive", methods=["POST"])\ndef f(): pass\n';
  const routes = extractFlaskRoutes(src);
  assert.equal(routes[0].path, '/api/task/<state>/<task_id>/archive');
  assert.deepEqual(routes[0].methods, ['POST']);
});

test('extractFlaskRoutes finds every route in a multi-route file, in order', () => {
  const src = [
    '@app.route("/api/a")',
    'def a(): pass',
    '',
    '@app.route("/api/b", methods=["POST"])',
    'def b(): pass',
  ].join('\n');
  const routes = extractFlaskRoutes(src);
  assert.deepEqual(routes.map((r) => r.path), ['/api/a', '/api/b']);
});

// --- isAuditableRoute --------------------------------------------------------------------

test('isAuditableRoute includes any /api/ path regardless of method', () => {
  assert.equal(isAuditableRoute({ path: '/api/ping', methods: ['GET'] }), true);
});

test('isAuditableRoute includes a non-/api/ mutating route', () => {
  assert.equal(isAuditableRoute({ path: '/project/positions', methods: ['POST'] }), true);
});

test('isAuditableRoute excludes a plain GET page route outside /api/', () => {
  assert.equal(isAuditableRoute({ path: '/project/visualization', methods: ['GET'] }), false);
  assert.equal(isAuditableRoute({ path: '/', methods: ['GET'] }), false);
});

// --- isRouteReferenced: the three URL-building styles this dashboard actually mixes ------

test('isRouteReferenced finds a contiguous template-literal reference (strategy 1)', () => {
  const route = { path: '/api/queue/<state>', methods: ['GET'] };
  const src = 'fetchJson(`/api/queue/${state}?limit=5`)';
  assert.equal(isRouteReferenced(route, [src]), true);
});

test('isRouteReferenced finds a string-concatenation trailing-suffix reference (strategy 2)', () => {
  const route = { path: '/api/discuss/<session_id>/end', methods: ['POST'] };
  const src = "fetch('/api/discuss/' + encodeURIComponent(sessionId) + '/end', { method: 'POST' })";
  assert.equal(isRouteReferenced(route, [src]), true);
});

test('isRouteReferenced finds a generic-dispatcher bare-literal action reference (strategy 3)', () => {
  const route = { path: '/api/task/<state>/<task_id>/archive', methods: ['POST'] };
  const src = "postTaskAction(state, btn.dataset.id, 'archive', msg);\n"
    + "fetch(`/api/task/${state}/${encodeURIComponent(id)}/${action}`, opts)";
  assert.equal(isRouteReferenced(route, [src]), true);
});

test('isRouteReferenced finds a concatenation-prefix reference for an id-terminal route (strategy 4)', () => {
  const route = { path: '/api/deep-dive/projects/<slug>', methods: ['GET'] };
  const src = "await fetchJson('/api/deep-dive/projects/' + encodeURIComponent(slug));";
  assert.equal(isRouteReferenced(route, [src]), true);
});

test('isRouteReferenced returns false for a route referenced nowhere in any source', () => {
  const route = { path: '/api/hardware/stats', methods: ['GET'] };
  const src = "fetchJson('/api/instances'); fetchJson('/api/models');";
  assert.equal(isRouteReferenced(route, [src]), false);
});

test('isRouteReferenced checks across multiple source files, not just the first', () => {
  const route = { path: '/project/positions', methods: ['POST'] };
  const unrelated = "fetchJson('/api/instances');";
  const assetFile = "fetch('/project/positions', { method: 'POST', body: JSON.stringify(positions) });";
  assert.equal(isRouteReferenced(route, [unrelated, assetFile]), true);
});

test('isRouteReferenced does not confuse /api/models with /api/models/usage (prefix collision)', () => {
  const route = { path: '/api/models', methods: ['GET'] };
  const src = "fetchJson('/api/models/usage'); fetchJson('/api/models/cost-summary');";
  assert.equal(isRouteReferenced(route, [src]), false);
});

// --- auditUiVisibility (integration) ------------------------------------------------------

function writeFixtureRepo(dir, { appPySrc, templateSrc, assetFiles = {} }) {
  const dashboardDir = path.join(dir, 'python', 'dashboard', 'templates');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'python', 'dashboard', 'app.py'), appPySrc);
  fs.writeFileSync(path.join(dashboardDir, 'index.html'), templateSrc);
  if (Object.keys(assetFiles).length > 0) {
    const assetsDir = path.join(dir, 'python', 'visualize_assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    for (const [name, content] of Object.entries(assetFiles)) {
      fs.writeFileSync(path.join(assetsDir, name), content);
    }
  }
}

test('auditUiVisibility flags a route with genuinely no caller anywhere', () => {
  const dir = tempDir('ui-visibility-integration-test-');
  writeFixtureRepo(dir, {
    appPySrc: '@app.route("/api/hardware/stats")\ndef f(): pass\n',
    templateSrc: "fetchJson('/api/instances');",
  });
  const { candidates } = auditUiVisibility({ repoRoot: dir });
  assert.deepEqual(candidates.map((c) => c.path), ['/api/hardware/stats']);
});

test('auditUiVisibility does not flag a route referenced only in a visualize_assets JS file', () => {
  const dir = tempDir('ui-visibility-integration-test-');
  writeFixtureRepo(dir, {
    appPySrc: '@app.route("/project/positions", methods=["POST"])\ndef f(): pass\n',
    templateSrc: '// no reference here',
    assetFiles: { 'community-drag.js': "fetch('/project/positions', { method: 'POST' });" },
  });
  const { candidates } = auditUiVisibility({ repoRoot: dir });
  assert.deepEqual(candidates, []);
});

test('auditUiVisibility never flags a route on the known-non-UI allowlist even with zero callers', () => {
  const dir = tempDir('ui-visibility-integration-test-');
  writeFixtureRepo(dir, {
    appPySrc: '@app.route("/api/ping")\ndef f(): pass\n\n@app.route("/api/alerts")\ndef g(): pass\n',
    templateSrc: '// no reference to either',
  });
  const { candidates } = auditUiVisibility({ repoRoot: dir });
  assert.deepEqual(candidates, []);
});

test('auditUiVisibility excludes plain page GET routes outside /api/ entirely', () => {
  const dir = tempDir('ui-visibility-integration-test-');
  writeFixtureRepo(dir, {
    appPySrc: '@app.route("/project/visualization")\ndef f(): pass\n',
    templateSrc: '// never referenced, but this is a page route, not an API endpoint',
  });
  const { candidates } = auditUiVisibility({ repoRoot: dir });
  assert.deepEqual(candidates, []);
});

test('auditUiVisibility returns an empty result, not a throw, when app.py is missing', () => {
  const dir = tempDir('ui-visibility-integration-test-');
  const result = auditUiVisibility({ repoRoot: dir });
  assert.deepEqual(result.candidates, []);
});

test('auditUiVisibility finds zero candidates on a fully-covered fixture', () => {
  const dir = tempDir('ui-visibility-integration-test-');
  writeFixtureRepo(dir, {
    appPySrc: [
      '@app.route("/api/instances")',
      'def a(): pass',
      '',
      '@app.route("/api/task/<state>/<task_id>/archive", methods=["POST"])',
      'def b(): pass',
    ].join('\n'),
    templateSrc: [
      "fetchJson('/api/instances');",
      "postTaskAction(state, id, 'archive', msg);",
      "fetch(`/api/task/${state}/${encodeURIComponent(id)}/${action}`, opts);",
    ].join('\n'),
  });
  const { candidates } = auditUiVisibility({ repoRoot: dir });
  assert.deepEqual(candidates, []);
});
