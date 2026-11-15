'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSummary, runDaily, localDate, summaryHour } = require('./notify-summary.js');

const HOUR = 60 * 60 * 1000;

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-sum-'));
  const q = path.join(dir, 'queue');
  for (const s of ['done', 'blocked', 'needs-clarification', 'awaiting-confirm', 'pending', 'coordinating']) fs.mkdirSync(path.join(q, s), { recursive: true });
  return { dir, q };
}

function put(q, state, name, ageMs, now) {
  const f = path.join(q, state, name);
  fs.writeFileSync(f, '{}');
  const t = new Date(now - ageMs);
  fs.utimesSync(f, t, t);
}

test('buildSummary counts the queue states and recent finishes', () => {
  const { q } = makePipeline();
  const now = Date.now();
  put(q, 'done', 'a.json', 1 * HOUR, now);
  put(q, 'done', 'b.json', 23 * HOUR, now);
  put(q, 'done', 'c.json', 25 * HOUR, now);
  put(q, 'blocked', 'd.json', 0, now);
  put(q, 'blocked', 'e.json', 0, now);
  put(q, 'needs-clarification', 'f.json', 0, now);
  put(q, 'awaiting-confirm', 'g.json', 0, now);
  put(q, 'pending', 'h.json', 0, now);
  put(q, 'pending', 'i.json', 0, now);
  put(q, 'pending', 'not-json.txt', 0, now);
  put(q, 'done', 'notes.txt', 1 * HOUR, now);
  put(q, 'blocked', 'notes.txt', 0, now);
  put(q, 'coordinating', 'j.json', 0, now);
  const s = buildSummary({ queueDir: q, now });
  assert.deepEqual(s.counts, { finishedLast24h: 2, blocked: 2, needsClarification: 1, awaitingConfirm: 1, pending: 2, hubs: 1 });
  assert.equal(s.title, 'Daily summary: 2 finished, 4 waiting on you');
  assert.match(s.text, /Finished in the last 24 hours: 2/);
  assert.match(s.text, /Waiting on a person: 4 \(blocked 2, needs clarification 1, awaiting confirm 1\)/);
  assert.match(s.text, /In the pipeline: 2 pending, 1 hubs coordinating/);
});

test('buildSummary says nothing is waiting when nothing is, and survives missing directories', () => {
  const s = buildSummary({ queueDir: path.join(os.tmpdir(), 'no-such-queue-dir-xyz'), now: Date.now() });
  assert.equal(s.title, 'Daily summary: 0 finished, nothing waiting on you');
  assert.equal(s.counts.pending, 0);
});

function runEnv(dir, extra = {}) {
  return { AGENT_MANAGER_PIPELINE_DIR: dir, AGENT_MANAGER_NOTIFY_URL: 'http://ntfy.test/t', ...extra };
}

test('runDaily sends once per local day and not again the same day', async () => {
  const { dir } = makePipeline();
  const calls = [];
  const post = async (url, headers, body) => { calls.push({ headers, body }); };
  const at = (day, hour) => new Date(2026, 10, day, hour, 30).getTime();
  const r1 = await runDaily({ env: runEnv(dir), now: () => at(11, 9), post });
  assert.equal(r1.sent, true);
  assert.equal(calls[0].headers.Priority, 'default');
  assert.match(calls[0].headers.Title, /^Daily summary:/);
  assert.equal((await runDaily({ env: runEnv(dir), now: () => at(11, 15), post })).reason, 'already-sent-today');
  assert.equal(calls.length, 1);
  assert.equal((await runDaily({ env: runEnv(dir), now: () => at(12, 9), post })).sent, true);
  assert.equal(calls.length, 2);
});

test('runDaily waits for the summary hour', async () => {
  const { dir } = makePipeline();
  const calls = [];
  const post = async () => { calls.push(1); };
  const at = (hour) => new Date(2026, 10, 11, hour, 0).getTime();
  assert.equal((await runDaily({ env: runEnv(dir), now: () => at(7), post })).reason, 'too-early');
  assert.equal((await runDaily({ env: runEnv(dir, { AGENT_MANAGER_NOTIFY_SUMMARY_HOUR: '6' }), now: () => at(7), post })).sent, true);
  assert.equal(calls.length, 1);
});

test('a failed send does not use up the day', async () => {
  const { dir } = makePipeline();
  const now = () => new Date(2026, 10, 11, 10, 0).getTime();
  let fail = true;
  const post = async () => { if (fail) throw new Error('down'); };
  const r1 = await runDaily({ env: runEnv(dir), now, post });
  assert.equal(r1.sent, false);
  assert.equal(r1.reason, 'error');
  fail = false;
  assert.equal((await runDaily({ env: runEnv(dir), now, post })).sent, true);
});

test('runDaily reports a missing pipeline dir', async () => {
  assert.equal((await runDaily({ env: {}, now: () => Date.now() })).reason, 'no-pipeline-dir');
});

test('localDate and summaryHour', () => {
  assert.equal(localDate(new Date(2026, 0, 5, 3, 0).getTime()), '2026-01-05');
  assert.equal(summaryHour({}), 8);
  assert.equal(summaryHour({ AGENT_MANAGER_NOTIFY_SUMMARY_HOUR: '21' }), 21);
  assert.equal(summaryHour({ AGENT_MANAGER_NOTIFY_SUMMARY_HOUR: '99' }), 8);
  assert.equal(summaryHour({ AGENT_MANAGER_NOTIFY_SUMMARY_HOUR: 'x' }), 8);
  assert.equal(summaryHour({ AGENT_MANAGER_NOTIFY_SUMMARY_HOUR: '0' }), 0);
});

test('runDaily sends at exactly the summary hour and logs the day as the key', async () => {
  const { dir } = makePipeline();
  const post = async () => {};
  const at = new Date(2026, 10, 11, 8, 0).getTime();
  const r = await runDaily({ env: runEnv(dir), now: () => at, post });
  assert.equal(r.sent, true);
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'notify', 'notify-log.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(line.key, 'summary:2026-11-11');
  assert.equal(line.level, 'summary');
});
