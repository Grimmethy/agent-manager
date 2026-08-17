'use strict';

// Unit tests for model-provider.js's providerFor() -- the per-task-source backend
// selection that wires claude-client.js into ornith-draft.js/review-task.js. See
// AGENT_MANAGER_CLAUDE_SOURCES in that module's own header for the env var contract.

const test = require('node:test');
const assert = require('node:assert/strict');

function freshModelProvider() {
  delete require.cache[require.resolve('./model-provider.js')];
  delete require.cache[require.resolve('./claude-client.js')];
  delete require.cache[require.resolve('./ornith-client.js')];
  return require('./model-provider.js');
}

function withEnv(overrides, fn) {
  const prior = {};
  for (const key of Object.keys(overrides)) prior[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

test('providerFor defaults every source to ornith-client.js when AGENT_MANAGER_CLAUDE_SOURCES is unset -- opt-in, never a silent default switch', () => {
  withEnv({ AGENT_MANAGER_CLAUDE_SOURCES: undefined }, () => {
    const { providerFor } = freshModelProvider();
    const ornith = require('./ornith-client.js');
    assert.equal(providerFor('arch_import'), ornith);
    assert.equal(providerFor('observability_review'), ornith);
  });
});

test('providerFor routes exactly the listed sources to claude-client.js, leaves others on ornith', () => {
  withEnv({ AGENT_MANAGER_CLAUDE_SOURCES: 'arch_import, deep_dive' }, () => {
    const { providerFor } = freshModelProvider();
    const ornith = require('./ornith-client.js');
    const claude = require('./claude-client.js');
    assert.equal(providerFor('arch_import'), claude);
    assert.equal(providerFor('deep_dive'), claude);
    assert.equal(providerFor('observability_review'), ornith, 'unlisted sources must stay on the local model');
  });
});

test('providerFor tolerates stray whitespace in the env var list', () => {
  withEnv({ AGENT_MANAGER_CLAUDE_SOURCES: ' arch_import ,, deep_dive ' }, () => {
    const { providerFor } = freshModelProvider();
    const claude = require('./claude-client.js');
    assert.equal(providerFor('arch_import'), claude);
    assert.equal(providerFor('deep_dive'), claude);
  });
});

test('each provider exposes call and majorityVote (the two injection-point shapes ornith-draft.js/review-task.js rely on)', () => {
  const { providerFor } = freshModelProvider();
  for (const provider of [providerFor('anything'), providerFor('')]) {
    assert.equal(typeof provider.call, 'function');
    assert.equal(typeof provider.majorityVote, 'function');
  }
});
