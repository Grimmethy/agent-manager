'use strict';

// Unit tests for model-provider.js's providerFor() -- the per-task-source backend
// selection that wires claude-client.js into ornith-draft.js/review-task.js. See
// AGENT_MANAGER_CLAUDE_SOURCES in that module's own header for the env var contract.

const test = require('node:test');
const assert = require('node:assert/strict');

function freshModelProvider() {
  delete require.cache[require.resolve('./model-provider.js')];
  delete require.cache[require.resolve('./claude-client.js')];
  delete require.cache[require.resolve('./local-client.js')];
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
    const ornith = require('./local-client.js');
    assert.equal(providerFor('arch_import'), ornith);
    assert.equal(providerFor('observability_review'), ornith);
  });
});

test('providerFor routes exactly the listed sources to claude-client.js, leaves others on ornith', () => {
  withEnv({ AGENT_MANAGER_CLAUDE_SOURCES: 'arch_import, deep_dive' }, () => {
    const { providerFor } = freshModelProvider();
    const ornith = require('./local-client.js');
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

// --- reasoningTierFor (Brain Dump #77: generalized worker-tier concept, replacing the
// earlier adhoc-hardcoded lane filter) ----------------------------------------------------

test('reasoningTierFor: a per-instance task.reasoningTier override wins over everything else', () => {
  withEnv({ AGENT_MANAGER_CLAUDE_SOURCES: undefined }, () => {
    const { reasoningTierFor } = freshModelProvider();
    assert.equal(reasoningTierFor({ source: 'path_prefetch_resolve', reasoningTier: 'high' }), 'high');
  });
});

test('reasoningTierFor: falls back to the registered source\'s static reasoningTier', () => {
  const { reasoningTierFor } = freshModelProvider();
  const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');
  clearRegistry();
  try {
    registerTaskSource('arch_import', { reasoningTier: 'high' });
    assert.equal(reasoningTierFor({ source: 'arch_import' }), 'high');
    assert.equal(reasoningTierFor({ source: 'unregistered_source' }), 'low');
  } finally {
    clearRegistry();
  }
});

test('reasoningTierFor: falls back to AGENT_MANAGER_CLAUDE_SOURCES when no override/static tier is set', () => {
  withEnv({ AGENT_MANAGER_CLAUDE_SOURCES: 'arch_import' }, () => {
    const { reasoningTierFor } = freshModelProvider();
    assert.equal(reasoningTierFor({ source: 'arch_import' }), 'high');
    assert.equal(reasoningTierFor({ source: 'observability_review' }), 'low');
  });
});

test('reasoningTierFor: defaults to low with no override, static tier, or env var', () => {
  withEnv({ AGENT_MANAGER_CLAUDE_SOURCES: undefined }, () => {
    const { reasoningTierFor } = freshModelProvider();
    assert.equal(reasoningTierFor({ source: 'observability_review' }), 'low');
  });
});

test('reasoningTierFor: accepts a bare source-name string, same as providerFor/labelFor', () => {
  withEnv({ AGENT_MANAGER_CLAUDE_SOURCES: 'arch_import' }, () => {
    const { reasoningTierFor } = freshModelProvider();
    assert.equal(reasoningTierFor('arch_import'), 'high');
  });
});
