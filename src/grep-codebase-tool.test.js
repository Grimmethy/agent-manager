'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { grepCodebase } = require('./grep-codebase-tool.js');

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-codebase-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'python'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'worker.js'), 'function draftTask(task) {\n  return reviewGate(task);\n}\n');
  fs.writeFileSync(path.join(dir, 'python', 'app.py'), 'def draft_task(task):\n    return review_gate(task)\n');
  return dir;
}

function withConfig(repoRoot, grepDirs, fn) {
  const prevRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  const prevDirs = process.env.AGENT_MANAGER_GREP_DIRS;
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_GREP_DIRS = grepDirs;
  try {
    return fn();
  } finally {
    if (prevRoot === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prevRoot;
    if (prevDirs === undefined) delete process.env.AGENT_MANAGER_GREP_DIRS; else process.env.AGENT_MANAGER_GREP_DIRS = prevDirs;
  }
}

test('grepCodebase finds an exact single-token substring match', () => {
  const dir = makeFixtureRepo();
  withConfig(dir, 'src,python', () => {
    const hits = grepCodebase({ query: 'draftTask', dir: 'src' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'src/worker.js');
  });
});

test('grepCodebase falls back to a token-AND match for a multi-word phrase query (plan prompts explicitly invite these)', () => {
  const dir = makeFixtureRepo();
  withConfig(dir, 'src,python', () => {
    // Not a literal substring anywhere -- the words appear on two different lines.
    const hits = grepCodebase({ query: 'draft review gate', dir: 'src' });
    assert.equal(hits.length, 0); // no single line contains all three tokens
    const hits2 = grepCodebase({ query: 'draft task', dir: 'src' });
    assert.equal(hits2.length, 1); // both tokens appear on the same line ("draftTask")
  });
});

test('grepCodebase searches .py files, not just JS/TS', () => {
  const dir = makeFixtureRepo();
  withConfig(dir, 'src,python', () => {
    const hits = grepCodebase({ query: 'draft_task', dir: 'python' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'python/app.py');
  });
});

test('grepCodebase refuses a dir not in the allowlist', () => {
  const dir = makeFixtureRepo();
  withConfig(dir, 'src', () => {
    assert.deepEqual(grepCodebase({ query: 'draft', dir: 'python' }), []);
  });
});

test('grepCodebase caps at MAX_MATCHES', () => {
  const dir = makeFixtureRepo();
  const lines = Array.from({ length: 30 }, () => 'const marker = 1;').join('\n');
  fs.writeFileSync(path.join(dir, 'src', 'many.js'), lines);
  withConfig(dir, 'src', () => {
    const hits = grepCodebase({ query: 'marker', dir: 'src' });
    assert.equal(hits.length, 20);
  });
});
