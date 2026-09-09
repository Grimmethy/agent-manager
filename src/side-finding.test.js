'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  injectSideFindingInstruction, extractSideFindings, writeSideFindingInbox, inboxDir,
  MAX_SIDE_FINDINGS_PER_RESPONSE,
} = require('./side-finding.js');

test('injectSideFindingInstruction appends the blurb once', () => {
  const injected = injectSideFindingInstruction('Do the task.');
  assert.match(injected, /Do the task\./);
  assert.match(injected, /SIDE-FINDING:/);
});

test('injectSideFindingInstruction is idempotent -- does not double up on a retried prompt', () => {
  const once = injectSideFindingInstruction('Do the task.');
  const twice = injectSideFindingInstruction(once);
  assert.equal(twice, once);
  assert.equal((twice.match(/SIDE-FINDING:/g) || []).length, 1);
});

test('extractSideFindings is a no-op on text with no marker', () => {
  const result = extractSideFindings('Just a normal answer.\nRESOLUTION: implemented');
  assert.equal(result.cleanText, 'Just a normal answer.\nRESOLUTION: implemented');
  assert.deepEqual(result.findings, []);
});

test('extractSideFindings pulls a single block out and strips it from cleanText', () => {
  const text = 'Here is the fix.\n\nSIDE-FINDING: Dead code in gpu-arbiter.js\nfindTicket() is never called anywhere.\n\nRESOLUTION: implemented';
  const result = extractSideFindings(text);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, 'Dead code in gpu-arbiter.js');
  assert.match(result.findings[0].body, /findTicket\(\) is never called/);
  assert.doesNotMatch(result.cleanText, /SIDE-FINDING/);
  assert.match(result.cleanText, /Here is the fix\./);
  assert.match(result.cleanText, /RESOLUTION: implemented/, 'an existing RESOLUTION: line elsewhere in the text must survive untouched');
});

test('extractSideFindings: a finding immediately followed by RESOLUTION: with only a blank line between must not swallow the RESOLUTION line', () => {
  const text = 'SIDE-FINDING: Unrelated thing I noticed\nWorth a look later.\n\nRESOLUTION: implemented';
  const result = extractSideFindings(text);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].body, 'Worth a look later.');
  assert.match(result.cleanText, /RESOLUTION: implemented/, 'must survive -- this exact bug was caught and fixed during development');
});

test('extractSideFindings pulls multiple distinct blocks', () => {
  const text = [
    'SIDE-FINDING: First issue',
    'Body of the first one.',
    '',
    'SIDE-FINDING: Second issue',
    'Body of the second one.',
  ].join('\n');
  const result = extractSideFindings(text);
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].title, 'First issue');
  assert.equal(result.findings[1].title, 'Second issue');
});

test('extractSideFindings drops a block with no body rather than throwing', () => {
  const text = 'Real answer.\n\nSIDE-FINDING: Title with nothing after it';
  const result = extractSideFindings(text);
  assert.equal(result.findings.length, 0);
});

test('extractSideFindings drops a block that echoes the instruction template verbatim (placeholder title/body)', () => {
  // Seen live: brain-dump serials 659/661 carried "<1-3 sentences of detail>" verbatim
  // from the SIDE_FINDING_INSTRUCTION example, and one was still promoted to a task.
  const placeholderBody = extractSideFindings('Answer.\n\nSIDE-FINDING: Inconsistent tiers\n<1-3 sentences of detail>\n');
  assert.equal(placeholderBody.findings.length, 0);
  const placeholderTitle = extractSideFindings('Answer.\n\nSIDE-FINDING: <one-line title>\nA plausible-looking body.\n');
  assert.equal(placeholderTitle.findings.length, 0);
  // a real finding with normal prose is unaffected
  const real = extractSideFindings('Answer.\n\nSIDE-FINDING: A real thing\nThe worker log rotates but the index is never truncated.\n');
  assert.equal(real.findings.length, 1);
});

test('extractSideFindings de-duplicates an identical title repeated in one response', () => {
  const text = [
    'SIDE-FINDING: Same thing',
    'First mention.',
    'SIDE-FINDING: Same thing',
    'Second mention, same title.',
  ].join('\n');
  const result = extractSideFindings(text);
  assert.equal(result.findings.length, 1);
});

test('extractSideFindings caps at MAX_SIDE_FINDINGS_PER_RESPONSE', () => {
  const blocks = Array.from({ length: MAX_SIDE_FINDINGS_PER_RESPONSE + 5 }, (_, i) => `SIDE-FINDING: Issue ${i}\nBody ${i}.`);
  const result = extractSideFindings(blocks.join('\n'));
  assert.equal(result.findings.length, MAX_SIDE_FINDINGS_PER_RESPONSE);
});

test('writeSideFindingInbox writes one uniquely-named file with the expected shape, and never throws when pipelineDir is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'side-finding-test-'));
  writeSideFindingInbox({ title: 'A real finding', body: 'Some detail.' }, {
    source: 'observability_fix', taskId: 'observability-fix-ac-1', stage: 'implement', pipelineDir: dir,
  });
  const files = fs.readdirSync(inboxDir(dir));
  assert.equal(files.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(inboxDir(dir), files[0]), 'utf8'));
  assert.equal(record.title, 'A real finding');
  assert.equal(record.body, 'Some detail.');
  assert.equal(record.source, 'observability_fix');
  assert.equal(record.taskId, 'observability-fix-ac-1');
  assert.equal(record.stage, 'implement');
  assert.equal(record.conceptId, null);
  assert.ok(record.extractedAt);

  assert.doesNotThrow(() => writeSideFindingInbox({ title: 'x', body: 'y' }, {}));
});

test('writeSideFindingInbox stores an optional conceptId for concept-directed research', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'side-finding-test-'));
  writeSideFindingInbox({ title: 'A finding', body: 'Detail.' }, {
    pipelineDir: dir, conceptId: 'concept-web-search-capability-abc123',
  });
  const files = fs.readdirSync(inboxDir(dir));
  const record = JSON.parse(fs.readFileSync(path.join(inboxDir(dir), files[0]), 'utf8'));
  assert.equal(record.conceptId, 'concept-web-search-capability-abc123');
});

test('writeSideFindingInbox writing two findings produces two distinct files, never overwriting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'side-finding-test-'));
  writeSideFindingInbox({ title: 'One', body: 'A' }, { pipelineDir: dir });
  writeSideFindingInbox({ title: 'Two', body: 'B' }, { pipelineDir: dir });
  assert.equal(fs.readdirSync(inboxDir(dir)).length, 2);
});
