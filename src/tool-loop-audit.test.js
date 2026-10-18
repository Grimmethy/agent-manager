'use strict';

// Tests for tool-loop-audit.js (brain-dump 1889): the turn-end / tool-outcome classifiers,
// the best-effort writer and its off switch, the no-paths-no-text privacy rule, and the
// summary/CLI read side. Tool outcomes are driven through the REAL editFileTool /
// writeFileTool so a reworded error message fails here instead of mis-bucketing live.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const audit = require('./tool-loop-audit.js');
const { editFileTool, writeFileTool } = require('./local-tool-fs-tools.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withAuditEnv(value, fn) {
  const prev = process.env.AGENT_MANAGER_TOOL_LOOP_AUDIT;
  if (value === undefined) delete process.env.AGENT_MANAGER_TOOL_LOOP_AUDIT;
  else process.env.AGENT_MANAGER_TOOL_LOOP_AUDIT = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_TOOL_LOOP_AUDIT;
    else process.env.AGENT_MANAGER_TOOL_LOOP_AUDIT = prev;
  }
}

// --- classifyTurnEnd -------------------------------------------------------------------

test('classifyTurnEnd: tool calls win regardless of done_reason', () => {
  assert.deepEqual(audit.classifyTurnEnd({ doneReason: 'length', toolCallCount: 1, content: '' }), { endClass: 'tool-calls', heuristic: false });
});

test('classifyTurnEnd: stop, length, other, and a missing done_reason as unknown', () => {
  assert.equal(audit.classifyTurnEnd({ doneReason: 'stop', toolCallCount: 0, content: 'x' }).endClass, 'stop');
  assert.equal(audit.classifyTurnEnd({ doneReason: 'length', toolCallCount: 0, content: 'I was in the middle of thinking about' }).endClass, 'length');
  assert.equal(audit.classifyTurnEnd({ doneReason: 'load', toolCallCount: 0, content: '' }).endClass, 'other');
  assert.deepEqual(audit.classifyTurnEnd({ doneReason: null, toolCallCount: 0, content: 'x' }), { endClass: 'unknown', heuristic: false });
  assert.equal(audit.classifyTurnEnd({ doneReason: undefined, toolCallCount: 0, content: 'x' }).endClass, 'unknown');
});

test('classifyTurnEnd heuristic POSITIVE: length + no tool_calls + a cut-off tool-call payload -> length-tool-call-suspected, flagged heuristic', () => {
  const fixtures = [
    'Now I will apply the fix.\n<tool_call>\n{"name": "edit_file", "argu',
    '{"function": {"name": "edit_file", "arguments": {"path": "src/a.js", "find": "con',
    'Calling it: {"name": "write_file", "arguments": {"path": "x',
  ];
  for (const content of fixtures) {
    assert.deepEqual(audit.classifyTurnEnd({ doneReason: 'length', toolCallCount: 0, content }),
      { endClass: 'length-tool-call-suspected', heuristic: true }, content);
  }
});

test('classifyTurnEnd heuristic NEGATIVE: a tool name in prose, or the same payload on a normal stop, is not suspected', () => {
  assert.equal(audit.classifyTurnEnd({ doneReason: 'length', toolCallCount: 0, content: 'Next I will call edit_file on src/a.js to change the name' }).endClass, 'length');
  assert.equal(audit.classifyTurnEnd({ doneReason: 'stop', toolCallCount: 0, content: '<tool_call>{"name": "edit_file", "arguments": {}}' }).endClass, 'stop');
});

// --- classifyToolOutcome via the real tools -----------------------------------------------

test('classifyToolOutcome maps every real editFileTool result branch to its own class', () => {
  const dir = tmpDir('tool-loop-audit-edit-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\nbeta\nbeta\n');
  const roots = [dir];
  const cases = [
    [{ path: 'a.txt', find: 'gamma', replace: 'x' }, 'not-found'],
    [{ path: 'a.txt', find: 'beta', replace: 'x' }, 'ambiguous'],
    [{ path: '../outside.txt', find: 'alpha', replace: 'x' }, 'path-refused'],
    [{ path: 'a.txt', replace: 'x' }, 'bad-args'],
    [{ path: '', find: 'alpha', replace: 'x' }, 'bad-args'],
    [{ path: 'missing.txt', find: 'alpha', replace: 'x' }, 'io-error'],
    [{ path: 'a.txt', find: 'alpha', replace: 'ALPHA' }, 'applied'],
  ];
  for (const [args, expected] of cases) {
    const result = editFileTool(roots, args);
    assert.equal(audit.classifyToolOutcome({ tool: 'edit_file', result }), expected, JSON.stringify(result));
  }
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'ALPHA\nbeta\nbeta\n');
});

