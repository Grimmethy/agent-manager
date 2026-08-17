'use strict';

// Unit tests for claude-client.js. Mocks child_process.execFileSync (mutated on the
// real core module, restored after each test) rather than the local destructured
// binding, since claude-client.js resolves `execFileSync` at require time -- same
// "mutate the dependency before a fresh require" approach connectivity-check.test.js
// uses for its own module-level state.
//
// Ordering matters: the mock MUST be installed on child_process BEFORE claude-client.js
// is (re-)required, because `const { execFileSync } = require('child_process')` inside
// that module captures the reference once, at require time -- requiring fresh and only
// THEN installing the mock leaves the module holding the real execFileSync, which
// silently invokes the actual `claude` CLI. Every test below installs the mock first.
//
// call()'s retry-on-degenerate loop and majorityVote()'s tally logic are intentionally
// NOT re-tested here beyond what's needed to prove the wiring works -- they're verbatim
// copies of ornith-client.js's own (untested-in-isolation) implementations, and this
// file's job is proving claude-client.js's OWN new surface (subprocess invocation,
// auth guard, JSON parsing, env stripping) is correct.

const test = require('node:test');
const assert = require('node:assert/strict');
const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REAL_EXEC_FILE_SYNC = child_process.execFileSync;

function requireFreshClaudeClient() {
  delete require.cache[require.resolve('./claude-client.js')];
  delete require.cache[require.resolve('./ornith-client.js')];
  return require('./claude-client.js');
}

// Installs the mock, THEN requires claude-client.js fresh (so the module's own
// `const { execFileSync } = require('child_process')` captures the mock), runs `fn`
// with the fresh module, and always restores the real execFileSync afterward.
async function withMockedClient(mockFn, fn) {
  child_process.execFileSync = mockFn;
  try {
    const claudeClient = requireFreshClaudeClient();
    return await fn(claudeClient);
  } finally {
    child_process.execFileSync = REAL_EXEC_FILE_SYNC;
  }
}

async function withEnv(overrides, fn) {
  const prior = {};
  for (const key of Object.keys(overrides)) prior[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    // Must await here, not just `return fn()` -- a bare return lets `finally` run as
    // soon as fn() (an async function) hands back its pending promise, which can be
    // before its internal awaits (e.g. call()'s multi-iteration retry loop) actually
    // settle -- confirmed live: the retry test saw CLAUDE_CODE_OAUTH_TOKEN already
    // deleted by the 2nd loop iteration despite this function "setting" it above.
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

test('assertSubscriptionAuthAvailable throws a clear, actionable error when CLAUDE_CODE_OAUTH_TOKEN is unset', () => {
  withEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined }, () => {
    const { assertSubscriptionAuthAvailable } = requireFreshClaudeClient();
    assert.throws(() => assertSubscriptionAuthAvailable(), /CLAUDE_CODE_OAUTH_TOKEN is not set/);
    assert.throws(() => assertSubscriptionAuthAvailable(), /claude setup-token/);
  });
});

test('assertSubscriptionAuthAvailable does not throw when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
  withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, () => {
    const { assertSubscriptionAuthAvailable } = requireFreshClaudeClient();
    assert.doesNotThrow(() => assertSubscriptionAuthAvailable());
  });
});

test('callOnce refuses to spawn the CLI at all when CLAUDE_CODE_OAUTH_TOKEN is unset -- fails before touching child_process', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined }, async () => {
    let execCalled = false;
    await withMockedClient(
      () => { execCalled = true; return '{}'; },
      async ({ callOnce }) => {
        await assert.rejects(() => callOnce({ prompt: 'hi' }), /CLAUDE_CODE_OAUTH_TOKEN is not set/);
      },
    );
    assert.equal(execCalled, false, 'must not spawn claude -p without subscription auth configured');
  });
});

test('callOnce never passes --bare (bare mode ignores CLAUDE_CODE_OAUTH_TOKEN entirely, per the CLI docs)', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let capturedArgs = null;
    await withMockedClient(
      (bin, args) => { capturedArgs = args; return JSON.stringify({ result: 'ok' }); },
      async ({ callOnce }) => { await callOnce({ prompt: 'hello' }); },
    );
    assert.ok(capturedArgs, 'execFileSync should have been called');
    assert.ok(!capturedArgs.includes('--bare'), '--bare must never be passed');
  });
});

