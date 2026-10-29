'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tf = require('./test-framework.js');

// A TaxHarvest-shaped repo: backend (node:test, no runner declared), frontend (no runner at all), python_services (unittest + plain scripts).
function repo({ backendPkg = { name: 'backend', dependencies: { express: '^4' } }, frontendPkg = { name: 'frontend', dependencies: { react: '^18' }, scripts: { build: 'vite build' } }, rootPkg = { name: 'root' } } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tfw-'));
  const w = (f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
  w('TaxHarvest/package.json', JSON.stringify(rootPkg));
  w('TaxHarvest/backend/package.json', JSON.stringify(backendPkg));
  w('TaxHarvest/frontend/package.json', JSON.stringify(frontendPkg));
  w('TaxHarvest/backend/counties/_shared/coerce.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\ntest('x', () => assert.ok(true));\n");
  w('TaxHarvest/backend/counties/_shared/classify.test.js', "const test = require('node:test');\ntest('y', () => {});\n");
  w('TaxHarvest/backend/python_services/tests/test_adapter_config.py', 'import unittest\n\nclass T(unittest.TestCase):\n    pass\n');
  w('TaxHarvest/backend/python_services/requirements.txt', 'psycopg2-binary\nrequests\n');
  w('TaxHarvest/frontend/src/App.tsx', 'export default function App() { return null; }\n');
  return { d, w };
}
const JEST_TEST = "describe('x', () => { it('y', () => { const f = jest.fn(); expect(f).toBeDefined(); }); });\n";
const RTL_TEST = "import { render } from '@testing-library/react';\nimport T from './T';\ntest('t', () => { render(<T />); });\n";
const NODE_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('z', () => assert.ok(1));\n";

test('detectFramework recognises the frameworks and ignores what it cannot place', () => {
  assert.equal(tf.detectFramework('a.test.js', NODE_TEST), 'node:test');
  assert.equal(tf.detectFramework('a.test.js', "import test from 'node:test';\n"), 'node:test');
  assert.equal(tf.detectFramework('a.test.js', "const f = jest.fn();\ndescribe('x', () => {});"), 'jest');
  assert.equal(tf.detectFramework('a.test.tsx', RTL_TEST), 'testing-library');
  assert.equal(tf.detectFramework('a.test.ts', "import { it } from 'vitest';\n"), 'vitest');
  assert.equal(tf.detectFramework('a.test.js', "describe('x', () => { it('y', () => {}); });"), 'globals');
  assert.equal(tf.detectFramework('test_x.py', 'import pytest\n'), 'pytest');
  assert.equal(tf.detectFramework('test_x.py', 'import unittest\n'), 'unittest');
  assert.equal(tf.detectFramework('test_x.py', 'def test_a():\n    assert True\n'), 'other');
  assert.equal(tf.detectFramework('a.test.js', 'console.log(1);'), 'other');
});

test('the three TaxHarvest incidents are flagged: jest in the backend, jest/RTL .tsx in a frontend with no runner', () => {
  const { d } = repo();
  const flags = tf.checkNewTestFiles({ repoRoot: d, files: [
    { path: 'TaxHarvest/backend/src/utils/propertyType.test.js', content: JEST_TEST },
    { path: 'TaxHarvest/frontend/src/components/PageErrorBoundary.test.tsx', content: RTL_TEST },
    { path: 'TaxHarvest/frontend/src/components/Toast.test.tsx', content: RTL_TEST },
  ] });
  assert.equal(flags.length, 3);
  const be = flags.find((f) => f.file.includes('propertyType'));
  assert.equal(be.framework, 'jest');
  assert.deepEqual(be.available, ['node:test']);
  assert.ok(be.examples.some((e) => e.endsWith('coerce.test.js') || e.endsWith('classify.test.js')), 'a sibling node:test file is offered as the example');
  assert.equal(be.noRunner, false);
  const fe = flags.find((f) => f.file.includes('PageErrorBoundary'));
  assert.equal(fe.framework, 'testing-library');
  assert.equal(fe.noRunner, true, 'the frontend has no runner and no tests');
  assert.deepEqual(fe.available, []);
  const msg = tf.feedbackFor([fe]);
  assert.match(msg, /no test runner configured/);
  assert.match(msg, /do NOT create it/);
});

test('never flagged: node:test in a JS package, unittest and plain python, and a framework the SAME change adds to package.json', () => {
  const { d } = repo();
  assert.deepEqual(tf.checkNewTestFiles({ repoRoot: d, files: [{ path: 'TaxHarvest/backend/src/x.test.js', content: NODE_TEST }] }), []);
  assert.deepEqual(tf.checkNewTestFiles({ repoRoot: d, files: [{ path: 'TaxHarvest/backend/python_services/tests/test_new.py', content: 'import unittest\n' }] }), []);
  assert.deepEqual(tf.checkNewTestFiles({ repoRoot: d, files: [{ path: 'TaxHarvest/backend/python_services/tests/test_new.py', content: 'def test_a():\n    assert True\n' }] }), []);
  const adds = '{"devDependencies": {"vitest": "^1.0.0", "@testing-library/react": "^14"}}';
  assert.deepEqual(tf.checkNewTestFiles({ repoRoot: d, files: [{ path: 'TaxHarvest/frontend/src/T.test.tsx', content: RTL_TEST }], packageText: adds }), [], 'the dependency arrives in the same change');
  assert.equal(tf.checkNewTestFiles({ repoRoot: d, files: [{ path: 'TaxHarvest/frontend/src/T.test.tsx', content: RTL_TEST }], packageText: '{"dependencies": {"left-pad": "1"}}' }).length, 1, 'an unrelated package.json edit does not excuse it');
});

test('a declared runner (own package or a parent) or an existing test using it makes the framework available', () => {
  let r = repo({ backendPkg: { name: 'b', devDependencies: { jest: '^29' } } });
  assert.deepEqual(tf.checkNewTestFiles({ repoRoot: r.d, files: [{ path: 'TaxHarvest/backend/src/a.test.js', content: JEST_TEST }] }), []);
  r = repo({ rootPkg: { name: 'root', devDependencies: { vitest: '^1' } } });
  assert.deepEqual(tf.checkNewTestFiles({ repoRoot: r.d, files: [{ path: 'TaxHarvest/frontend/src/a.test.ts', content: "import { it } from 'vitest';\n" }] }), [], 'declared at the monorepo root');
  r = repo();
  r.w('TaxHarvest/backend/src/old.test.js', JEST_TEST);
  assert.deepEqual(tf.checkNewTestFiles({ repoRoot: r.d, files: [{ path: 'TaxHarvest/backend/src/new.test.js', content: JEST_TEST }] }), [], 'jest is already used by an existing test in the package');
  r = repo({ frontendPkg: { name: 'f', scripts: { test: 'vitest run' } } });
  assert.deepEqual(tf.checkNewTestFiles({ repoRoot: r.d, files: [{ path: 'TaxHarvest/frontend/src/a.test.tsx', content: RTL_TEST.replace('@testing-library/react', 'vitest') + "import { it } from 'vitest';\n" }] }), [], 'scripts.test declares vitest');
});

test('node:test cannot run TypeScript or JSX: a .tsx node:test file in a package with no runner is flagged', () => {
  const { d } = repo();
  const flags = tf.checkNewTestFiles({ repoRoot: d, files: [{ path: 'TaxHarvest/frontend/src/a.test.tsx', content: NODE_TEST }] });
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /cannot run a \.tsx file/);
});

test('pytest needs to be declared or already used; the new file itself never counts as "existing use"', () => {
  const { d, w } = repo();
  const flags = tf.checkNewTestFiles({ repoRoot: d, files: [{ path: 'TaxHarvest/backend/python_services/tests/test_p.py', content: 'import pytest\n' }] });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].framework, 'pytest');
  assert.deepEqual(flags[0].available, ['unittest']);
  w('TaxHarvest/backend/python_services/requirements.txt', 'requests\npytest>=7\n');
  assert.deepEqual(tf.checkNewTestFiles({ repoRoot: d, files: [{ path: 'TaxHarvest/backend/python_services/tests/test_p.py', content: 'import pytest\n' }] }), []);
  // the file being created already exists on disk (agentic worktree): it must not vouch for itself
  const r2 = repo();
  r2.w('TaxHarvest/backend/src/self.test.js', JEST_TEST);
  assert.equal(tf.checkNewTestFiles({ repoRoot: r2.d, files: [{ path: 'TaxHarvest/backend/src/self.test.js', content: JEST_TEST }] }).length, 1);
});