test('classifyToolOutcome maps real writeFileTool results, plus a thrown tool and an unrecognised error', () => {
  const dir = tmpDir('tool-loop-audit-write-');
  const roots = [dir];
  assert.equal(audit.classifyToolOutcome({ tool: 'write_file', result: writeFileTool(roots, { path: 'n.txt', content: 'hi' }) }), 'applied');
  assert.equal(audit.classifyToolOutcome({ tool: 'write_file', result: writeFileTool(roots, { path: '../n.txt', content: 'hi' }) }), 'path-refused');
  assert.equal(audit.classifyToolOutcome({ tool: 'write_file', result: writeFileTool(roots, { content: 'hi' }) }), 'bad-args');
  // executeToolCalls' catch shape (local-tool-client.js): `tool ${name} failed: ${e.message}`.
  assert.equal(audit.classifyToolOutcome({ tool: 'edit_file', result: { error: 'tool edit_file failed: boom' } }), 'tool-threw');
  assert.equal(audit.classifyToolOutcome({ tool: 'edit_file', result: { error: 'something new' } }), 'other-error');
  assert.equal(audit.classifyToolOutcome({ tool: 'edit_file', result: null }), 'other-error');
});

// --- writer: off switch, never throws, privacy ------------------------------------------

test('logToolLoopEvent writes by default and writes nothing when AGENT_MANAGER_TOOL_LOOP_AUDIT is off/0/false', () => {
  const on = tmpDir('tool-loop-audit-on-');
  withAuditEnv(undefined, () => audit.logToolLoopEvent(on, 'turn-end', { turn: 0 }));
  const lines = fs.readFileSync(audit.auditPath(on), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).type, 'turn-end');
  for (const v of ['off', 'OFF', '0', 'false']) {
    const off = tmpDir('tool-loop-audit-off-');
    withAuditEnv(v, () => audit.logToolLoopEvent(off, 'turn-end', { turn: 0 }));
    assert.equal(fs.existsSync(audit.auditPath(off)), false, v);
  }
});

test('logToolLoopEvent never throws on an unwritable pipeline dir, or with none', () => {
  const dir = tmpDir('tool-loop-audit-bad-');
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file, not a dir');
  assert.doesNotThrow(() => withAuditEnv(undefined, () => audit.logToolLoopEvent(path.join(blocker, 'pipeline'), 'turn-end', { turn: 0 })));
  assert.doesNotThrow(() => audit.logToolLoopEvent(null, 'turn-end', { turn: 0 }));
});

