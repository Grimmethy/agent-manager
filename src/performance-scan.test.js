'use strict';

// Unit tests for performance-scan.js, run against throwaway fixture files in a temp
// dir -- never against this repo's own source, same reasoning observability-scan.test.js
// documents (agent-manager's own code legitimately changes over time and isn't the
// thing under test here).
//
// Run: node --test src/performance-scan.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanProject, findLoopBodyIssues, findJsonDeepCloneAntipattern } = require('./performance-scan.js');

test('findLoopBodyIssues flags a synchronous fs call inside a for loop', () => {
  const text = 'function run(files) {\n  for (let i = 0; i < files.length; i++) {\n    const data = fs.readFileSync(files[i]);\n  }\n}\n';
  const findings = findLoopBodyIssues(text, 'a.js');
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes('sync-io-in-loop'));
});

test('findLoopBodyIssues flags an await inside a while loop', () => {
  const text = 'async function run(ids) {\n  while (ids.length) {\n    const id = ids.pop();\n    await fetchOne(id);\n  }\n}\n';
  const findings = findLoopBodyIssues(text, 'a.js');
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes('sequential-await-in-loop'));
});

test('findLoopBodyIssues does not flag a loop with no sync I/O or await', () => {
  const text = 'function run(items) {\n  for (let i = 0; i < items.length; i++) {\n    total += items[i].value;\n  }\n}\n';
  assert.deepEqual(findLoopBodyIssues(text, 'a.js'), []);
});

test('findLoopBodyIssues reports the loop-start line, not the offending call\'s own line', () => {
  const text = 'for (const f of files) {\n  const x = 1;\n  fs.existsSync(f);\n}\n';
  const findings = findLoopBodyIssues(text, 'a.js');
  assert.equal(findings.find((f) => f.rule === 'sync-io-in-loop').line, 1);
});

test('findJsonDeepCloneAntipattern flags JSON.parse(JSON.stringify(...))', () => {
  const text = 'const copy = JSON.parse(JSON.stringify(original));\n';
  const findings = findJsonDeepCloneAntipattern(text, 'a.js');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'json-deep-clone-antipattern');
});

test('findJsonDeepCloneAntipattern does not flag an unrelated JSON.parse call', () => {
  const text = 'const parsed = JSON.parse(rawString);\n';
  assert.deepEqual(findJsonDeepCloneAntipattern(text, 'a.js'), []);
});

test('scanProject combines loop and clone findings across scanned files', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-scan-test-'));
  fs.writeFileSync(
    path.join(repoRoot, 'worker.js'),
    'for (const f of files) {\n  fs.readFileSync(f);\n}\nconst copy = JSON.parse(JSON.stringify(state));\n',
  );

  const findings = scanProject(repoRoot, 'test-project');
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes('sync-io-in-loop'));
  assert.ok(rules.includes('json-deep-clone-antipattern'));
  for (const f of findings) {
    assert.equal(f.projectSlug, 'test-project');
    assert.equal(typeof f.scannedAt, 'string');
  }
});

test('scanProject only scans JS/TS extensions, ignoring non-JS source', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-scan-test-'));
  fs.writeFileSync(path.join(repoRoot, 'script.py'), 'for f in files:\n    open(f).read()\n');

  assert.deepEqual(scanProject(repoRoot, 'test-project'), []);
});