test('non-test files and unrecognised frameworks are ignored; a missing repo never throws', () => {
  const { d } = repo();
  assert.deepEqual(tf.checkNewTestFiles({ repoRoot: d, files: [{ path: 'TaxHarvest/backend/src/helper.js', content: JEST_TEST }] }), []);
  assert.deepEqual(tf.checkNewTestFiles({ repoRoot: d, files: [{ path: 'TaxHarvest/backend/src/a.test.js', content: 'console.log(1);' }] }), []);
  assert.doesNotThrow(() => tf.checkNewTestFiles({ repoRoot: '/no/such/repo', files: [{ path: 'x/a.test.js', content: JEST_TEST }] }));
});

test('inspectChangeSet reads created test files and package.json writes from a Group B response; inspectDiff does the same from a unified diff', () => {
  const cs = tf.inspectChangeSet([
    { mode: 'create', file: 'a/x.test.js', content: 'T' }, { mode: 'create', file: 'a/y.js', content: 'Y' },
    { mode: 'edit', file: 'a/package.json', find: '"a"', replace: '"vitest": "1"' }, { mode: 'delete', file: 'a/z.test.js' }, null, { mode: 'create', file: 'a/package.json', content: '{"mocha":"1"}' },
  ]);
  assert.deepEqual(cs.files, [{ path: 'a/x.test.js', content: 'T' }]);
  assert.match(cs.packageText, /vitest/);
  assert.match(cs.packageText, /mocha/);
  const diff = 'diff --git a/a/n.test.js b/a/n.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/a/n.test.js\n@@ -0,0 +1,2 @@\n+const t = require("node:test");\n+t("x", () => {});\ndiff --git a/a/old.test.js b/a/old.test.js\nindex 1..2 100644\n--- a/a/old.test.js\n+++ b/a/old.test.js\n@@ -1 +1 @@\n-x\n+jest.fn()\ndiff --git a/a/package.json b/a/package.json\n--- a/a/package.json\n+++ b/a/package.json\n@@ -1 +1 @@\n+  "vitest": "1"\n';
  const di = tf.inspectDiff(diff);
  assert.deepEqual(di.files.map((f) => f.path), ['a/n.test.js'], 'a MODIFIED existing test is not a new test file');
  assert.match(di.packageText, /vitest/);
});

