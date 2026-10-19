'use strict';

// js-test-runner.js: which runner executes a JS/TS test file (node:test, vitest, or none), chosen from the package that owns the file.
// Run: node --test src/lib/js-test-runner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nearestPackage, runnerFor, partitionJsTests, vitestArgs, parseVitestFailures } = require('./js-test-runner.js');

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'js-runner-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return dir;
}
const VITEST_PKG = { devDependencies: { vitest: '^3.2.7' } };

test('nearestPackage walks up to the first package.json (the repo root is "")', () => {
  const dir = repo({ 'package.json': {}, 'app/web/package.json': VITEST_PKG, 'app/web/src/a.test.tsx': 'x', 'tools/b.test.js': 'x' });
  assert.equal(nearestPackage(dir, 'app/web/src/a.test.tsx').pkgRel, 'app/web');
  assert.equal(nearestPackage(dir, 'tools/b.test.js').pkgRel, '');
  assert.equal(nearestPackage(repo({ 'x/y.test.js': 'x' }), 'x/y.test.js'), null, 'no package.json anywhere');
});

test('.ts/.tsx/.jsx go to vitest when their package declares it, and to "none" with the reason when it does not', () => {
  const dir = repo({ 'web/package.json': VITEST_PKG, 'web/src/A.test.tsx': 'x', 'api/package.json': {}, 'api/src/B.test.ts': 'x' });
  assert.deepEqual(runnerFor(dir, 'web/src/A.test.tsx'), { kind: 'vitest', pkgRel: 'web' });
  const none = runnerFor(dir, 'api/src/B.test.ts');
  assert.equal(none.kind, 'none');
  assert.match(none.reason, /node:test cannot run \.ts and api declares no test runner \(vitest\)/);
  assert.equal(runnerFor(dir, 'web/src/C.test.jsx').kind, 'vitest');
});

test('plain .js stays on node:test, even in a package that declares vitest, unless the file itself imports vitest', () => {
  const dir = repo({
    'web/package.json': VITEST_PKG,
    'web/src/plain.test.js': "const test = require('node:test');\n",
    'web/src/v.test.js': "import { it } from 'vitest';\n",
    'web/src/c.test.cjs': "const { it } = require('vitest');\n",
    'web/src/m.test.mjs': "import test from 'node:test';\n",
  });
  assert.equal(runnerFor(dir, 'web/src/plain.test.js').kind, 'node-test');
  assert.equal(runnerFor(dir, 'web/src/v.test.js').kind, 'vitest');
  assert.equal(runnerFor(dir, 'web/src/c.test.cjs').kind, 'vitest');
  assert.equal(runnerFor(dir, 'web/src/m.test.mjs').kind, 'node-test');
  assert.equal(runnerFor(dir, 'missing/file.test.js').kind, 'node-test', 'an unreadable file keeps today\'s default');
});

test('partitionJsTests groups vitest files by package and keeps node:test files and unrunnable ones apart', () => {
  const dir = repo({ 'package.json': {}, 'a.test.js': "x", 'web/package.json': VITEST_PKG, 'web/s/A.test.tsx': 'x', 'web/s/B.test.tsx': 'x', 'api/package.json': {}, 'api/C.test.tsx': 'x' });
  const p = partitionJsTests(dir, ['a.test.js', 'web/s/A.test.tsx', 'web/s/B.test.tsx', 'api/C.test.tsx']);
  assert.deepEqual(p.nodeTest, ['a.test.js']);
  assert.deepEqual([...p.vitest.entries()], [['web', ['web/s/A.test.tsx', 'web/s/B.test.tsx']]]);
  assert.deepEqual(p.none.map((x) => x.file), ['api/C.test.tsx']);
});

test('vitestArgs: starts vitest through node on its own entry, with package-relative file paths', () => {
  assert.deepEqual(vitestArgs('TaxHarvest/frontend', ['TaxHarvest/frontend/src/c/Toast.test.tsx']), ['node_modules/vitest/vitest.mjs', 'run', '--reporter=default', 'src/c/Toast.test.tsx']);
  assert.deepEqual(vitestArgs('', ['x/y.test.ts']), ['node_modules/vitest/vitest.mjs', 'run', '--reporter=default', 'x/y.test.ts']);
});

test('parseVitestFailures extracts the failing test names from the default reporter, unique and bounded', () => {
  const out = [
    ' ✓ src/ok.test.tsx (3 tests) 10ms',
    ' FAIL  src/c/Toast.test.tsx > Toast > auto-dismisses after the duration',
    ' FAIL  src/c/Toast.test.tsx > Toast > auto-dismisses after the duration',
    ' FAIL  src/c/Toast.test.tsx > Toast > the Dismiss button removes only its own toast',
    'AssertionError: expected ...',
  ].join('\n');
  assert.deepEqual(parseVitestFailures(out), ['src/c/Toast.test.tsx > Toast > auto-dismisses after the duration', 'src/c/Toast.test.tsx > Toast > the Dismiss button removes only its own toast']);
  assert.deepEqual(parseVitestFailures(''), []);
  assert.equal(parseVitestFailures(Array.from({ length: 40 }, (_, i) => ` FAIL  f > t${i}`).join('\n')).length, 20);
});
