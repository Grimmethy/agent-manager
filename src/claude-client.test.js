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
// copies of local-client.js's own (untested-in-isolation) implementations, and this
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
  delete require.cache[require.resolve('./local-client.js')];
  // sandbox.js caches bwrap's resolved path at first call (see its own clearBwrapPathCache
  // comment) -- cleared here too so a test that installs a `which`-mocking execFileSync
  // always gets a fresh lookup, never a path cached from an earlier test's real (or
  // differently-mocked) environment.
  delete require.cache[require.resolve('./sandbox.js')];
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
    assert.equal(capturedArgs[0], '-p');
    // 2026-08-24 (pipeline hardening): the raw prompt string is no longer sent verbatim
    // -- callOnce prepends a real-date anchor line to every call (see
    // current-date-line.js) -- so this asserts the ORIGINAL prompt is still present
    // rather than the whole arg being exactly the caller's string. Not end-anchored:
    // 2026-09-05, callOnce also appends the SIDE-FINDING: instruction blurb after the
    // caller's own prompt (see side-finding.test.js for that behavior's own coverage).
    assert.match(capturedArgs[1], /summarize this/);
    assert.ok(capturedArgs.includes('--output-format'));
    assert.ok(capturedArgs.includes('json'));
    assert.ok(capturedArgs.includes('--max-turns'));
    assert.ok(capturedArgs.includes('--permission-mode'));
    // No tools granted by default -- this is a text-completion backend, not an agentic session.
    assert.ok(!capturedArgs.includes('--allowedTools'));
  });
});

test('callOnce prepends a real-date anchor line to the prompt', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let capturedArgs = null;
    await withMockedClient(
      (bin, args) => { capturedArgs = args; return JSON.stringify({ result: 'ok', session_id: 's1' }); },
      async ({ callOnce }) => { await callOnce({ prompt: 'summarize this' }); },
    );
    const today = new Date().toISOString().slice(0, 10);
    assert.match(capturedArgs[1], new RegExp(`Real current date: ${today}`));
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

// Chat panel (2026-08-24, Brain Dump #153): real session continuity via the CLI's own
// --resume, instead of every caller rebuilding a transcript from scratch each turn.
test('callOnce passes --resume when a caller supplies a prior sessionId', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let capturedArgs = null;
    await withMockedClient(
      (bin, args) => { capturedArgs = args; return JSON.stringify({ result: 'ok' }); },
      async ({ callOnce }) => { await callOnce({ prompt: 'follow-up message', resume: 'sess-abc123' }); },
    );
    const idx = capturedArgs.indexOf('--resume');
    assert.ok(idx !== -1, '--resume should be passed when resume is supplied');
    assert.equal(capturedArgs[idx + 1], 'sess-abc123');
  });
});

test('callOnce omits --resume entirely on a first message with no prior session', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let capturedArgs = null;
    await withMockedClient(
      (bin, args) => { capturedArgs = args; return JSON.stringify({ result: 'ok' }); },
      async ({ callOnce }) => { await callOnce({ prompt: 'first message' }); },
    );
    assert.ok(!capturedArgs.includes('--resume'));
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

// 2026-08-24 (sandbox.js): the mock here has to handle TWO distinct execFileSync shapes --
// sandbox.js's own `which bwrap` lookup, and the real `bwrap ... -- claude ...` invocation
// this call site produces once available -- so a fake `which` command is passed via PATH
// (a real script, not a further mock layer) rather than trying to special-case execFileSync
// itself for the `which` shape. This host may or may not have real bwrap installed, so the
// PATH override always wins regardless.
function withFakeBwrapOnPath(bwrapCapture, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-client-fake-bwrap-'));
  const fakeBwrap = path.join(dir, 'bwrap');
  // Records its own invocation to bwrapCapture.args and exits 0 with nothing on stdout --
  // callOnce()'s own JSON.parse would fail on empty output, so this script hands back a
  // minimal valid result JSON, same shape execFileSync's mock returns elsewhere in this file.
  fs.writeFileSync(fakeBwrap, `#!/bin/sh\necho "$@" > "${path.join(dir, 'captured-args.txt')}"\necho '{"result":"ok"}'\n`);
  fs.chmodSync(fakeBwrap, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    return fn(() => fs.readFileSync(path.join(dir, 'captured-args.txt'), 'utf8').trim());
  } finally {
    process.env.PATH = priorPath;
  }
}

test('callOnce({ sandbox }) invokes bwrap instead of CLAUDE_BIN directly', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    await withFakeBwrapOnPath(null, async (readCaptured) => {
      const claudeClient = requireFreshClaudeClient();
      const result = await claudeClient.callOnce({
        prompt: 'investigate this',
        cwd: os.tmpdir(),
        allowedTools: 'Read,Bash',
        sandbox: { readOnlyBinds: ['/usr'], writableBinds: [os.tmpdir()] },
      });
      assert.equal(result.sandboxUnavailable, false);
      const captured = readCaptured();
      assert.match(captured, /--ro-bind \/usr \/usr/);
      assert.match(captured, /-- claude -p/, 'the wrapped command must still be the real claude CLI invocation, after the bwrap sandbox args');
    });
  });
});