test('callOnce builds the expected non-interactive invocation shape', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let capturedArgs = null;
    await withMockedClient(
      (bin, args) => { capturedArgs = args; return JSON.stringify({ result: 'ok', session_id: 's1' }); },
      async ({ callOnce }) => {
        const result = await callOnce({ prompt: 'summarize this' });
        assert.equal(result.response, 'ok');
        assert.equal(result.sessionId, 's1');
      },
    );
    assert.deepEqual(capturedArgs.slice(0, 2), ['-p', 'summarize this']);
    assert.ok(capturedArgs.includes('--output-format'));
    assert.ok(capturedArgs.includes('json'));
    assert.ok(capturedArgs.includes('--max-turns'));
    assert.ok(capturedArgs.includes('--permission-mode'));
    // No tools granted by default -- this is a text-completion backend, not an agentic session.
    assert.ok(!capturedArgs.includes('--allowedTools'));
  });
});

test('callOnce passes --tools \'\' when no allowedTools given, so the model can never spend its one turn attempting a tool call instead of returning text', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let capturedArgs = null;
    await withMockedClient(
      (bin, args) => { capturedArgs = args; return JSON.stringify({ result: 'ok' }); },
      async ({ callOnce }) => { await callOnce({ prompt: 'hello' }); },
    );
    const idx = capturedArgs.indexOf('--tools');
    assert.ok(idx !== -1, '--tools should be passed when allowedTools is omitted');
    assert.equal(capturedArgs[idx + 1], '');
  });
});

test('callOnce passes --allowedTools instead of --tools when a caller explicitly opts into tool access', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let capturedArgs = null;
    await withMockedClient(
      (bin, args) => { capturedArgs = args; return JSON.stringify({ result: 'ok' }); },
      async ({ callOnce }) => { await callOnce({ prompt: 'hello', allowedTools: 'Read' }); },
    );
    assert.ok(capturedArgs.includes('--allowedTools'));
    assert.ok(!capturedArgs.includes('--tools'));
  });
});

test('callOnce runs the child process in the isolated scratch dir by default, but a caller-supplied cwd overrides it (e.g. Discuss sessions granting real file access)', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    const realProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-client-cwd-test-'));
    let capturedCwd = null;
    try {
      await withMockedClient(
        (bin, args, opts) => { capturedCwd = opts.cwd; return JSON.stringify({ result: 'ok' }); },
        async ({ callOnce }) => { await callOnce({ prompt: 'hi', cwd: realProjectDir }); },
      );
      assert.equal(capturedCwd, realProjectDir);
    } finally {
      fs.rmSync(realProjectDir, { recursive: true, force: true });
    }
  });
});

test('callOnce strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the child env even when present in the parent process -- the auth-precedence footgun this module exists to close', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token', ANTHROPIC_API_KEY: 'sk-should-never-reach-child', ANTHROPIC_AUTH_TOKEN: 'bearer-should-never-reach-child' }, async () => {
    let capturedEnv = null;
    await withMockedClient(
      (bin, args, opts) => { capturedEnv = opts.env; return JSON.stringify({ result: 'ok' }); },
      async ({ callOnce }) => { await callOnce({ prompt: 'hi' }); },
    );
    assert.equal(capturedEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(capturedEnv.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(capturedEnv.CLAUDE_CODE_OAUTH_TOKEN, 'fake-token', 'the subscription token itself must still reach the child');
  });
});

test('callOnce surfaces a clear error when the CLI exits non-zero', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    await withMockedClient(
      () => { const e = new Error('boom'); e.stderr = 'auth error: token expired'; throw e; },
      async ({ callOnce }) => {
        await assert.rejects(() => callOnce({ prompt: 'hi' }), /claude -p failed.*token expired/s);
      },
    );
  });
});

test('callOnce surfaces a clear error when stdout is not valid JSON', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    await withMockedClient(
      () => 'not json at all',
      async ({ callOnce }) => {
        await assert.rejects(() => callOnce({ prompt: 'hi' }), /non-JSON output/);
      },
    );
  });
});

test('call() retries on a degenerate (empty) response and gives up after maxRetries', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let calls = 0;
    const result = await withMockedClient(
      () => { calls++; return JSON.stringify({ result: '' }); },
      ({ call }) => call({ prompt: 'hi' }, 2),
    );
    assert.equal(calls, 3, 'initial attempt + 2 retries');
    assert.equal(result.degenerate, 'empty');
  });
});

test('call() succeeds immediately on a real response, no retries spent', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let calls = 0;
    const result = await withMockedClient(
      () => { calls++; return JSON.stringify({ result: 'a real, non-degenerate response here' }); },
      ({ call }) => call({ prompt: 'hi' }, 2),
    );
    assert.equal(calls, 1);
    assert.equal(result.degenerate, null);
    assert.equal(result.response, 'a real, non-degenerate response here');
  });
});

test('module exports the same shape as ornith-client.js so it is a drop-in swap at the injection points', () => {
  const claudeClient = requireFreshClaudeClient();
  for (const key of ['call', 'callOnce', 'majorityVote', 'detectDegenerate']) {
    assert.equal(typeof claudeClient[key], 'function', `missing or non-function export: ${key}`);
  }
});
