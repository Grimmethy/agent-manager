'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate every filesystem path this suite could touch before loading anything.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-recovery-home-'));
process.env.AGENT_MANAGER_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-recovery-state-'));

// The module keeps a per-instance 'registered' flag, so each test loads a fresh copy.
function freshRegister() {
  const file = require.resolve('./infra-recovery.js');
  delete require.cache[file];
  return require(file).registerInfraRecovery;
}

function fakes(initialList) {
  const state = { list: initialList.slice(), requeued: [], subscribed: [], handlers: [] };
  return {
    state,
    subscribe(name, handler) {
      state.subscribed.push(name);
      state.handlers.push({ name, handler });
    },
    requeue(id) {
      state.requeued.push(id);
    },
    waiting() {
      return state.list;
    },
  };
}

function fireEvent(state, name) {
  for (const h of state.handlers) {
    if (h.name === name) h.handler({});
  }
}

test('no requeue happens before the local-model-ready event', () => {
  const registerInfraRecovery = freshRegister();
  const f = fakes([]);
  registerInfraRecovery({ subscribe: f.subscribe, requeue: f.requeue, waiting: f.waiting });
  // Task becomes infra-held after registration; catch-up already ran on an empty list.
  f.state.list.push({ id: 'T-1', holdReason: 'infra-outage', blockKind: 'infra' });
  assert.deepEqual(f.state.requeued, []);
});

test('an infra-held task is requeued on the local-model-ready event, once', () => {
  const registerInfraRecovery = freshRegister();
  const f = fakes([]);
  registerInfraRecovery({ subscribe: f.subscribe, requeue: f.requeue, waiting: f.waiting });
  f.state.list.push({ id: 'T-1', holdReason: 'infra-outage', blockKind: 'infra' });
  fireEvent(f.state, 'local-model-ready');
  assert.deepEqual(f.state.requeued, ['T-1']);
});

test('content and design-question blocks stay blocked even with an infra-outage hold', () => {
  const registerInfraRecovery = freshRegister();
  const f = fakes([]);
  registerInfraRecovery({ subscribe: f.subscribe, requeue: f.requeue, waiting: f.waiting });
  // Held after registration, so only the event may act on them.
  f.state.list.push(
    { id: 'C-1', holdReason: 'infra-outage', blockKind: 'content' },
    { id: 'D-1', holdReason: 'infra-outage', blockKind: 'design-question' },
    { id: 'I-1', holdReason: 'infra-outage', blockKind: 'infra' },
  );
  fireEvent(f.state, 'local-model-ready');
  assert.deepEqual(f.state.requeued, ['I-1'], 'only the infra-held task may be requeued');
});

test('registering twice subscribes to local-model-ready exactly once', () => {
  const registerInfraRecovery = freshRegister();
  const f = fakes([]);
  registerInfraRecovery({ subscribe: f.subscribe, requeue: f.requeue, waiting: f.waiting });
  registerInfraRecovery({ subscribe: f.subscribe, requeue: f.requeue, waiting: f.waiting });
  assert.deepEqual(f.state.subscribed, ['local-model-ready']);
});