test('callOnce without a sandbox param never touches bwrap -- every existing caller keeps invoking CLAUDE_BIN directly', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let capturedBin = null;
    await withMockedClient(
      (bin) => { capturedBin = bin; return JSON.stringify({ result: 'ok' }); },
      async ({ callOnce }) => { await callOnce({ prompt: 'hello' }); },
    );
    assert.equal(capturedBin, 'claude');
  });
});

test('callOnce({ sandbox }) falls open (still runs, unsandboxed) and flags sandboxUnavailable when bwrap is not on PATH', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let capturedBin = null;
    // execFileSync is fully replaced here (same as every other withMockedClient test), so
    // a real PATH change alone can't simulate "bwrap missing" -- the mock never actually
    // does a filesystem/PATH lookup. Instead, the mock itself throws for the `which`
    // shape specifically (sandbox.js's own bwrapPath() lookup), reproducing exactly what
    // a real `which bwrap` failure looks like to that try/catch, and answers normally for
    // every other call (the real claude invocation this should still fall through to).
    const result = await withMockedClient(
      (bin, args) => {
        if (bin === 'which') throw new Error('which: bwrap: command not found');
        capturedBin = bin;
        return JSON.stringify({ result: 'ok' });
      },
      async ({ callOnce }) => callOnce({ prompt: 'hello', sandbox: { readOnlyBinds: [], writableBinds: [] } }),
    );
    assert.equal(capturedBin, 'claude', 'must fall back to invoking claude directly, not fail the whole call');
    assert.equal(result.sandboxUnavailable, true);
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

// Regression, 2026-08-24: model/effort/timeoutMs were silently dropped by majorityVote()
// -- a model-profile-registry.js profile naming a specific model had no way to actually
// reach a vote, since majorityVote is review-task.js's only entry point into this module.
test('majorityVote() forwards a model override into the real CLI invocation for every vote', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    const capturedArgsPerCall = [];
    await withMockedClient(
      (bin, args) => { capturedArgsPerCall.push(args); return JSON.stringify({ result: 'APPROVE: looks correct' }); },
      async ({ majorityVote }) => {
        const classify = (text) => (text.includes('APPROVE') ? 'approve' : null);
        await majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2, model: 'claude:opus' });
      },
    );
    assert.ok(capturedArgsPerCall.length >= 2, 'early-exit still needs at least 2 votes to reach minAgreeing');
    for (const args of capturedArgsPerCall) {
      const modelIdx = args.indexOf('--model');
      assert.ok(modelIdx !== -1, 'every vote must pass --model');
      assert.equal(args[modelIdx + 1], 'claude:opus');
    }
  });
});

test('module exports the same shape as local-client.js so it is a drop-in swap at the injection points', () => {
  const claudeClient = requireFreshClaudeClient();
  for (const key of ['call', 'callOnce', 'majorityVote', 'detectDegenerate']) {
    assert.equal(typeof claudeClient[key], 'function', `missing or non-function export: ${key}`);
  }
});

