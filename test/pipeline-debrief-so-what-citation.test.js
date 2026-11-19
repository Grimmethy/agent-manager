'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attachSoWhatCitation, citationTokensFor } = require('../src/pipeline-debrief-so-what-check.js');

const task = {
  promptContext: {
    evidenceText: '### COMPLETED 3: adhoc-fix-example-task-id-abc\nmodel_calls: 4\n',
    taskIds: [],
    contrastIds: [],
  },
};

test('citationTokensFor returns the real COMPLETED tokens from evidence', () => {
  assert.deepEqual(citationTokensFor(task), ['COMPLETED 3']);
});

test('attachSoWhatCitation appends a real citation when SO WHAT has none', () => {
  const out = attachSoWhatCitation('SO WHAT\n- across all tasks, retries are common', task);
  assert.match(out, /COMPLETED 3/);
});

test('attachSoWhatCitation returns text unchanged when it already cites a real token', () => {
  const cited = 'SO WHAT\n- flagged in COMPLETED 3';
  assert.equal(attachSoWhatCitation(cited, task), cited);
});

test('attachSoWhatCitation returns input unchanged when there is no evidence to cite', () => {
  const text = 'SO WHAT\n- x';
  assert.equal(attachSoWhatCitation(text, { promptContext: {} }), text);
});
