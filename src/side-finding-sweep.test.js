'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweep } = require('./side-finding-sweep.js');
const { writeSideFindingInbox } = require('./side-finding.js');

function tmpPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'side-finding-sweep-'));
  fs.writeFileSync(path.join(dir, 'brain-dump.json'), JSON.stringify({ entries: [] }, null, 2));
  return dir;
}

function readBrainDump(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'brain-dump.json'), 'utf8'));
}

test('a new finding with no existing similar entry creates a fresh captured entry with count:1', async () => {
  const dir = tmpPipeline();
  writeSideFindingInbox({ title: 'Dead code in gpu-arbiter.js', body: 'findTicket() is never called anywhere.' }, {
    source: 'arch_review', taskId: 'arch-review-ac-1', pipelineDir: dir,
  });

  const s = await sweep({ pipelineDir: dir });

  assert.equal(s.scanned, 1);
  assert.equal(s.created, 1);
  assert.equal(s.merged, 0);
  const data = readBrainDump(dir);
  assert.equal(data.entries.length, 1);
  const entry = data.entries[0];
  assert.match(entry.id, /^bd-\d+-/);
  assert.equal(entry.serial, 1);
  assert.equal(entry.status, 'captured');
  assert.equal(entry.count, 1);
  assert.deepEqual(entry.seenIn, ['arch-review-ac-1']);
  assert.equal(entry.raisedBy.source, 'arch_review');
  assert.match(entry.rawText, /Dead code in gpu-arbiter\.js/);
  assert.match(entry.rawText, /findTicket\(\) is never called/);
});

test('a near-duplicate finding increments the existing machine-raised entry instead of creating a new one', async () => {
  const dir = tmpPipeline();
  writeSideFindingInbox(
    { title: 'queue-watcher silently swallows a bwrap timeout', body: 'The bwrap sandbox timeout error is caught and dropped without logging.' },
    { source: 'observability_fix', taskId: 'task-1', pipelineDir: dir },
  );
  await sweep({ pipelineDir: dir });

  writeSideFindingInbox(
    { title: 'queue-watcher script swallows the bwrap sandbox timeout silently', body: 'It catches the bwrap sandbox timeout error and drops it with no logging.' },
    { source: 'performance_fix', taskId: 'task-2', pipelineDir: dir },
  );
  const s = await sweep({ pipelineDir: dir });

  assert.equal(s.merged, 1);
  assert.equal(s.created, 0);
  const data = readBrainDump(dir);
  assert.equal(data.entries.length, 1, 'must not have created a second entry');
  const entry = data.entries[0];
  assert.equal(entry.count, 2);
  assert.deepEqual(entry.seenIn, ['task-1', 'task-2']);
});

test('two genuinely unrelated findings both get filed as separate entries', async () => {
  const dir = tmpPipeline();
  writeSideFindingInbox({ title: 'Chat panel truncates long responses', body: 'done_reason length is never checked.' }, { source: 'chat', pipelineDir: dir });
  await sweep({ pipelineDir: dir });
  writeSideFindingInbox({ title: 'Tesla P40 fan sensor reads zero', body: 'Cold boot leaves the RPM sensor at zero until warm.' }, { source: 'observability_fix', pipelineDir: dir });
  const s = await sweep({ pipelineDir: dir });

  assert.equal(s.created, 1);
  assert.equal(s.merged, 0);
  const data = readBrainDump(dir);
  assert.equal(data.entries.length, 2);
});