// 2026-08-29 (performance_fix AC-4): majorityVote() had drifted out of parity with
// local-client.js's -- no per-vote try/catch, no voteErrors, no early-exit. These pin the
// restored behavior (and why the loop stays sequential rather than Promise.all).
test('majorityVote() early-exits as soon as a verdict reaches minAgreeing -- does not pay for every vote', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let callCount = 0;
    await withMockedClient(
      () => { callCount += 1; return JSON.stringify({ result: 'APPROVE: fine' }); },
      async ({ majorityVote }) => {
        const classify = (t) => (t.includes('APPROVE') ? 'approve' : null);
        const r = await majorityVote({ prompt: 'x', classify, n: 5, minAgreeing: 2 });
        assert.equal(r.verdict, 'approve');
        assert.equal(r.confident, true);
      },
    );
    assert.equal(callCount, 2, 'stopped after 2 agreeing votes even though n=5');
  });
});

test('majorityVote() records a hard-failed vote in voteErrors and keeps going with the rest', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let callCount = 0;
    await withMockedClient(
      () => {
        callCount += 1;
        if (callCount === 1) throw new Error('claude CLI exited 1: network unreachable');
        return JSON.stringify({ result: 'APPROVE: fine' });
      },
      async ({ majorityVote }) => {
        const classify = (t) => (t.includes('APPROVE') ? 'approve' : null);
        const r = await majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2 });
        assert.equal(r.verdict, 'approve', 'the two surviving votes still form a majority');
        assert.equal(r.confident, true);
        assert.equal(r.realVoteCount, 2);
        assert.equal(r.voteErrors.length, 1);
        assert.match(r.voteErrors[0], /network unreachable/);
      },
    );
    assert.equal(callCount, 3, '1 failed + 2 that reached minAgreeing');
  });
});

test('majorityVote() rethrows only when EVERY vote hard-fails (a real infra failure, not "inconclusive")', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    await withMockedClient(
      () => { throw new Error('claude CLI exited 1: service unavailable'); },
      async ({ majorityVote }) => {
        const classify = () => 'approve';
        await assert.rejects(
          majorityVote({ prompt: 'x', classify, n: 3, minAgreeing: 2 }),
          /service unavailable/,
        );
      },
    );
  });
});

// --- side-finding capture (2026-09-05) -----------------------------------------------

function sideFindingInboxFiles(dir) {
  const inbox = path.join(dir, 'queue', 'side-findings-inbox');
  if (!fs.existsSync(inbox)) return [];
  return fs.readdirSync(inbox).map((f) => JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8')));
}

test('callOnce injects the SIDE-FINDING instruction into the prompt by default', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let capturedArgs = null;
    await withMockedClient(
      (bin, args) => { capturedArgs = args; return JSON.stringify({ result: 'ok' }); },
      async ({ callOnce }) => { await callOnce({ prompt: 'do the task' }); },
    );
    assert.match(capturedArgs[1], /SIDE-FINDING:/);
  });
});

test('callOnce does not inject when allowSideFindings is false', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token' }, async () => {
    let capturedArgs = null;
    await withMockedClient(
      (bin, args) => { capturedArgs = args; return JSON.stringify({ result: 'ok' }); },
      async ({ callOnce }) => { await callOnce({ prompt: 'classify this', allowSideFindings: false }); },
    );
    assert.doesNotMatch(capturedArgs[1], /SIDE-FINDING/);
  });
});

test('call() extracts a SIDE-FINDING block from the response, returns cleaned text, and files it to the inbox', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-client-sf-test-'));
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-token', AGENT_MANAGER_PIPELINE_DIR: dir, AGENT_MANAGER_REPO_ROOT: dir }, async () => {
    await withMockedClient(
      () => JSON.stringify({ result: 'Real answer.\n\nSIDE-FINDING: Something worth a look\nBody of the finding.' }),
      async ({ call }) => {
        const result = await call({ prompt: 'go', source: 'chat' });
        assert.equal(result.response.includes('SIDE-FINDING'), false);
        assert.match(result.response, /Real answer\./);
      },
    );
    const files = sideFindingInboxFiles(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].title, 'Something worth a look');
    assert.equal(files[0].source, 'chat');
  });
});
