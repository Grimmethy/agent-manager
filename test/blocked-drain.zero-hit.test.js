'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Load blocked-drain with its collaborators stubbed. blocked-drain destructures its imports at
// load time, so the stubs must be in place before it is required.
function loadDrain() {
  const attribution = require('../src/requeue-attribution.js');
  const selfAudit = require('../src/pipeline-self-audit.js');
  const saved = {
    rec: attribution.recordSuppression,
    cls: attribution.classifyRequeue,
    sig: selfAudit.signatureForTask,
  };
  const suppressed = [];
  attribution.recordSuppression = (task) => { suppressed.push(task.id); };
  attribution.classifyRequeue = async () => {};
  selfAudit.signatureForTask = () => 'SIG';
  delete require.cache[require.resolve('../src/blocked-drain.js')];
  let mod;
  try {
    mod = require('../src/blocked-drain.js');
  } finally {
    attribution.recordSuppression = saved.rec;
    attribution.classifyRequeue = saved.cls;
    selfAudit.signatureForTask = saved.sig;
  }
  return { requeue: mod.requeueBlockedTasksForSignature, suppressed };
}

function makeTask(id, zeroHit) {
  return {
    id,
    domain: 'test',
    source: 'test',
    title: id,
    status: 'blocked',
    promptContext: {},
    history: zeroHit
      ? [{ stage: 'harness-search', at: '2026-01-01T00:00:00Z', detail: '0 hit(s) for "q"' }]
      : [],
  };
}

// files: [{ name, task }] written into queue/blocked/.
function setup(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-drain-zh-'));
  const blocked = path.join(root, 'queue', 'blocked');
  fs.mkdirSync(blocked, { recursive: true });
  for (const f of files) {
    fs.writeFileSync(path.join(blocked, f.name), JSON.stringify(f.task));
  }
  return root;
}

// Task ids of every JSON file in a queue dir. Matching by id keeps the assertions independent
// of the filenames each fixture chooses.
function idsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).id);
}

function assertProtectedCase(files) {
  const root = setup(files);
  const { requeue, suppressed } = loadDrain();
  requeue(root, 'SIG', { dirs: ['blocked'] });

  const pendingIds = idsIn(path.join(root, 'queue', 'pending'));
  const blockedIds = idsIn(path.join(root, 'queue', 'blocked'));

  // The non-zero-hit task is requeued regardless of where it is listed.
  assert.ok(pendingIds.includes('T3'), 'non-zero-hit T3 must be requeued');
  assert.ok(!blockedIds.includes('T3'), 'non-zero-hit T3 must leave blocked/');

  // Exactly one of the two zero-hit tasks is requeued; the other stays in blocked/.
  const zPending = pendingIds.filter((id) => id.startsWith('Z'));
  const zBlocked = blockedIds.filter((id) => id.startsWith('Z'));
  assert.strictEqual(zPending.length, 1, 'exactly one zero-hit task requeued');
  assert.strictEqual(zBlocked.length, 1, 'one zero-hit task remains in blocked/');

  // The remaining zero-hit task is the one suppressed, and suppression is recorded exactly once.
  assert.deepStrictEqual(suppressed, zBlocked, 'the blocked zero-hit task is the one suppressed');
}

test('protected case: non-zero-hit listed after two zero-hit tasks is requeued', () => {
  assertProtectedCase([
    { name: 'z1.json', task: makeTask('Z1', true) },
    { name: 'z2.json', task: makeTask('Z2', true) },
    { name: 't3.json', task: makeTask('T3', false) },
  ]);
});

test('protected case holds when the non-zero-hit task is listed first', () => {
  assertProtectedCase([
    { name: 'a-t3.json', task: makeTask('T3', false) },
    { name: 'b-z1.json', task: makeTask('Z1', true) },
    { name: 'c-z2.json', task: makeTask('Z2', true) },
  ]);
});
