'use strict';

// Unit tests for model-provider.js's providerFor() -- the per-task-source backend
// selection that wires claude-client.js into local-draft.js/review-task.js. See
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

test('providerFor defaults every source to local-client.js when AGENT_MANAGER_CLAUDE_SOURCES is unset -- opt-in, never a silent default switch', () => {
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

test('each provider exposes call and majorityVote (the two injection-point shapes local-draft.js/review-task.js rely on)', () => {
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

// --- resolveModelProfile / providerFor / labelFor precedence (2026-08-24,
// model-profile-registry.js: forced > profile > tier-default) --------------------------

function withRegisteredProfile(taskSourceConfig, profileConfig, fn) {
  const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');
  const { clearModelProfileRegistry, registerModelProfile } = require('./model-profile-registry.js');
  clearRegistry();
  clearModelProfileRegistry();
  try {
    registerTaskSource('observability_review', taskSourceConfig);
    if (profileConfig) registerModelProfile(taskSourceConfig.modelProfile, profileConfig);
    return fn();
  } finally {
    clearRegistry();
    clearModelProfileRegistry();
  }
}

test('resolveModelProfile returns the registered profile for a source that declares modelProfile', () => {
  withRegisteredProfile(
    { modelProfile: 'cheap-local' },
    { backend: 'local', model: 'qwen2.5:3b', numCtx: 8192 },
    () => {
      const { resolveModelProfile } = freshModelProvider();
      const profile = resolveModelProfile({ source: 'observability_review' });
      assert.equal(profile.backend, 'local');
      assert.equal(profile.model, 'qwen2.5:3b');
    },
  );
});

test('resolveModelProfile returns null when the source declares no modelProfile', () => {
  withRegisteredProfile({}, null, () => {
    const { resolveModelProfile } = freshModelProvider();
    assert.equal(resolveModelProfile({ source: 'observability_review' }), null);
  });
});

test('resolveModelProfile returns null (fails open) when the declared profile name is not actually registered -- no throw', () => {
  withRegisteredProfile({ modelProfile: 'does-not-exist' }, null, () => {
    const { resolveModelProfile } = freshModelProvider();
    assert.equal(resolveModelProfile({ source: 'observability_review' }), null);
  });
});

test('resolveModelProfile returns null when AGENT_MANAGER_FORCE_PROVIDER is set -- a human override always wins outright, a profile never overrides it', () => {
  withEnv({ AGENT_MANAGER_FORCE_PROVIDER: 'local' }, () => {
    withRegisteredProfile(
      { modelProfile: 'cheap-local' },
      { backend: 'claude', model: 'claude:opus' },
      () => {
        const { resolveModelProfile } = freshModelProvider();
        assert.equal(resolveModelProfile({ source: 'observability_review' }), null);
      },
    );
  });
});

test('providerFor routes to the profile\'s own backend, overriding the source\'s normal reasoningTier-based default', () => {
  withRegisteredProfile(
    { modelProfile: 'claude-review', reasoningTier: 'low' }, // normally local, per its own static tier
    { backend: 'claude', model: 'claude:opus' },
    () => {
      const { providerFor } = freshModelProvider();
      const claude = require('./claude-client.js');
      assert.equal(providerFor({ source: 'observability_review' }), claude);
    },
  );
});

test('providerFor falls back to today\'s tier-based default when no profile is registered for the source', () => {
  withRegisteredProfile({}, null, () => {
    const { providerFor } = freshModelProvider();
    const ornith = require('./local-client.js');
    assert.equal(providerFor({ source: 'observability_review' }), ornith);
  });
});

test('labelFor reflects the profile\'s own model name, not LOCAL_MODEL, when a profile is registered', () => {
  withEnv({ LOCAL_MODEL: 'qwen3.8:27b-q4_K_M' }, () => {
    withRegisteredProfile(
      { modelProfile: 'cheap-local' },
      { backend: 'local', model: 'qwen2.5:3b' },
      () => {
        const { labelFor } = freshModelProvider();
        assert.equal(labelFor({ source: 'observability_review' }), 'qwen2.5:3b');
      },
    );
  });
});
