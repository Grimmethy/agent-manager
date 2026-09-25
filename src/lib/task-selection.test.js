'use strict';

// premiumPriority must affect GENERATION, not just claim-time ranking (2026-09-25 live
// incident): with AGENT_MANAGER_TASK_PRIORITIES putting adhoc:40, the hygiene family
// (priority 1-29) never went dry, so adhoc was starved at the source-level priority walk
// in getNextTask() and a premiumPriority-true adhoc task (plus its decomposed sub-tasks)
// sat in queue/adhoc/ untouched for 30-90+ minutes. nextAdhocLikeTask() already sorts
// premiumPriority to the front of adhoc's OWN candidates, and next-claimable-task.js's
// effectivePriority() ranks premium -Infinity at CLAIM time -- but neither helps if adhoc
// as a source never gets a turn to generate. These tests pin the fix: a premium file in
// queue/adhoc/ or queue/derived/ must be generated immediately, ahead of any
// higher-configured-priority source, regardless of the registry ordering.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskSources = require('../task-sources.js'); // load for its real generators (nextAdhocTask / nextDerivedTask)
const { clearRegistry, registerTaskSource } = require('../task-source-registry.js');
const { getNextTask } = require('./task-selection.js');

function withRepo(root, fn) {
  const saved = { r: process.env.AGENT_MANAGER_REPO_ROOT, p: process.env.AGENT_MANAGER_PIPELINE_DIR };
  process.env.AGENT_MANAGER_REPO_ROOT = root;
  process.env.AGENT_MANAGER_PIPELINE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'premium-gen-'));
  try {
    return fn(process.env.AGENT_MANAGER_PIPELINE_DIR);
  } finally {
    for (const [k, v] of [['AGENT_MANAGER_REPO_ROOT', saved.r], ['AGENT_MANAGER_PIPELINE_DIR', saved.p]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// The exact live shape: a higher-configured-priority source (priority 1 -- e.g. arch_review)
// has a real candidate ready, while adhoc (priority 40) / derived_task (priority 48) only
// have the premium-flagged item waiting.
function registerFakes() {
  clearRegistry();
  registerTaskSource('probe_hygiene', { priority: 1, next: () => ({ id: 'probe-hygiene', title: 'hygiene candidate' }) });
  registerTaskSource('adhoc', { priority: 40, next: taskSources.nextAdhocTask });
  registerTaskSource('derived_task', { priority: 48, next: taskSources.nextDerivedTask });
}

function writeTask(pipelineDir, dir, name, body) {
  const full = path.join(pipelineDir, 'queue', dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(body));
}

test('premiumPriority adhoc (configured priority 40) generates ahead of a priority-1 source with a ready candidate', () => {
  withRepo(os.tmpdir(), (pipelineDir) => {
    registerFakes();
    writeTask(pipelineDir, 'adhoc', 'premium-adhoc.json', { id: 'premium-adhoc', title: 'premium adhoc', premiumPriority: true });
    const task = getNextTask();
    assert.equal(task.id, 'premium-adhoc', 'the premium adhoc task must win even though adhoc is registered at priority 40');
  });
  clearRegistry();
});

test('premiumPriority derived (configured priority 48) generates ahead of a priority-1 source', () => {
  withRepo(os.tmpdir(), (pipelineDir) => {
    registerFakes();
    writeTask(pipelineDir, 'derived', 'premium-derived.json', { id: 'premium-derived', title: 'premium derived', premiumPriority: true });
    const task = getNextTask();
    assert.equal(task.id, 'premium-derived', 'the premium derived_task must win even though derived_task is registered at priority 48');
  });
  clearRegistry();
});

test('no premiumPriority file: the normal priority walk is preserved (priority-1 source still wins)', () => {
  withRepo(os.tmpdir(), (pipelineDir) => {
    registerFakes();
    writeTask(pipelineDir, 'adhoc', 'plain-adhoc.json', { id: 'plain-adhoc', title: 'plain adhoc' });
    writeTask(pipelineDir, 'derived', 'plain-derived.json', { id: 'plain-derived', title: 'plain derived' });
    const task = getNextTask();
    assert.equal(task.id, 'probe-hygiene', 'without the premium flag, the lower-number (higher-ranked) source wins as before');
  });
  clearRegistry();
});

test('an unreadable file in queue/adhoc/ does not crash generation and does not preempt', () => {
  withRepo(os.tmpdir(), (pipelineDir) => {
    registerFakes();
    const dir = path.join(pipelineDir, 'queue', 'adhoc');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{ not json');
    const task = getNextTask();
    assert.equal(task.id, 'probe-hygiene', 'a corrupt file must be skipped, not treated as premium and not crash the walk');
  });
  clearRegistry();
});
