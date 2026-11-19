'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeSideFindingInbox, inboxDir } = require('../src/side-finding.js');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-atomic-'));
}

function listInbox(pipelineDir) {
  const dir = inboxDir(pipelineDir);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function findAnySf(dir) {
  const hits = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...findAnySf(full));
    else if (/^sf-.*\.json$/.test(entry.name)) hits.push(full);
  }
  return hits;
}

test('happy path: one sf-*.json that parses and matches the inputs', (t) => {
  const pipelineDir = makeDir();
  t.after(() => fs.rmSync(pipelineDir, { recursive: true, force: true }));

  writeSideFindingInbox(
    { title: 'Dead code in foo.js', body: 'bar() is never called.' },
    { source: 'implement', taskId: 'task-123', stage: 'implement', pipelineDir },
  );

  const files = listInbox(pipelineDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^sf-.*\.json$/);
  const rec = JSON.parse(fs.readFileSync(path.join(inboxDir(pipelineDir), files[0]), 'utf8'));
  assert.equal(rec.title, 'Dead code in foo.js');
  assert.equal(rec.body, 'bar() is never called.');
  assert.equal(rec.source, 'implement');
  assert.equal(rec.taskId, 'task-123');
  assert.equal(rec.stage, 'implement');
});

test('same title twice yields two distinct files', (t) => {
  const pipelineDir = makeDir();
  t.after(() => fs.rmSync(pipelineDir, { recursive: true, force: true }));

  const finding = { title: 'Same title', body: 'Same body.' };
  const opts = { source: 's', taskId: 't', stage: 'x', pipelineDir };
  writeSideFindingInbox(finding, opts);
  writeSideFindingInbox(finding, opts);

  const files = listInbox(pipelineDir);
  assert.equal(files.length, 2);
  assert.notEqual(files[0], files[1]);
  for (const f of files) {
    const rec = JSON.parse(fs.readFileSync(path.join(inboxDir(pipelineDir), f), 'utf8'));
    assert.equal(rec.title, 'Same title');
  }
});

test('no temp leftovers: inbox holds only sf-*.json files', (t) => {
  const pipelineDir = makeDir();
  t.after(() => fs.rmSync(pipelineDir, { recursive: true, force: true }));

  for (let i = 0; i < 3; i++) {
    writeSideFindingInbox(
      { title: `Finding ${i}`, body: `Body ${i}` },
      { source: 's', taskId: 't', stage: 'x', pipelineDir },
    );
  }
  const files = listInbox(pipelineDir);
  assert.equal(files.length, 3);
  for (const f of files) assert.match(f, /^sf-.+\.json$/);
});

test('failure stays silent: no throw and no partial sf-*.json', (t) => {
  const pipelineDir = makeDir();
  t.after(() => fs.rmSync(pipelineDir, { recursive: true, force: true }));
  // `queue` is a regular file, so mkdir of queue/side-findings-inbox fails deterministically.
  fs.writeFileSync(path.join(pipelineDir, 'queue'), 'not a directory');
  const warn = t.mock.method(console, 'warn', () => {});

  assert.doesNotThrow(() => writeSideFindingInbox(
    { title: 'T', body: 'B' },
    { source: 's', taskId: 't', stage: 'x', pipelineDir },
  ));

  assert.deepEqual(findAnySf(pipelineDir), []);
  assert.equal(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /\[side-finding\] failed to write inbox entry/);
});

test('missing pipelineDir returns without writing', (t) => {
  const canary = makeDir();
  t.after(() => fs.rmSync(canary, { recursive: true, force: true }));
  const cwdQueueBefore = fs.existsSync(path.join(process.cwd(), 'queue', 'side-findings-inbox'));

  assert.doesNotThrow(() => writeSideFindingInbox({ title: 'T', body: 'B' }, { source: 's', taskId: 't', stage: 'x' }));
  assert.doesNotThrow(() => writeSideFindingInbox({ title: 'T', body: 'B' }, { source: 's', taskId: 't', stage: 'x', pipelineDir: '' }));

  assert.deepEqual(fs.readdirSync(canary), []);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'queue', 'side-findings-inbox')), cwdQueueBefore);
});
