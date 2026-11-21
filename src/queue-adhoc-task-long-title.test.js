'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { queueAdhocTask, slugify } = require('./queue-adhoc-task.js');

// Exactly 230 characters, with spaces, so the slug is far longer than the 100-character cap.
const LONG_TITLE = 'Scheduled audit task '.repeat(20).slice(0, 230);

function tmpPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-long-title-'));
  fs.writeFileSync(path.join(dir, 'task-domains.json'), JSON.stringify({ default: {}, other_domain: {} }));
  return dir;
}

// Runs fn with Date.now returning the given values in turn (the last one repeats), then restores Date.now.
function withFixedNow(values, fn) {
  const real = Date.now;
  let i = 0;
  Date.now = () => values[Math.min(i++, values.length - 1)];
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

function queue(dir, title) {
  return queueAdhocTask(
    { title, promptContext: { rawText: 'x' } },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
}

test('a 230-character title queues into exactly one file whose name is at most 125 bytes', () => {
  assert.equal(LONG_TITLE.length, 230);
  const dir = tmpPipeline();
  withFixedNow([1000], () => queue(dir, LONG_TITLE));
  const files = fs.readdirSync(path.join(dir, 'queue', 'adhoc'));
  assert.equal(files.length, 1);
  assert.ok(Buffer.byteLength(files[0]) <= 125, `file name is ${Buffer.byteLength(files[0])} bytes`);
});

test('the id is bounded: adhoc- + at most 100 slug characters + - + 13 digits', () => {
  const dir = tmpPipeline();
  const { record } = withFixedNow([1234567890123], () => queue(dir, LONG_TITLE));
  assert.match(record.id, /^adhoc-.{1,100}-1234567890123$/);
  assert.ok(record.id.length <= 'adhoc-'.length + 100 + 1 + 13, `id is ${record.id.length} characters`);
});

test('the record title is the full original long title, on disk too', () => {
  const dir = tmpPipeline();
  const { record, filePath } = withFixedNow([1000], () => queue(dir, LONG_TITLE));
  assert.equal(record.title, LONG_TITLE);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).title, LONG_TITLE);
});

test('a slug of exactly 100 characters keeps its full id, unchanged by the cap', () => {
  const dir = tmpPipeline();
  const title = 'a'.repeat(100);
  const { record } = withFixedNow([1000], () => queue(dir, title));
  assert.equal(record.id, `adhoc-${'a'.repeat(100)}-1000`);
});

test('a short title gives the same id as before the cap existed', () => {
  const dir = tmpPipeline();
  const title = 'fix login bug';
  const { record } = withFixedNow([1234567890123], () => queue(dir, title));
  assert.equal(record.id, `adhoc-${slugify(title)}-1234567890123`);
  assert.equal(record.id, 'adhoc-fix-login-bug-1234567890123');
});

test('two long titles that differ only after character 100 get distinct ids when queued in turn', () => {
  const dir = tmpPipeline();
  // Both slugs are cut to the same 100 'a' characters, so only the Date.now suffix tells them apart.
  const a = 'a'.repeat(120) + ' first';
  const b = 'a'.repeat(120) + ' second';
  const ra = withFixedNow([1000], () => queue(dir, a)).record;
  const rb = withFixedNow([1001], () => queue(dir, b)).record;
  assert.notEqual(ra.id, rb.id);
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'adhoc')).length, 2);
});