test('privacy: no file path, argument value or model text reaches the log -- sizes and classes only', () => {
  const dir = tmpDir('tool-loop-audit-privacy-');
  const SENTINEL_PATH = 'secret-dir-7f3a/private-notes.md';
  const SENTINEL_TEXT = 'SENTINEL_PRIVATE_TEXT_91c2';
  const ctx = { source: 'manual', taskId: 't1', stage: 'agentic-write', lane: 'worker-x', model: 'm', turn: 0, phase: 'loop' };
  withAuditEnv(undefined, () => {
    audit.logToolLoopEvent(dir, 'turn-end', audit.buildTurnEndEntry(ctx, {
      message: { content: `thinking about ${SENTINEL_PATH} ${SENTINEL_TEXT}`, thinking: SENTINEL_TEXT, tool_calls: [{ function: { name: 'edit_file', arguments: { path: SENTINEL_PATH, find: SENTINEL_TEXT } } }] },
      usage: { prompt_eval_count: 10, eval_count: 5 }, doneReason: 'stop',
    }));
    for (const e of audit.buildToolOutcomeEntries(ctx, [
      { tool: 'edit_file', args: { path: SENTINEL_PATH, find: SENTINEL_TEXT, replace: SENTINEL_TEXT }, result: { error: `"find" text not found verbatim in ${SENTINEL_PATH} -- no change made.` } },
      { tool: 'write_file', args: { path: SENTINEL_PATH, content: SENTINEL_TEXT }, result: { path: SENTINEL_PATH, written: true } },
      { tool: 'read_file', args: { path: SENTINEL_PATH }, result: { content: SENTINEL_TEXT } },
    ])) audit.logToolLoopEvent(dir, 'tool-outcome', e);
  });
  const raw = fs.readFileSync(audit.auditPath(dir), 'utf8');
  assert.ok(!raw.includes('secret-dir-7f3a'), 'no path');
  assert.ok(!raw.includes('private-notes'), 'no path');
  assert.ok(!raw.includes('SENTINEL_PRIVATE_TEXT'), 'no text');
  const entries = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries.map((e) => e.type), ['turn-end', 'tool-outcome', 'tool-outcome'], 'read_file is not a tool-outcome');
  assert.equal(entries[0].thinkingChars, SENTINEL_TEXT.length);
  assert.equal(entries[1].findChars, SENTINEL_TEXT.length);
  assert.equal(entries[2].contentChars, SENTINEL_TEXT.length);
});

// --- read side ---------------------------------------------------------------------------

test('buildSummary folds entries per lane+model with endClass counts, null done_reason count and edit_file miss rate', () => {
  const base = { lane: 'worker-p40', model: 'm1' };
  const rows = audit.buildSummary([
    { ...base, type: 'turn-end', endClass: 'tool-calls', doneReason: 'stop' },
    { ...base, type: 'turn-end', endClass: 'unknown', doneReason: null },
    { ...base, type: 'turn-end', endClass: 'length-tool-call-suspected', doneReason: 'length', heuristic: true },
    { ...base, type: 'tool-outcome', tool: 'edit_file', outcome: 'not-found' },
    { ...base, type: 'tool-outcome', tool: 'edit_file', outcome: 'applied' },
    { lane: 'worker-3090', model: 'm2', type: 'turn-end', endClass: 'stop', doneReason: 'stop' },
  ]);
  assert.equal(rows.length, 2);
  const p40 = rows[0];
  assert.equal(p40.turns, 3);
  assert.equal(p40.doneReasonNull, 1);
  assert.equal(p40.heuristic, 1);
  assert.deepEqual(p40.endClass, { 'tool-calls': 1, unknown: 1, 'length-tool-call-suspected': 1 });
  assert.equal(p40.tools.edit_file.total, 2);
  assert.equal(p40.tools.edit_file.missRate, 0.5);
});

test('readToolLoopAudit skips malformed lines and honours since/type; CLI --json prints the summary', () => {
  const dir = tmpDir('tool-loop-audit-cli-');
  fs.mkdirSync(path.join(dir, 'instances'));
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  fs.writeFileSync(audit.auditPath(dir), [
    JSON.stringify({ at: old, type: 'turn-end', lane: 'worker-p40', model: 'm', endClass: 'stop', doneReason: 'stop' }),
    'not json',
    JSON.stringify({ at: new Date().toISOString(), type: 'turn-end', lane: 'worker-p40', model: 'm', endClass: 'length', doneReason: 'length' }),
    JSON.stringify({ at: new Date().toISOString(), type: 'tool-outcome', lane: 'worker-p40', model: 'm', tool: 'edit_file', outcome: 'ambiguous' }),
  ].join('\n') + '\n');
  assert.equal(audit.readToolLoopAudit(dir).length, 3);
  assert.equal(audit.readToolLoopAudit(dir, { type: 'tool-outcome' }).length, 1);
  const out = execFileSync(process.execPath, [path.join(__dirname, 'tool-loop-audit.js'), '7', '--json'], {
    env: { ...process.env, AGENT_MANAGER_PIPELINE_DIR: dir }, encoding: 'utf8',
  });
  const rows = JSON.parse(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turns, 1, 'the 30-day-old line is outside the 7-day window');
  assert.deepEqual(rows[0].endClass, { length: 1 });
  assert.equal(rows[0].tools.edit_file.missRate, 1);
});
