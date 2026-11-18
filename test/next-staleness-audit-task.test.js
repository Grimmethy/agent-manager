'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { titleHasFileLineRef } = require('../src/staleness-audit.js');
const { nextStalenessAuditTask } = require('../src/task-sources.js');

const ENV_KEYS = ['AGENT_MANAGER_REPO_ROOT', 'AGENT_MANAGER_PIPELINE_DIR', 'AGENT_MANAGER_STALENESS_AUDIT_COVERAGE_PATH'];
const SIXTY_DAYS_MS = 60 * 86400000;

// Points getConfig() at a throwaway pipeline dir for one test, then restores the env.
function withPipeline(fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-audit-task-'));
  const blockedDir = path.join(root, 'queue', 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  const coveragePath = path.join(root, 'staleness-audit-coverage.json');
  process.env.AGENT_MANAGER_REPO_ROOT = root;
  process.env.AGENT_MANAGER_PIPELINE_DIR = root;
  process.env.AGENT_MANAGER_STALENESS_AUDIT_COVERAGE_PATH = coveragePath;
  try {
    return fn({ blockedDir, coveragePath });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeBlockedTask(dir, id, title) {
  const createdAt = new Date(Date.now() - SIXTY_DAYS_MS).toISOString();
  const task = { id, domain: 'adhoc', source: 'adhoc', title, createdAt, status: 'blocked', blockedReason: 'test' };
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(task, null, 2));
}

test('title gate: v1.2:3 is not a file:line ref, src/foo.js:12 is', () => {
  assert.strictEqual(titleHasFileLineRef('v1.2:3'), false);
  assert.strictEqual(titleHasFileLineRef('src/foo.js:12'), true);
});

test('abstract title: nextStalenessAuditTask does not throw and does not re-pick the candidate', () => {
  withPipeline(({ blockedDir, coveragePath }) => {
    writeBlockedTask(blockedDir, 'abstract-ac-34', 'AC-34 - Add a metrics counter');
    assert.doesNotThrow(() => nextStalenessAuditTask());
    assert.strictEqual(nextStalenessAuditTask(), null);
    const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
    assert.ok(coverage['abstract-ac-34'], 'candidate should be marked covered');
    assert.match(coverage['abstract-ac-34'].reason, /file:line/);
  });
});

test('grounded title: nextStalenessAuditTask returns a task with a non-empty id', () => {
  withPipeline(({ blockedDir }) => {
    writeBlockedTask(blockedDir, 'grounded-1', 'Fix null check in src/foo.js:12');
    const task = nextStalenessAuditTask();
    assert.ok(task, 'expected a staleness_audit task');
    assert.strictEqual(typeof task.id, 'string');
    assert.ok(task.id.length > 0);
  });
});
