'use strict';

// Covers local-client.js's Part 4 wiring of concepts.js's CONCEPT-BUILD self-report
// (injection into the outgoing prompt only when conceptId is set, extraction from the
// response, tally recorded on concepts.json) -- same isolated-stub pattern as
// local-client-side-finding.test.js, kept in its own file for the same reason that one
// is split out from local-client.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function withMockedLocalClient(scriptedResponses, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-client-cb-test-'));
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

function readConcepts(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'concepts.json'), 'utf8')).concepts;
}

test('call() does NOT inject CONCEPT-BUILD when no conceptId is given', async () => {
  await withMockedLocalClient([{ response: 'ok', eval_count: 1, eval_duration: 1 }], async (mod, _dir, { sentBodies }) => {
    await mod.call({ prompt: 'do the task', source: 'test_source' });
    assert.doesNotMatch(sentBodies[0].prompt, /CONCEPT-BUILD/);
  });
});

test('call() injects the CONCEPT-BUILD instruction when conceptId is set', async () => {
  await withMockedLocalClient([{ response: 'ok', eval_count: 1, eval_duration: 1 }], async (mod, _dir, { sentBodies }) => {
    await mod.call({ prompt: 'do the task', conceptId: 'concept-foo-abc' });
    assert.match(sentBodies[0].prompt, /CONCEPT-BUILD:/);
  });
});

test('call() extracts a CONCEPT-BUILD report, returns cleaned text, and records the tally', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concepts-precreate-'));
  const { createConcept } = require('./concepts.js');
  const concept = createConcept({ name: 'Foo concept' }, dir);

  await withMockedLocalClient([{
    response: 'Implemented it.\n\nCONCEPT-BUILD: adapted | Drew on SearXNG\'s JSON API.',
    eval_count: 1, eval_duration: 1,
  }], async (mod, testDir) => {
    // Copy the pre-created concept into this test's own pipelineDir so the tally lands
    // on a row that actually exists.
    fs.writeFileSync(path.join(testDir, 'concepts.json'), JSON.stringify({ concepts: [concept] }, null, 2));
    const result = await mod.call({ prompt: 'do the task', conceptId: concept.id });
    assert.equal(result.response.includes('CONCEPT-BUILD'), false);
    assert.match(result.response, /Implemented it\./);
    const updated = readConcepts(testDir).find((c) => c.id === concept.id);
    assert.equal(updated.adaptedFromResourceCount, 1);
    assert.equal(updated.builtFromScratchCount, 0);
  });
});

test('call() with no CONCEPT-BUILD marker in the response leaves the tally untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concepts-precreate-'));
  const { createConcept } = require('./concepts.js');
  const concept = createConcept({ name: 'Bar concept' }, dir);

  await withMockedLocalClient([{ response: 'Just did the work, forgot the tag.', eval_count: 1, eval_duration: 1 }], async (mod, testDir) => {
    fs.writeFileSync(path.join(testDir, 'concepts.json'), JSON.stringify({ concepts: [concept] }, null, 2));
    await mod.call({ prompt: 'do the task', conceptId: concept.id });
    const updated = readConcepts(testDir).find((c) => c.id === concept.id);
    assert.equal(updated.adaptedFromResourceCount, 0);
    assert.equal(updated.builtFromScratchCount, 0);
  });
});