test('a finding similar to a HUMAN-typed entry (no raisedBy) does not merge into it', async () => {
  const dir = tmpPipeline();
  fs.writeFileSync(path.join(dir, 'brain-dump.json'), JSON.stringify({
    entries: [{ id: 'bd-1-human', serial: 1, capturedAt: new Date().toISOString(), rawText: 'queue-watcher silently swallows a bwrap timeout error somewhere', status: 'captured' }],
  }, null, 2));
  writeSideFindingInbox(
    { title: 'queue-watcher swallows a bwrap timeout', body: 'It catches the bwrap sandbox timeout error and drops it silently.' },
    { source: 'observability_fix', pipelineDir: dir },
  );

  const s = await sweep({ pipelineDir: dir });

  assert.equal(s.created, 1, 'must file a new entry rather than merging into the human note');
  const data = readBrainDump(dir);
  assert.equal(data.entries.length, 2);
  assert.equal(data.entries[0].count, undefined, 'the human entry must be left completely untouched');
});

test('serial numbering continues from the existing max, matching the dashboard\'s own convention', async () => {
  const dir = tmpPipeline();
  fs.writeFileSync(path.join(dir, 'brain-dump.json'), JSON.stringify({
    entries: [{ id: 'bd-1-x', serial: 7, capturedAt: new Date().toISOString(), rawText: 'something', status: 'sorted' }],
  }, null, 2));
  writeSideFindingInbox({ title: 'A fresh finding', body: 'Some real detail here.' }, { pipelineDir: dir });

  await sweep({ pipelineDir: dir });

  const data = readBrainDump(dir);
  const newEntry = data.entries.find((e) => e.serial === 8);
  assert.ok(newEntry, 'new entry must continue the serial sequence, not restart at 1');
});

test('inbox files are deleted after a real (non-dry-run) sweep, but never during a dry run', async () => {
  const dir = tmpPipeline();
  writeSideFindingInbox({ title: 'X', body: 'Y detail here.' }, { pipelineDir: dir });
  const inbox = path.join(dir, 'queue', 'side-findings-inbox');

  const dry = await sweep({ pipelineDir: dir, dryRun: true });
  assert.equal(dry.wouldCreate.length, 1);
  assert.equal(fs.readdirSync(inbox).length, 1, 'dry run must not touch the inbox');
  assert.equal(readBrainDump(dir).entries.length, 0, 'dry run must not touch brain-dump.json');

  await sweep({ pipelineDir: dir });
  assert.equal(fs.readdirSync(inbox).length, 0, 'processed inbox file must be removed');
});

test('kill switch AGENT_MANAGER_SIDE_FINDING_SWEEP=false is a total no-op', async () => {
  const dir = tmpPipeline();
  writeSideFindingInbox({ title: 'X', body: 'Y detail here.' }, { pipelineDir: dir });
  process.env.AGENT_MANAGER_SIDE_FINDING_SWEEP = 'false';
  try {
    const s = await sweep({ pipelineDir: dir });
    assert.equal(s.scanned, 0);
    assert.equal(readBrainDump(dir).entries.length, 0);
    assert.equal(fs.readdirSync(path.join(dir, 'queue', 'side-findings-inbox')).length, 1, 'inbox must be untouched');
  } finally {
    delete process.env.AGENT_MANAGER_SIDE_FINDING_SWEEP;
  }
});

test('sweep is a cheap no-op when the inbox does not exist at all', async () => {
  const dir = tmpPipeline();
  const s = await sweep({ pipelineDir: dir });
  assert.equal(s.scanned, 0);
  assert.equal(s.merged, 0);
  assert.equal(s.created, 0);
});

test('batch cap: only up to BATCH_CAP items are processed in one tick', async () => {
  const { BATCH_CAP } = require('./side-finding-sweep.js');
  const dir = tmpPipeline();
  for (let i = 0; i < BATCH_CAP + 5; i++) {
    writeSideFindingInbox({ title: `Unrelated finding number ${i} about topic ${i}`, body: `Detail specific to finding ${i} only, nothing shared.` }, { pipelineDir: dir });
  }
  const s = await sweep({ pipelineDir: dir });
  assert.equal(s.scanned, BATCH_CAP);
  const remaining = fs.readdirSync(path.join(dir, 'queue', 'side-findings-inbox')).length;
  assert.equal(remaining, 5, 'the items beyond the cap must be left for the next tick');
});
