'use strict';

// Covers local-client.js's Part 3 wiring of side-finding.js (injection into the outgoing
// prompt, extraction from the response before degenerate-detection, inbox filing) --
// separate file from local-client.test.js (which deliberately stays scoped to the pure
// detectDegenerate() function, no HTTP mocking) so this one small stub doesn't grow that
// file's own stated scope.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Must be async AND must `await fn(...)` (not just `return fn(...)`, even from an async
// function -- confirmed live, the two are NOT equivalent for finally-timing purposes):
// otherwise the try block exits and `finally` runs its cleanup (env vars, require.cache)
// BEFORE fn's own async body ever reaches its first await -- caught live via this exact
// test file: writeSideFindingInbox's pipelineDir read happens after an await inside
// call(), so it saw the env vars already deleted by the time it ran.
async function withMockedLocalClient(scriptedResponses, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-client-sf-test-'));
  delete process.env.AGENT_MANAGER_REPO_ROOT;
  delete process.env.AGENT_MANAGER_PIPELINE_DIR;
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  const queue = scriptedResponses.slice();
  const sentBodies = [];
  const stub = (relId, exportsObj) => {
    const resolved = require.resolve(relId);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  };
  for (const relId of ['./ollama-http.js', './local-client.js']) {
    delete require.cache[require.resolve(relId)];
  }
  stub('./ollama-http.js', {
    postJson: async (_url, body) => {
      sentBodies.push(body);
      return queue.length ? queue.shift() : { response: 'ok', eval_count: 1, eval_duration: 1 };
    },
  });
  try {
    const mod = require('./local-client.js');
    return await fn(mod, dir, { sentBodies });
  } finally {
    for (const relId of ['./ollama-http.js', './local-client.js']) {
      delete require.cache[require.resolve(relId)];
    }
    delete process.env.AGENT_MANAGER_REPO_ROOT;
    delete process.env.AGENT_MANAGER_PIPELINE_DIR;
  }
}

function inboxFiles(dir) {
  const inbox = path.join(dir, 'queue', 'side-findings-inbox');
  if (!fs.existsSync(inbox)) return [];
  return fs.readdirSync(inbox).map((f) => JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8')));
}

test('call() injects the SIDE-FINDING instruction into the outgoing prompt by default', async () => {
  await withMockedLocalClient([{ response: 'a real answer', eval_count: 1, eval_duration: 1 }], async (mod, _dir, { sentBodies }) => {
    await mod.call({ prompt: 'do the task', source: 'test_source' });
    assert.match(sentBodies[0].prompt, /SIDE-FINDING:/);
    assert.match(sentBodies[0].prompt, /do the task/);
  });
});

test('call() does not inject when allowSideFindings is false', async () => {
  await withMockedLocalClient([{ response: 'ok', eval_count: 1, eval_duration: 1 }], async (mod, _dir, { sentBodies }) => {
    await mod.call({ prompt: 'classify this', allowSideFindings: false });
    assert.doesNotMatch(sentBodies[0].prompt, /SIDE-FINDING/);
  });
});

test('call() does not inject when format (grammar-constrained decoding) is set', async () => {
  await withMockedLocalClient([{ response: '{}', eval_count: 1, eval_duration: 1 }], async (mod, _dir, { sentBodies }) => {
    await mod.call({ prompt: 'return json', format: 'json' });
    assert.doesNotMatch(sentBodies[0].prompt, /SIDE-FINDING/);
  });
});

test('call() extracts a SIDE-FINDING block from the response, returns cleaned text, and files it to the inbox', async () => {
  await withMockedLocalClient([{
    response: 'Here is the real answer.\n\nSIDE-FINDING: A real observation\nWorth a look later.',
    eval_count: 1, eval_duration: 1,
  }], async (mod, dir) => {
    const result = await mod.call({ prompt: 'do the task', source: 'observability_fix' });
    assert.equal(result.response.includes('SIDE-FINDING'), false);
    assert.match(result.response, /Here is the real answer\./);
    const files = inboxFiles(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].title, 'A real observation');
    assert.equal(files[0].source, 'observability_fix');
  });
});

test('call() with allowSideFindings:false never extracts even if the response happens to contain the marker text', async () => {
  await withMockedLocalClient([{
    response: 'SIDE-FINDING: should not be extracted\nbody',
    eval_count: 1, eval_duration: 1,
  }], async (mod, dir) => {
    const result = await mod.call({ prompt: 'classify this', allowSideFindings: false });
    assert.match(result.response, /SIDE-FINDING: should not be extracted/, 'left untouched when the caller opted out');
    assert.equal(inboxFiles(dir).length, 0);
  });
});

test('call() extraction runs BEFORE degenerate-detection: a response that is only a SIDE-FINDING block is still correctly flagged degenerate on the cleaned (empty) remainder', async () => {
  await withMockedLocalClient([{
    response: 'SIDE-FINDING: only a finding, no real answer\nbody text here',
    eval_count: 1, eval_duration: 1,
  }], async (mod, dir) => {
    // maxRetries=0 -- a single attempt, so exactly one inbox write is expected.
    const result = await mod.call({ prompt: 'do the task' }, 0);
    assert.equal(result.degenerate, 'empty', 'the real task response was empty once the finding was stripped out');
    assert.equal(inboxFiles(dir).length, 1, 'the finding itself must still be filed even though the surrounding call was judged degenerate');
  });
});
