'use strict';

// The claim path must skip a pending task whose source is scope:'core' when sourceEligibleHere says the
// source is not eligible here -- including when the task names the source through a registered alias.

process.env.AGENT_MANAGER_QUEUE_CACHE = 'false'; // no tmpfs cache traffic from tests

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registryMod = require(path.join(__dirname, '..', 'src', 'task-source-registry.js'));
const scopeMod = require(path.join(__dirname, '..', 'src', 'lib', 'source-scope.js'));
const { pickClaimableTasks, pickNextPendingTask } = require(path.join(__dirname, '..', 'src', 'next-claimable-task.js'));
const { loadSourceRegistry } = require(path.join(__dirname, '..', 'src', 'workflow-priority.js'));

const CORE = 'zz_core_claim_test_source';
const ALIAS = 'zz_core_claim_test_alias';
const INSTANCE = 'core-claim-test-lane';

let root;
let pendingDir;
let saved;
let calls;

function opts() {
  return { lanes: [], graceMs: 0, instancesDir: path.join(root, 'instances'), nodeId: undefined };
}

function writeTask(name, source) {
  fs.writeFileSync(path.join(pendingDir, name), JSON.stringify({ id: name.replace(/\.json$/, ''), source, title: 't' }));
}

function snapshot() {
  const out = {};
  for (const f of fs.readdirSync(pendingDir).sort()) out[f] = fs.readFileSync(path.join(pendingDir, f), 'utf8');
  return out;
}

function stubEligible(value) {
  calls = [];
  scopeMod.sourceEligibleHere = (entry, coreActive) => { calls.push({ entry, coreActive }); return value; };
}

test.beforeEach(() => {
  loadSourceRegistry(); // load the built-in sources first so our registration is not disturbed
  saved = { eligible: scopeMod.sourceEligibleHere, active: scopeMod.activeRepoIsCore };
  scopeMod.activeRepoIsCore = () => false;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-claim-'));
  pendingDir = path.join(root, 'queue', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  if (!registryMod.getRegisteredSource(CORE)) registryMod.registerTaskSource(CORE, { scope: 'core', priority: 1, next: () => null });
  registryMod.registerSourceAlias(ALIAS, CORE);
});

test.afterEach(() => {
  scopeMod.sourceEligibleHere = saved.eligible;
  scopeMod.activeRepoIsCore = saved.active;
  fs.rmSync(root, { recursive: true, force: true });
});

test('core task is not claimed when sourceEligibleHere is false; state unchanged', () => {
  writeTask('core-1.json', CORE);
  const before = snapshot();
  stubEligible(false);
  assert.equal(pickNextPendingTask(pendingDir, INSTANCE), null);
  assert.deepEqual(pickClaimableTasks(pendingDir, INSTANCE, opts()), []);
  assert.ok(calls.length > 0, 'gate consulted the eligibility predicate');
  assert.equal(calls[0].entry.scope, 'core');
  assert.equal(calls[0].coreActive, false);
  assert.deepEqual(snapshot(), before);
});

test('core task is claimed when sourceEligibleHere is true', () => {
  writeTask('core-1.json', CORE);
  const before = snapshot();
  stubEligible(true);
  assert.equal(pickNextPendingTask(pendingDir, INSTANCE), 'core-1.json');
  assert.deepEqual(pickClaimableTasks(pendingDir, INSTANCE, opts()), ['core-1.json']);
  assert.deepEqual(snapshot(), before);
});

test('core task named through a registered alias is gated the same way', () => {
  assert.equal(registryMod.resolveSourceName({ source: ALIAS }), CORE);
  writeTask('alias-1.json', ALIAS);
  const before = snapshot();

  stubEligible(false);
  assert.equal(pickNextPendingTask(pendingDir, INSTANCE), null);
  assert.ok(calls.length > 0, 'alias resolved to the core source and hit the gate');
  assert.deepEqual(snapshot(), before);

  stubEligible(true);
  assert.equal(pickNextPendingTask(pendingDir, INSTANCE), 'alias-1.json');
  assert.deepEqual(snapshot(), before);
});
