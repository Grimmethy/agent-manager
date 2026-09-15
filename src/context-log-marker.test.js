'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  injectContextLogInstruction, extractContextLog, writeContextLogInbox, inboxDir,
} = require('./context-log-marker.js');

test('injectContextLogInstruction appends the blurb once', () => {
  const injected = injectContextLogInstruction('Do the task.');
  assert.match(injected, /Do the task\./);
  assert.match(injected, /CONTEXT-LOG:/);
});

test('injectContextLogInstruction is idempotent -- does not double up on a retried prompt', () => {
  const once = injectContextLogInstruction('Do the task.');
  const twice = injectContextLogInstruction(once);
  assert.equal(twice, once);
  assert.equal((twice.match(/CONTEXT-LOG:/g) || []).length, 1);
});

test('extractContextLog is a no-op on text with no marker', () => {
  const result = extractContextLog('Just a normal answer.\nRESOLUTION: implemented');
  assert.equal(result.cleanText, 'Just a normal answer.\nRESOLUTION: implemented');
  assert.equal(result.entry, null);
});

test('extractContextLog pulls a summary + TASK-REF and strips both from cleanText', () => {
  const text = 'Here is my answer.\n\nCONTEXT-LOG: Discussed the build_graph decompose hub and confirmed the target module.\nTASK-REF: adhoc-file-decompose-hub-1789502642555\n';
  const result = extractContextLog(text);
  assert.ok(result.entry);
  assert.match(result.entry.summary, /build_graph decompose hub/);
  assert.equal(result.entry.taskRef, 'adhoc-file-decompose-hub-1789502642555');
  assert.doesNotMatch(result.cleanText, /CONTEXT-LOG/);
  assert.doesNotMatch(result.cleanText, /TASK-REF/);
  assert.match(result.cleanText, /Here is my answer\./);
});

test('extractContextLog with no TASK-REF line -- taskRef is null, not an error', () => {
  const text = 'answer\n\nCONTEXT-LOG: General chat, no specific task involved.\n';
  const result = extractContextLog(text);
  assert.ok(result.entry);
  assert.equal(result.entry.summary, 'General chat, no specific task involved.');
  assert.equal(result.entry.taskRef, null);
});

test('extractContextLog: text after the block (e.g. a RESOLUTION: line) survives untouched', () => {
  const text = 'CONTEXT-LOG: Summary here.\nTASK-REF: t-1\n\nRESOLUTION: needs-human-decision\nwhich approach?';
  const result = extractContextLog(text);
  assert.equal(result.entry.taskRef, 't-1');
  assert.match(result.cleanText, /RESOLUTION: needs-human-decision/);
  assert.match(result.cleanText, /which approach\?/);
});

test('extractContextLog: a TASK-REF line separated by a blank line is NOT consumed as the ref (left in cleanText)', () => {
  const text = 'CONTEXT-LOG: Summary here.\n\nTASK-REF: t-1\n';
  const result = extractContextLog(text);
  assert.equal(result.entry.taskRef, null);
  assert.match(result.cleanText, /TASK-REF: t-1/);
});

test('extractContextLog drops a block with no summary rather than throwing', () => {
  const text = 'Real answer.\n\nCONTEXT-LOG:\nTASK-REF: t-1\n';
  const result = extractContextLog(text);
  assert.equal(result.entry, null);
});

test('extractContextLog drops a block that echoes the instruction template verbatim', () => {
  const result = extractContextLog('answer\n\nCONTEXT-LOG: <one-paragraph distillation>\nTASK-REF: <task id>\n');
  assert.equal(result.entry, null);
  assert.doesNotMatch(result.cleanText, /CONTEXT-LOG/);
});

test('extractContextLog: only the first well-formed block becomes entry, but every block is stripped', () => {
  const text = 'CONTEXT-LOG: First one.\n\nCONTEXT-LOG: Second one.\n';
  const result = extractContextLog(text);
  assert.equal(result.entry.summary, 'First one.');
  assert.doesNotMatch(result.cleanText, /CONTEXT-LOG/);
});

test('writeContextLogInbox writes one uniquely-named file with the expected shape, and never throws on missing args', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-log-test-'));
  writeContextLogInbox({ summary: 'A real summary.', taskRef: 't-1' }, {
    sessionId: 'chat-123-abcdef', pipelineDir: dir,
  });
  const files = fs.readdirSync(inboxDir(dir));
  assert.equal(files.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(inboxDir(dir), files[0]), 'utf8'));
  assert.equal(record.sessionId, 'chat-123-abcdef');
  assert.equal(record.summary, 'A real summary.');
  assert.equal(record.taskRef, 't-1');
  assert.ok(record.extractedAt);

  assert.doesNotThrow(() => writeContextLogInbox({ summary: 'x' }, {}));
  assert.doesNotThrow(() => writeContextLogInbox({ summary: 'x' }, { pipelineDir: dir }));
});

test('writeContextLogInbox with no taskRef stores null, not undefined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-log-test-'));
  writeContextLogInbox({ summary: 'A summary.' }, { sessionId: 'chat-1', pipelineDir: dir });
  const files = fs.readdirSync(inboxDir(dir));
  const record = JSON.parse(fs.readFileSync(path.join(inboxDir(dir), files[0]), 'utf8'));
  assert.equal(record.taskRef, null);
});

test('writeContextLogInbox writing two entries produces two distinct files, never overwriting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-log-test-'));
  writeContextLogInbox({ summary: 'One' }, { sessionId: 's1', pipelineDir: dir });
  writeContextLogInbox({ summary: 'Two' }, { sessionId: 's1', pipelineDir: dir });
  assert.equal(fs.readdirSync(inboxDir(dir)).length, 2);
});
