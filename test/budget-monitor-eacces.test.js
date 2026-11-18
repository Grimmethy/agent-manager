'use strict';

// Regression test: a permission-denied subdirectory under the projects dir must not make
// listJsonlFiles() or isBudgetHealthy() throw. The walk fails open and returns the
// readable files it found.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-eacces-'));
const projectsDir = path.join(root, 'projects');
const readableFile = path.join(projectsDir, 'a.jsonl');
const lockedDir = path.join(projectsDir, 'locked');
const lockedFile = path.join(lockedDir, 'b.jsonl');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.BUDGET_MONITOR_CACHE_PATH = path.join(root, 'cache.json');
const bm = require('../budget-monitor.js');

test.before(() => {
  fs.mkdirSync(lockedDir, { recursive: true });
  fs.writeFileSync(readableFile, '');
  fs.writeFileSync(lockedFile, '');
  fs.chmodSync(lockedDir, 0o000);
});

test.after(() => {
  try { fs.chmodSync(lockedDir, 0o755); } catch { /* may not exist */ }
  fs.rmSync(root, { recursive: true, force: true });
});

test('listJsonlFiles does not throw on a chmod 000 subdirectory and still returns readable files', { skip: isRoot && 'root bypasses permission bits' }, () => {
  let files;
  assert.doesNotThrow(() => { files = bm.listJsonlFiles(projectsDir); });
  assert.ok(files.includes(readableFile), `expected ${readableFile} in ${JSON.stringify(files)}`);
  assert.ok(!files.includes(lockedFile), 'unreadable subdirectory contents must not be listed');
});

test('isBudgetHealthy does not throw when a subdirectory is unreadable', { skip: isRoot && 'root bypasses permission bits' }, () => {
  assert.doesNotThrow(() => bm.isBudgetHealthy());
});
