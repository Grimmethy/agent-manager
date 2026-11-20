'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCompaction, COMPACT_DIRNAME } = require('../src/done-compact.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-18T00:00:00Z');
const OLD = new Date(NOW - 60 * DAY_MS);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const FAKE = async () => 'Fake summary: looked at the sources and recorded the outcome.';

function makeQueue() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'done-compact-test-'));
  const worklogDir = path.join(root, 'queue', 'worklogs');
  const doneDir = path.join(root, 'queue', 'done');
  fs.mkdirSync(worklogDir, { recursive: true });
  fs.mkdirSync(doneDir, { recursive: true });
  return { worklogDir, doneDir };
}

function writeWorklog(q, taskId, doc, { done = true, mtime = OLD } = {}) {
  const p = path.join(q.worklogDir, `${taskId}.json`);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  fs.utimesSync(p, mtime, mtime);
  if (done) fs.writeFileSync(path.join(q.doneDir, `${taskId}.json`), '{}');
  return p;
}

const BIG = 'x'.repeat(1500);

// Research-domain fixture: a web-only research pass (WebSearch/WebFetch), one tier.
function researchDoc(taskId) {
  return {
    taskId,
    tiers: [{
      tier: 'research', at: '2026-10-01T00:00:00Z', turnsUsed: 6, callCount: 4,
      calls: [
        { n: 1, tool: 'WebSearch', args: { query: 'acme corp funding round 2026' }, resultBytes: 9000, resultPreview: BIG },
        { n: 2, tool: 'WebFetch', args: { url: 'https://example.com/acme' }, resultBytes: 12000, resultPreview: BIG },
        { n: 3, tool: 'WebFetch', args: { url: 'https://example.com/press' }, resultBytes: 800, resultPreview: BIG },
        { n: 4, tool: 'WebSearch', args: { query: 'acme series B' }, resultBytes: 3000, resultPreview: BIG },
      ],
      finalMessage: '# Acme\n\nRESEARCH: completed',
    }],
  };
}

// Failed-then-succeeded fixture: tier 1 errors out, tier 2 succeeds.
function failedThenSucceededDoc(taskId) {
  return {
    taskId,
    tiers: [
      { tier: 'implement-1', at: '2026-10-01T00:00:00Z', turnsUsed: 3, callCount: 2,
        calls: [
          { n: 1, tool: 'Bash', args: { command: 'npm test' }, resultBytes: 400, resultPreview: 'FAIL', error: true },
          { n: 2, tool: 'Edit', args: { file_path: 'src/a.js' }, resultBytes: 10 },
        ],
        finalMessage: 'gave up after a failing test' },
      { tier: 'implement-2', at: '2026-10-01T01:00:00Z', turnsUsed: 2, callCount: 1,
        calls: [{ n: 1, tool: 'Bash', args: { command: 'node --test' }, resultBytes: 50, resultPreview: 'ok' }],
        finalMessage: 'RESOLUTION: implemented' },
    ],
  };
}

test('research-domain fixture: dry run leaves the worklog byte-identical and reports original and proposed sizes', async () => {
  const q = makeQueue();
  const p = writeWorklog(q, 'T-research', researchDoc('T-research'));
  const before = sha256(fs.readFileSync(p));
  const report = await runCompaction({ worklogDir: q.worklogDir, now: NOW, apply: false, summarize: FAKE });
  assert.equal(sha256(fs.readFileSync(p)), before);
  const reportFile = JSON.parse(fs.readFileSync(path.join(q.worklogDir, COMPACT_DIRNAME, 'report.json'), 'utf8'));
  assert.equal(reportFile.applied, false);
  assert.equal(report.summary.eligible, 1);
  const f = reportFile.files[0];
  assert.ok(f.originalBytes > 0 && f.proposedBytes > 0);
  assert.ok(f.originalBytes > f.proposedBytes, 'proposed document is smaller than the original');
  assert.equal(fs.existsSync(path.join(q.worklogDir, COMPACT_DIRNAME, 'snapshots')), false, 'no snapshot in dry run');
});

test('failed-then-succeeded fixture: apply snapshots the original, keeps both tiers and the error flag, drops raw args', async () => {
  const q = makeQueue();
  const p = writeWorklog(q, 'T-retry', failedThenSucceededDoc('T-retry'));
  const original = fs.readFileSync(p);
  const report = await runCompaction({ worklogDir: q.worklogDir, now: NOW, apply: true, summarize: FAKE });
  assert.equal(report.summary.written, 1);
  const snap = fs.readFileSync(path.join(q.worklogDir, COMPACT_DIRNAME, 'snapshots', 'T-retry.json'));
  assert.ok(snap.equals(original), 'snapshot is byte-identical to the original');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(doc.compacted, true);
  assert.equal(doc.tiers.length, 2);
  assert.equal(doc.tiers[0].calls[0].error, true);
  assert.equal(doc.tiers[1].finalMessage, 'RESOLUTION: implemented');
  assert.equal(JSON.stringify(doc).includes('npm test'), false, 'raw args are dropped');
});

test('every ineligible task gets exactly one skips.jsonl line with a reason, matching the summary counters', async () => {
  const q = makeQueue();
  writeWorklog(q, 'T-eligible', researchDoc('T-eligible'));
  writeWorklog(q, 'T-notools', { taskId: 'T-notools', tiers: [{ tier: 'x', calls: [] }] });
  writeWorklog(q, 'T-notdone', researchDoc('T-notdone'), { done: false });
  writeWorklog(q, 'T-recent', researchDoc('T-recent'), { mtime: new Date(NOW - DAY_MS) });
  writeWorklog(q, 'T-already', { ...researchDoc('T-already'), compacted: true });
  const report = await runCompaction({ worklogDir: q.worklogDir, now: NOW, apply: false, summarize: FAKE });
  const lines = fs.readFileSync(path.join(q.worklogDir, COMPACT_DIRNAME, 'skips.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => l.taskId).sort(), ['T-already', 'T-notdone', 'T-notools', 'T-recent']);
  for (const l of lines) assert.ok(typeof l.reason === 'string' && l.reason.length > 0);
  const counted = Object.values(report.skipReasons).reduce((a, b) => a + b, 0);
  assert.equal(lines.length, counted);
  assert.equal(report.summary.eligible, 1);
});

test('a failing summarizer skips the task and leaves its worklog untouched', async () => {
  const q = makeQueue();
  const p = writeWorklog(q, 'T-flaky', researchDoc('T-flaky'));
  const before = fs.readFileSync(p);
  const report = await runCompaction({
    worklogDir: q.worklogDir, now: NOW, apply: true,
    summarize: async () => { throw new Error('model unavailable'); },
  });
  assert.ok(fs.readFileSync(p).equals(before));
  assert.equal(report.skipReasons['summarize-failed'], 1);
});

test('done-compact.js names no model-reload knobs or timers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'done-compact.js'), 'utf8');
  for (const token of ['setInterval', 'schedule.every', 'num_ctx', 'keep_alive', '/api/generate', '/api/chat']) {
    assert.equal(src.includes(token), false, `found forbidden token: ${token}`);
  }
});
