'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'mutation-check.js');

function runMutationCheck(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd,
    env: process.env,
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-test-'));
}

function writeMutationFile(dir, mutations) {
  const fp = path.join(dir, 'mutations.json');
  fs.writeFileSync(fp, JSON.stringify(mutations, null, 2));
  return fp;
}

function writeFile(dir, name, content) {
  const fp = path.join(dir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
  return fp;
}

test('killed mutation: test fails after mutation, exit code 0', () => {
  const dir = tmpDir();
  writeFile(dir, 'app.js', 'function hello() { return "original"; }');

  // Create a test script that checks for the original string
  const testScript = path.join(dir, 'test.js');
  fs.writeFileSync(testScript, `
    const fs = require('fs');
    const content = fs.readFileSync('app.js', 'utf8');
    if (content.includes('original')) {
      process.exit(0); // pass: original found
    } else {
      process.exit(1); // fail: original not found (mutation applied)
    }
  `);

  const mutFile = writeMutationFile(dir, [
    { name: 'kill-func', file: 'app.js', find: 'original', replace: 'mutated' },
  ]);

  const r = runMutationCheck([
    '--test', `node ${path.join(dir, 'test.js')}`,
    '--cwd', dir,
    '--mutations', mutFile,
  ], dir);

  assert.equal(r.status, 0, `Expected exit 0 (killed), got ${r.status}: ${r.stderr}`);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const resultLine = lines.find(l => {
    try { const p = JSON.parse(l); return p.name === 'kill-func'; } catch { return false; }
  });
  assert.ok(resultLine, 'Should have result line for kill-func');
  const parsed = JSON.parse(resultLine);
  assert.equal(parsed.name, 'kill-func');
  assert.equal(parsed.outcome, 'killed');
  assert.equal(parsed.failing, false);

  // Verify file is restored
  const restored = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  assert.equal(restored, 'function hello() { return "original"; }', 'File should be restored');
});

test('survived mutation: test passes after mutation, exit code 1', () => {
  const dir = tmpDir();
  writeFile(dir, 'app.js', 'const x = 1;');
  const mutFile = writeMutationFile(dir, [
    { name: 'survive-const', file: 'app.js', find: '1', replace: '2' },
  ]);

  // Test: always passes (just checks file exists)
  const testScript = path.join(dir, 'test.js');
  fs.writeFileSync(testScript, `
    const fs = require('fs');
    if (fs.existsSync('app.js')) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  `);

  const r = runMutationCheck([
    '--test', `node ${path.join(dir, 'test.js')}`,
    '--cwd', dir,
    '--mutations', mutFile,
  ], dir);

  assert.equal(r.status, 1, `Expected exit 1 (survived), got ${r.status}: ${r.stderr}`);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const resultLine = lines.find(l => {
    try { const p = JSON.parse(l); return p.name === 'survive-const'; } catch { return false; }
  });
  assert.ok(resultLine, 'Should have result line for survive-const');
  const parsed = JSON.parse(resultLine);
  assert.equal(parsed.name, 'survive-const');
  assert.equal(parsed.outcome, 'survived');
  assert.equal(parsed.failing, true);

  // Verify file is restored
  const restored = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  assert.equal(restored, 'const x = 1;', 'File should be restored');
});

test('mutation with find not present: outcome is survived', () => {
  const dir = tmpDir();
  writeFile(dir, 'app.js', 'const x = 1;');
  const mutFile = writeMutationFile(dir, [
    { name: 'no-find', file: 'app.js', find: 'nonexistent', replace: 'replaced' },
  ]);

  // Test: checks that file exists (will pass whether mutated or not)
  const testScript = path.join(dir, 'test.js');
  fs.writeFileSync(testScript, `
    const fs = require('fs');
    process.exit(fs.existsSync('app.js') ? 0 : 1);
  `);

  const r = runMutationCheck([
    '--test', `node ${path.join(dir, 'test.js')}`,
    '--cwd', dir,
    '--mutations', mutFile,
  ], dir);

  assert.equal(r.status, 1, `Expected exit 1 (survived), got ${r.status}: ${r.stderr}`);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const resultLine = lines.find(l => {
    try { const p = JSON.parse(l); return p.name === 'no-find'; } catch { return false; }
  });
  assert.ok(resultLine, 'Should have result line for no-find');
  const parsed = JSON.parse(resultLine);
  assert.equal(parsed.name, 'no-find');
  assert.equal(parsed.outcome, 'survived');
});

test('baseline red: test fails before mutations, exit code 2', () => {
  const dir = tmpDir();
  writeFile(dir, 'app.js', 'const x = 1;');
  const mutFile = writeMutationFile(dir, [
    { name: 'test-mutation', file: 'app.js', find: '1', replace: '2' },
  ]);

  // Test: always fails
  const testScript = path.join(dir, 'test.js');
  fs.writeFileSync(testScript, `
    process.exit(1);
  `);

  const r = runMutationCheck([
    '--test', `node ${path.join(dir, 'test.js')}`,
    '--cwd', dir,
    '--mutations', mutFile,
  ], dir);

  assert.equal(r.status, 2, `Expected exit 2 (baseline red), got ${r.status}: ${r.stderr}`);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const summaryLine = lines.find(l => {
    try { const p = JSON.parse(l); return p.type === 'summary' && p.baselineRed; } catch { return false; }
  });
  assert.ok(summaryLine, 'Should have baseline red summary');
  const parsed = JSON.parse(summaryLine);
  assert.equal(parsed.baselineRed, true);
});

test('timeout handling with file restoration', () => {
  const dir = tmpDir();
  writeFile(dir, 'app.js', 'const x = 1;');
  const mutFile = writeMutationFile(dir, [
    { name: 'timeout-test', file: 'app.js', find: '1', replace: 'SLEEP' },
  ]);

  // Test: checks for SLEEP flag, sleeps if found
  const testScript = path.join(dir, 'test.js');
  fs.writeFileSync(testScript, `
    const fs = require('fs');
    const content = fs.readFileSync('app.js', 'utf8');
    if (content.includes('SLEEP')) {
      require('child_process').execSync('sleep 10', { stdio: 'ignore' });
      process.exit(0);
    } else {
      process.exit(0);
    }
  `);

  const r = runMutationCheck([
    '--test', `node ${path.join(dir, 'test.js')}`,
    '--cwd', dir,
    '--mutations', mutFile,
    '--timeout-s', '1',
  ], dir);

  // Timeout is treated as killed (test failed)
  assert.equal(r.status, 0, `Expected exit 0 (timeout=killed), got ${r.status}: ${r.stderr}`);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const resultLine = lines.find(l => {
    try { const p = JSON.parse(l); return p.name === 'timeout-test'; } catch { return false; }
  });
  assert.ok(resultLine, 'Should have result line for timeout-test');
  const parsed = JSON.parse(resultLine);
  assert.equal(parsed.name, 'timeout-test');
  assert.equal(parsed.outcome, 'killed');

  // Verify file is restored
  const restored = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  assert.equal(restored, 'const x = 1;', 'File should be restored after timeout');
});

test('path outside --cwd refusal: NOOP outcome', () => {
  const dir = tmpDir();
  writeFile(dir, 'app.js', 'const x = 1;');
  const mutFile = writeMutationFile(dir, [
    { name: 'path-escape', file: '/etc/passwd', find: 'root', replace: 'hacked' },
  ]);

  // Test: always passes
  const testScript = path.join(dir, 'test.js');
  fs.writeFileSync(testScript, `
    process.exit(0);
  `);

  const r = runMutationCheck([
    '--test', `node ${path.join(dir, 'test.js')}`,
    '--cwd', dir,
    '--mutations', mutFile,
  ], dir);

  assert.equal(r.status, 0, `Expected exit 0, got ${r.status}: ${r.stderr}`);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const resultLine = lines.find(l => {
    try { const p = JSON.parse(l); return p.name === 'path-escape'; } catch { return false; }
  });
  assert.ok(resultLine, 'Should have result line for path-escape');
  const parsed = JSON.parse(resultLine);
  assert.equal(parsed.name, 'path-escape');
  assert.equal(parsed.outcome, 'NOOP');
  assert.equal(parsed.failing, 'path-escape');
});
