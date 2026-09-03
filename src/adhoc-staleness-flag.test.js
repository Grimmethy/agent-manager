'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { classifyStaleTask, sweep } = require('./adhoc-staleness-flag.js');

// --- classifyStaleTask (pure) ---------------------------------------------------------

test('already-implemented-strong -> retire / high', () => {
  const strong = classifyStaleTask({ task: { id: 't' }, reasons: ['retries-exhausted', 'already-implemented-strong'], evidence: ['asks to add `foo` -- already defined in src/x.js'] });
  assert.equal(strong.reason, 'already-implemented');
  assert.equal(strong.disposition, 'retire');
  assert.equal(strong.confidence, 'high');
});

test('invalid-premise -> retire / high', () => {
  const f = classifyStaleTask({ task: { id: 't' }, reasons: ['invalid-premise'], evidence: ['every file this task names is absent'] });
  assert.equal(f.confidence, 'high');
  assert.equal(f.disposition, 'retire');
});

test('duplicate of an already-done task -> retire / high; of a live task -> medium', () => {
  const done = classifyStaleTask({ task: { id: 't' }, reasons: ['duplicate-of'], evidence: [], duplicateOf: { id: 'other', state: 'merged', sim: 0.8 } });
  assert.equal(done.confidence, 'high');
  const live = classifyStaleTask({ task: { id: 't' }, reasons: ['duplicate-of'], evidence: [], duplicateOf: { id: 'other', state: 'blocked', sim: 0.7 } });
  assert.equal(live.confidence, 'medium');
});

test('decompose-loop -> re-scope / medium', () => {
  const f = classifyStaleTask({ task: { id: 't' }, reasons: ['retries-exhausted', 'decompose-loop'], evidence: [] });
  assert.equal(f.reason, 'decompose-loop');
  assert.equal(f.disposition, 're-scope');
  assert.equal(f.confidence, 'medium');
});

test('retries-exhausted only -> capability-ceiling / medium', () => {
  const f = classifyStaleTask({ task: { id: 't' }, reasons: ['retries-exhausted'], evidence: [] });
  assert.equal(f.disposition, 'capability-ceiling');
  assert.equal(f.confidence, 'medium');
});

test('stale-age only, or possibly-resolved only -> null (staleness_audit source owns these)', () => {
  assert.equal(classifyStaleTask({ task: { id: 't' }, reasons: ['stale-age'], evidence: [] }), null);
  assert.equal(classifyStaleTask({ task: { id: 't' }, reasons: ['possibly-resolved'], evidence: [], touchedFiles: ['src/x.js'] }), null);
});

// --- sweep ---------------------------------------------------------------------------

function tmpPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-stale-'));
  for (const d of ['blocked', 'needs-clarification', 'pending', 'done']) {
    fs.mkdirSync(path.join(dir, 'queue', d), { recursive: true });
  }
  return dir;
}

function writeTask(pipelineDir, state, task) {
  fs.writeFileSync(path.join(pipelineDir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
}

function readTask(pipelineDir, state, id) {
  return JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', state, `${id}.json`), 'utf8'));
}

const exhaustedTask = (id, extra = {}) => ({
  id, source: 'manual', domain: 'adhoc', status: 'blocked',
  title: `do the ${id} thing`,
  createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
  history: [{ stage: 'blocked', at: new Date().toISOString() }, { stage: 'exhausted', at: new Date().toISOString() }],
  ...extra,
});

test('sweep stamps a high-confidence flag with no vote, and never moves the file', async () => {
  const dir = tmpPipeline();
  writeTask(dir, 'needs-clarification', exhaustedTask('dup-a', { title: 'wire the plugin marketplace catalog panel' }));
  writeTask(dir, 'done', { id: 'dup-b', title: 'wire the plugin marketplace catalog panel', status: 'merged', createdAt: new Date().toISOString() });

  const majorityVote = () => { throw new Error('vote should not be called for high confidence'); };
  const s = await sweep({ pipelineDir: dir, repoRoot: null, majorityVote, now: Date.now() });

  assert.ok(fs.existsSync(path.join(dir, 'queue', 'needs-clarification', 'dup-a.json')), 'file stays put');
  const t = readTask(dir, 'needs-clarification', 'dup-a');
  assert.equal(t.stalenessFlag.reason, 'duplicate-of');
  assert.equal(t.stalenessFlag.confidence, 'high');
  assert.equal(s.highConfidence, 1);
});

test('sweep is idempotent -- a second run does not re-stamp or duplicate history', async () => {
  const dir = tmpPipeline();
  writeTask(dir, 'blocked', exhaustedTask('ceil-1'));
  const mv = async () => ({ confident: false, verdict: null, realVoteCount: 3, requestedVotes: 3 });
  await sweep({ pipelineDir: dir, repoRoot: null, majorityVote: mv, now: Date.now() });
  const after1 = readTask(dir, 'blocked', 'ceil-1');
  const hist1 = after1.history.length;
  await sweep({ pipelineDir: dir, repoRoot: null, majorityVote: mv, now: Date.now() });
  const after2 = readTask(dir, 'blocked', 'ceil-1');
  assert.equal(after2.history.length, hist1, 'no new history event on the second run');
});

test('vote DENY drops the flag and sets a Keep cooldown that suppresses re-flagging', async () => {
  const dir = tmpPipeline();
  writeTask(dir, 'blocked', exhaustedTask('keep-1'));
  const deny = async () => ({ confident: true, verdict: 'DENY', realVoteCount: 3, requestedVotes: 3 });
  await sweep({ pipelineDir: dir, repoRoot: null, majorityVote: deny, now: Date.now() });
  const t = readTask(dir, 'blocked', 'keep-1');
  assert.equal(t.stalenessFlag, undefined);
  assert.ok(t.stalenessKeep && Date.parse(t.stalenessKeep.until) > Date.now());

  // next sweep must skip it
  const boom = () => { throw new Error('should not vote a cooled-down task'); };
  const s2 = await sweep({ pipelineDir: dir, repoRoot: null, majorityVote: boom, now: Date.now() });
  assert.equal(s2.flagged, 0);
});

test('vote CONFIRM promotes a medium flag to high', async () => {
  const dir = tmpPipeline();
  writeTask(dir, 'blocked', exhaustedTask('conf-1'));
  const confirm = async () => ({ confident: true, verdict: 'CONFIRM', realVoteCount: 3, requestedVotes: 3 });
  await sweep({ pipelineDir: dir, repoRoot: null, majorityVote: confirm, now: Date.now() });
  const t = readTask(dir, 'blocked', 'conf-1');
  assert.equal(t.stalenessFlag.confidence, 'high');
  assert.match(t.stalenessFlag.voteResult, /CONFIRM/);
});

test('kill switch disables the sweep entirely', async () => {
  const dir = tmpPipeline();
  writeTask(dir, 'blocked', exhaustedTask('off-1'));
  process.env.AGENT_MANAGER_ADHOC_STALENESS_FLAG = 'false';
  const s = await sweep({ pipelineDir: dir, repoRoot: null, majorityVote: async () => ({}), now: Date.now() });
  delete process.env.AGENT_MANAGER_ADHOC_STALENESS_FLAG;
  assert.equal(s.scanned, 0);
  assert.equal(readTask(dir, 'blocked', 'off-1').stalenessFlag, undefined);
});
