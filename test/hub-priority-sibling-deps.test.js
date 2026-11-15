'use strict';

// hubHasUnmergedEarlierSibling(pipelineDir, task, hubRecord): sibling-dependency gating for hub children.
// Every test passes the hub record directly. Sibling task records live in <tmp>/queue/done/<id>.json so the
// stacked-branch lookup (siblingIsOnStackedBranch) can find them, and the hub record is also mirrored to
// <tmp>/queue/coordinating/<hubId>.json to match the on-disk layout.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hubHasUnmergedEarlierSibling } = require('../src/hub-priority.js');

const HUB_ID = 'hub-0409';

// Runs fn against a fresh temp pipelineDir and removes it afterwards.
function withPipeline(fn) {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sibdeps-test-'));
  try {
    fs.mkdirSync(path.join(pipelineDir, 'queue', 'done'), { recursive: true });
    fs.mkdirSync(path.join(pipelineDir, 'queue', 'coordinating'), { recursive: true });
    return fn(pipelineDir);
  } finally {
    fs.rmSync(pipelineDir, { recursive: true, force: true });
  }
}

// Writes a sibling's own task record (queue/done/<id>.json). `branch` sets stacked.branch when given.
function writeSibling(pipelineDir, id, branch = null) {
  const rec = { id, title: id };
  if (branch) rec.stacked = { branch };
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'done', `${id}.json`), JSON.stringify(rec));
}

// Builds the hub record { id, subTasks: [{ id, status }] } and mirrors it to queue/coordinating.
function makeHub(pipelineDir, subTasks) {
  const hub = { id: HUB_ID, subTasks: subTasks.map(([id, status]) => ({ id, status })) };
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'coordinating', `${HUB_ID}.json`), JSON.stringify(hub));
  return hub;
}

function childTask(id, extra = {}) {
  return { id, title: id, parentHub: HUB_ID, ...extra };
}

test('(a) a stacked child on branch B is blocked by an unresolved earlier sibling on B', () => {
  withPipeline((pipelineDir) => {
    writeSibling(pipelineDir, 'sib-0', 'B');
    writeSibling(pipelineDir, 'child', 'B');
    const hub = makeHub(pipelineDir, [['sib-0', 'review'], ['child', 'pending']]);
    const task = childTask('child', { stacked: { branch: 'B' } });
    const result = hubHasUnmergedEarlierSibling(pipelineDir, task, hub);
    assert.equal(result.blocked, true);
    assert.equal(result.blockingSiblingId, 'sib-0');
  });
});

test('(b) an unstacked child with no dependsOn is not blocked by an unresolved earlier sibling', () => {
  withPipeline((pipelineDir) => {
    writeSibling(pipelineDir, 'sib-0', 'B');
    writeSibling(pipelineDir, 'child');
    const hub = makeHub(pipelineDir, [['sib-0', 'review'], ['child', 'pending']]);
    const task = childTask('child');
    assert.deepEqual(hubHasUnmergedEarlierSibling(pipelineDir, task, hub), { blocked: false });
  });
});

test('(c) a child whose dependsOn names an unresolved earlier sibling is blocked until that sibling resolves', () => {
  withPipeline((pipelineDir) => {
    writeSibling(pipelineDir, 'sib-0');
    writeSibling(pipelineDir, 'child');
    const hub = makeHub(pipelineDir, [['sib-0', 'review'], ['child', 'pending']]);
    const task = childTask('child', { dependsOn: ['sib-0'] });

    const blockedResult = hubHasUnmergedEarlierSibling(pipelineDir, task, hub);
    assert.equal(blockedResult.blocked, true);
    assert.equal(blockedResult.blockingSiblingId, 'sib-0');

    hub.subTasks[0].status = 'merged';
    assert.deepEqual(hubHasUnmergedEarlierSibling(pipelineDir, task, hub), { blocked: false });
  });
});

test('(d) the first child in the hub is not blocked', () => {
  withPipeline((pipelineDir) => {
    writeSibling(pipelineDir, 'child', 'B');
    const hub = makeHub(pipelineDir, [['child', 'pending'], ['sib-1', 'pending']]);
    const task = childTask('child', { stacked: { branch: 'B' }, dependsOn: ['sib-1'] });
    assert.deepEqual(hubHasUnmergedEarlierSibling(pipelineDir, task, hub), { blocked: false });
  });
});

test('(e) a pending-merge sibling on the same stacked branch does not block', () => {
  withPipeline((pipelineDir) => {
    writeSibling(pipelineDir, 'sib-0', 'B');
    writeSibling(pipelineDir, 'child', 'B');
    const hub = makeHub(pipelineDir, [['sib-0', 'pending-merge'], ['child', 'pending']]);
    const task = childTask('child', { stacked: { branch: 'B' } });
    assert.deepEqual(hubHasUnmergedEarlierSibling(pipelineDir, task, hub), { blocked: false });
  });
});