test('gateMode defaults to block; advisory and off are honoured', () => {
  assert.equal(tf.gateMode({}), 'block');
  assert.equal(tf.gateMode({ AGENT_MANAGER_TEST_FRAMEWORK_GATE: 'Advisory' }), 'advisory');
  assert.equal(tf.gateMode({ AGENT_MANAGER_TEST_FRAMEWORK_GATE: 'off' }), 'off');
  assert.equal(tf.gateMode({ AGENT_MANAGER_TEST_FRAMEWORK_GATE: 'x' }), 'block');
});

test('testConventionsBlock: grounded in the repo, only for test-related tasks, one line per package', () => {
  tf.clearCache();
  const { d } = repo();
  const task = { title: 'Add unit tests for propertyType', promptContext: { rawText: 'Create a test file.' } };
  const block = tf.testConventionsBlock(d, task, ['TaxHarvest/backend/src/utils/propertyType.js', 'TaxHarvest/frontend/src/Toast.tsx']);
  assert.match(block, /TEST CONVENTIONS/);
  assert.match(block, /`TaxHarvest\/backend`: tests use node:test \(e\.g\. TaxHarvest\/backend\/counties\/_shared/);
  assert.match(block, /jest, vitest, @testing-library are NOT installed/);
  assert.match(block, /`TaxHarvest\/frontend`: NO test suite or runner exists here/);
  assert.match(block, /TypeScript\/React \(\.ts\/\.tsx\) tests cannot run/);
  assert.equal(tf.testConventionsBlock(d, { title: 'Rename a helper', promptContext: { rawText: 'no relation' } }, ['TaxHarvest/backend/src/a.js']), '', 'a task that has nothing to do with tests gets no block');
  assert.equal(tf.testConventionsBlock(d, task, []), '');
  assert.equal(tf.testConventionsBlock(d, task, ['../outside.js', '/abs/path.js']), '');
  const py = tf.testConventionsBlock(d, task, ['TaxHarvest/backend/python_services/worker_db.py']);
  assert.match(py, /\(Python\): tests use unittest/);
});
