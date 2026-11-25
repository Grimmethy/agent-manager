'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub config.js through the require cache so pipelineDirForHistory() / runningRootForOwnerGuard()
// read a controlled config. Installed before the registry is loaded.
const configPath = require.resolve('../src/config.js');
let currentConfig = {};
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { getConfig: () => currentConfig },
};

const registry = require('../src/task-source-registry.js');
const { logPipelineEvent, LOG_FILENAME } = require('../src/pipeline-history.js');

const RUNNING_ROOT = '/this/root';
const OTHER_OWNER = '/not/this/root';

let savedEnv;
let tmpDirs;

function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-mismatch-'));
  tmpDirs.push(d);
  return d;
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  let result;
  try {
    result = fn();
  } finally {
    process.stderr.write = orig;
  }
  return { out, result };
}

// A source whose owners do not include the running root, so every next() call is an owner mismatch.
function mismatchedNext(name) {
  registry.clearRegistry();
  registry.registerTaskSource(name, { next: () => 'ran', owners: [OTHER_OWNER] });
  return registry.getRegisteredSource(name).next;
}

beforeEach(() => {
  savedEnv = process.env.AGENT_MANAGER_PIPELINE_DIR;
  delete process.env.AGENT_MANAGER_PIPELINE_DIR;
  tmpDirs = [];
  currentConfig = {};
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.AGENT_MANAGER_PIPELINE_DIR;
  else process.env.AGENT_MANAGER_PIPELINE_DIR = savedEnv;
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('logPipelineEvent returns true on a successful append', () => {
  const dir = mkTmp();
  assert.equal(logPipelineEvent(dir, 'probe', { a: 1 }), true);
  assert.ok(fs.existsSync(path.join(dir, 'instances', LOG_FILENAME)));
});

test('logPipelineEvent returns false when the directory is unwritable', () => {
  const dir = mkTmp();
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  assert.equal(logPipelineEvent(blocker, 'probe', {}), false);
});

test('logPipelineEvent returns false (and does not throw) when no directory is given', () => {
  assert.equal(logPipelineEvent(null, 'probe', {}), false);
});

test('no pipeline directory resolved: warns on stderr, gate returns null, nothing throws', () => {
  currentConfig = { repoRoot: null, pipelineDir: undefined };
  const next = mismatchedNext('src-no-dir');
  const { out, result } = captureStderr(() => next());
  assert.equal(result, null);
  assert.match(out, /\[owner-mismatch\] source "src-no-dir": no pipeline directory resolved/);
  assert.match(out, /NOT recorded/);
});

test('unwritable pipeline directory: warns on stderr, gate returns null, nothing throws', () => {
  const dir = mkTmp();
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  currentConfig = { repoRoot: RUNNING_ROOT, pipelineDir: blocker };
  const next = mismatchedNext('src-unwritable');
  const { out, result } = captureStderr(() => next());
  assert.equal(result, null);
  assert.match(out, /\[owner-mismatch\] source "src-unwritable": failed to write owner-mismatch event/);
  assert.match(out, /NOT recorded/);
});

test('writable pipeline directory: no warning, and the owner-mismatch event is written', () => {
  const dir = mkTmp();
  currentConfig = { repoRoot: RUNNING_ROOT, pipelineDir: dir };
  const next = mismatchedNext('src-writable');
  const { out, result } = captureStderr(() => next());
  assert.equal(result, null);
  assert.equal(out, '');
  const lines = fs.readFileSync(path.join(dir, 'instances', LOG_FILENAME), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const ev = lines.find((e) => e.type === 'owner-mismatch');
  assert.ok(ev, 'owner-mismatch event written');
  assert.equal(ev.source, 'src-writable');
  assert.equal(ev.reason, 'owner-mismatch');
});
