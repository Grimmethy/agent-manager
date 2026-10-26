'use strict';

// Tests for trajectory.js (brain-dump 1892 part 1): build/cap, best-effort write and its off
// switch, age-based prune with its hourly marker, and the list/read/CLI side.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const tj = require('./trajectory.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env[name]; else process.env[name] = prev; }
}

const sample = () => tj.buildTrajectory({
  meta: { taskId: 'task/one', stage: 'agentic-write', source: 'manual', lane: 'worker-3090', model: 'm', startedMs: Date.parse('2026-10-18T10:00:00Z'), endedMs: Date.parse('2026-10-18T10:01:30Z') },
  messages: [
    { role: 'system', content: 'you are an agent' },
    { role: 'assistant', content: '', thinking: 'hmm', tool_calls: [{ function: { name: 'edit_file', arguments: { path: 'a.txt', find: 'x', replace: 'y' } } }] },
    { role: 'tool', content: JSON.stringify({ path: 'a.txt', edited: true }) },
    { role: 'assistant', content: 'done' },
  ],
  turns: [{ turn: 0, endClass: 'tool-calls' }, { turn: 1, endClass: 'stop' }],
  result: { response: 'done', turnsUsed: 2, prompt_eval_count: 120, eval_count: 9 },
});

test('buildTrajectory keeps meta, turns, tool-call arguments and the result summary', () => {
  const t = sample();
  assert.equal(t.version, 1);
  assert.equal(t.taskId, 'task/one');
  assert.equal(t.durationMs, 90000);
  assert.equal(t.turns.length, 2);
  assert.equal(t.messages[1].tool_calls[0].name, 'edit_file');
  assert.deepEqual(JSON.parse(t.messages[1].tool_calls[0].arguments), { path: 'a.txt', find: 'x', replace: 'y' });
  assert.equal(t.messages[1].thinkingChars, 3);
  assert.equal(t.messages.length, 4, 'the final reply is already the last message: not appended twice');
  assert.deepEqual(t.result, { responseChars: 4, turnsUsed: 2, forcedSummary: false, forcedSummaryReason: null, toolsDisabled: false, promptEvalCount: 120, evalCount: 9 });
});

test('over-long message content and tool-call arguments are cut with a marker', () => {
  const big = 'z'.repeat(tj.MAX_MESSAGE_CHARS + 500);
  const m = tj.capMessage({ role: 'tool', content: big });
  assert.equal(m.content.length < big.length, true);
  assert.match(m.content, /\[trajectory: truncated 500 more chars\]$/);
  const c = tj.capMessage({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { content: big } } }] });
  assert.match(c.tool_calls[0].arguments, /\[trajectory: truncated \d+ more chars\]$/);
  assert.equal(tj.capMessage({ role: 'user', content: 'short' }).content, 'short');
});

test('writeTrajectory writes a gzip JSON under instances/trajectories/<taskId>/, readable back; list and CLI see it', () => {
  const pd = tmpDir('traj-write-');
  const fp = withEnv('AGENT_MANAGER_TRAJECTORY', undefined, () => tj.writeTrajectory(pd, sample()));
  assert.ok(fp && fp.endsWith('.json.gz'));
  assert.equal(path.dirname(fp), path.join(pd, 'instances', 'trajectories', 'task_one'));
  assert.equal(JSON.parse(zlib.gunzipSync(fs.readFileSync(fp)).toString()).stage, 'agentic-write');
  assert.equal(tj.readTrajectory(fp).messages.length, 4);
  const rows = tj.listTrajectories(pd, 'task/one');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, 'agentic-write');
  assert.equal(rows[0].startedAt, '20261018T100000Z');
  const env = { ...process.env, AGENT_MANAGER_PIPELINE_DIR: pd };
  const list = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'trajectory.js'), 'list', 'task/one', '--json'], { env, encoding: 'utf8' }));
  assert.equal(list[0].file, fp);
  const shown = execFileSync(process.execPath, [path.join(__dirname, 'trajectory.js'), 'show', fp], { env, encoding: 'utf8' });
  assert.match(shown, /task\/one agentic-write worker-3090/);
  assert.match(shown, /-> edit_file/);
});

test('AGENT_MANAGER_TRAJECTORY=off (or 0/false) writes nothing', () => {
  for (const v of ['off', 'OFF', '0', 'false']) {
    const pd = tmpDir('traj-off-');
    assert.equal(withEnv('AGENT_MANAGER_TRAJECTORY', v, () => tj.writeTrajectory(pd, sample())), null, v);
    assert.equal(fs.existsSync(path.join(pd, 'instances', 'trajectories')), false, v);
  }
});

test('writeTrajectory never throws on an unwritable pipeline dir or a missing one', () => {
  const pd = tmpDir('traj-bad-');
  fs.writeFileSync(path.join(pd, 'blocker'), 'file');
  assert.equal(tj.writeTrajectory(path.join(pd, 'blocker', 'x'), sample()), null);
  assert.equal(tj.writeTrajectory(null, sample()), null);
});

test('pruneTrajectories removes files past retention and empty task dirs; maybePrune runs at most once per interval', () => {
  const pd = tmpDir('traj-prune-');
  const oldFp = tj.writeTrajectory(pd, { ...sample(), taskId: 'old-task' });
  const newFp = tj.writeTrajectory(pd, { ...sample(), taskId: 'new-task' });
  const now = Date.now();
  const old = new Date(now - (tj.DEFAULT_RETENTION_DAYS + 1) * 86400000);
  fs.utimesSync(oldFp, old, old);
  assert.equal(tj.pruneTrajectories(pd, { now }), 1);
  assert.equal(fs.existsSync(oldFp), false);
  assert.equal(fs.existsSync(path.dirname(oldFp)), false, 'empty task dir removed');
  assert.equal(fs.existsSync(newFp), true);

  // The first writes above already pruned once and touched the marker: within the interval it does not run again.
  assert.equal(tj.maybePrune(pd, now), false);
  assert.equal(tj.maybePrune(pd, now + tj.PRUNE_INTERVAL_MS + 1000), true);
});

test('buildTrajectory appends the final response when the loop returned it without pushing it onto messages', () => {
  const t = tj.buildTrajectory({ messages: [{ role: 'system', content: 's' }, { role: 'tool', content: '{}' }], result: { response: 'final answer' } });
  assert.deepEqual(t.messages[t.messages.length - 1], { role: 'assistant', final: true, content: 'final answer' });
});
