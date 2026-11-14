'use strict';

// src/queue-events.js: the queue-events journal (ADR-0024 S1). Real files in a temp directory; the clock is injected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const q = require('./queue-events.js');

const CLI = path.join(__dirname, 'queue-events.js');
const pipe = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qev-'));
const clock = (iso = '2026-11-03T10:00:00.000Z') => ({ now: () => new Date(iso) });
const ev = (n, type = 'verdict_recorded') => ({ type, branch: `agent/t${n}`, taskId: `t${n}`, sha: `s${n}`, verdict: 'needs-work', source: 'chat' });

test('append then drain returns the event; a second drain returns nothing after commit', () => {
  const p = pipe();
  const line = q.append(p, ev(1), clock());
  assert.ok(line.endsWith('\n'));
  const d = q.drain(p, 'defect-readmit');
  assert.equal(d.events.length, 1);
  assert.equal(d.events[0].branch, 'agent/t1');
  assert.equal(d.events[0].at, '2026-11-03T10:00:00.000Z');
  assert.equal(d.events[0].project, fs.realpathSync(p));
  d.commit();
  assert.deepEqual(q.drain(p, 'defect-readmit').events, []);
  q.append(p, ev(2), clock());
  assert.deepEqual(q.drain(p, 'defect-readmit').events.map((e) => e.taskId), ['t2']);
});

test('drain WITHOUT commit returns the same events again (a crashed consumer re-reads)', () => {
  const p = pipe();
  q.append(p, ev(1), clock()); q.append(p, ev(2), clock());
  assert.equal(q.drain(p, 'c').events.length, 2);
  assert.equal(q.drain(p, 'c').events.length, 2);
});

test('two consumers keep independent positions', () => {
  const p = pipe();
  q.append(p, ev(1), clock());
  const a = q.drain(p, 'a'); a.commit();
  q.append(p, ev(2), clock());
  assert.deepEqual(q.drain(p, 'a').events.map((e) => e.taskId), ['t2']);
  assert.deepEqual(q.drain(p, 'b').events.map((e) => e.taskId), ['t1', 't2']);
});

test('a half-written last line is not returned until its newline arrives', () => {
  const p = pipe();
  q.append(p, ev(1), clock());
  const file = q.journalPath(p);
  fs.appendFileSync(file, '{"at":"2026-11-03T10:00:00.000Z","type":"branch_merged","branch":"agent/part');
  const first = q.drain(p, 'c');
  assert.deepEqual(first.events.map((e) => e.taskId), ['t1']);
  first.commit();
  fs.appendFileSync(file, 'ial","taskId":"tp","sha":null,"verdict":null,"source":null,"project":"x"}\n');
  assert.deepEqual(q.drain(p, 'c').events.map((e) => e.taskId), ['tp']);
});

test('rotation: a consumer that is at most one rotation behind loses nothing and reads nothing twice', () => {
  const p = pipe();
  const small = { ...clock(), maxBytes: 600 };
  for (let i = 1; i <= 3; i++) q.append(p, ev(i), small);
  const d1 = q.drain(p, 'c');
  assert.deepEqual(d1.events.map((e) => e.taskId), ['t1', 't2', 't3']);
  d1.commit();
  const after = [];
  for (let i = 4; !fs.existsSync(q.rotatedPath(p)); i++) { q.append(p, ev(i), small); after.push(`t${i}`); }    // append until the journal has rotated exactly once
  const n = after.length + 1;
  q.append(p, ev(n), small); after.push(`t${n}`);                                                        // and one more into the new journal
  assert.ok(after.length >= 2, 'events on both sides of the rotation');
  const d2 = q.drain(p, 'c');
  assert.deepEqual(d2.events.map((e) => e.taskId), after, 'the rest of the old journal, then the new one, in order, nothing repeated');
  d2.commit();
  assert.deepEqual(q.drain(p, 'c').events, []);
});

test('rotation: a consumer behind by several rotations reads the whole current journal, even when the filesystem reuses an inode number', () => {
  // Found with a real fixture: after several rotations the new journal got the SAME inode as the consumer's saved position, the old code believed it was
  // still in the same file and skipped events. The saved position now also carries the first line's hash.
  const p = pipe();
  const small = { ...clock(), maxBytes: 600 };
  for (let i = 1; i <= 3; i++) q.append(p, ev(i), small);
  const d1 = q.drain(p, 'c'); d1.commit();
  const savedIno = JSON.parse(fs.readFileSync(path.join(p, 'queue-events', 'positions', 'c.json'), 'utf8')).ino;
  let reused = false;
  for (let i = 4; i <= 40 && !reused; i++) { q.append(p, ev(i), small); reused = fs.statSync(q.journalPath(p)).ino === savedIno && i > 8; }
  const onDisk = q.snapshot(p).map((e) => e.taskId);
  const got = q.drain(p, 'c').events.map((e) => e.taskId);
  assert.deepEqual(got, onDisk, 'every event still in the current journal is delivered exactly once, in order');
  if (!reused) console.log('note: this filesystem did not reuse the inode in this run; the head-hash path is covered by the next test');
});

test('a saved position whose inode matches but whose first line differs (a different file) restarts at the beginning', () => {
  const p = pipe();
  q.append(p, ev(1), clock()); q.append(p, ev(2), clock());
  const d = q.drain(p, 'c'); d.commit();
  const posFile = path.join(p, 'queue-events', 'positions', 'c.json');
  const pos = JSON.parse(fs.readFileSync(posFile, 'utf8'));
  fs.writeFileSync(posFile, JSON.stringify({ ...pos, head: 'deadbeef0000' }));        // same inode, but not the file it was saved for
  assert.deepEqual(q.drain(p, 'c').events.map((e) => e.taskId), ['t1', 't2']);
  fs.writeFileSync(posFile, JSON.stringify({ ...pos, offset: pos.offset + 9999 }));  // an offset past the end is a reset too
  assert.deepEqual(q.drain(p, 'c').events.map((e) => e.taskId), ['t1', 't2']);
});

test('snapshot returns the current journal oldest first', () => {
  const p = pipe();
  for (let i = 1; i <= 3; i++) q.append(p, ev(i), clock());
  assert.deepEqual(q.snapshot(p).map((e) => e.taskId), ['t1', 't2', 't3']);
  assert.deepEqual(q.snapshot(pipe()), []);
});

test('recordCorrection and readCorrections accumulate per consumer', () => {
  const p = pipe();
  assert.deepEqual(q.readCorrections(p), { total: 0, byConsumer: {}, lastAt: null });
  q.recordCorrection(p, 'redo-supersede', 1, clock());
  q.recordCorrection(p, 'defect-readmit', 2, clock('2026-11-03T11:00:00.000Z'));
  q.recordCorrection(p, 'redo-supersede', 1, clock('2026-11-03T12:00:00.000Z'));
  const r = q.readCorrections(p);
  assert.equal(r.total, 4);
  assert.deepEqual(r.byConsumer, { 'redo-supersede': 2, 'defect-readmit': 2 });
  assert.equal(r.lastAt, '2026-11-03T12:00:00.000Z');
});

test('an event over 3500 bytes, an unknown type and a bad consumer name are rejected', () => {
  const p = pipe();
  assert.throws(() => q.append(p, { ...ev(1), branch: 'x'.repeat(4000) }, clock()), /limit is 3499/);
  assert.throws(() => q.append(p, { type: 'something_else' }, clock()), /unknown event type/);
  assert.throws(() => q.drain(p, '../escape'), /bad consumer name/);
  assert.equal(fs.existsSync(q.journalPath(p)), false, 'nothing was written by the rejected appends');
});

test('a corrupt line is skipped, not fatal', () => {
  const p = pipe();
  q.append(p, ev(1), clock());
  fs.appendFileSync(q.journalPath(p), 'this is not json\n');
  q.append(p, ev(2), clock());
  assert.deepEqual(q.drain(p, 'c').events.map((e) => e.taskId), ['t1', 't2']);
});

test('the journal lives outside queue/ so appends never move a queue directory mtime', () => {
  const p = pipe();
  fs.mkdirSync(path.join(p, 'queue', 'done'), { recursive: true });
  const before = fs.statSync(path.join(p, 'queue')).mtimeMs;
  q.append(p, ev(1), clock());
  assert.equal(fs.statSync(path.join(p, 'queue')).mtimeMs, before);
  assert.ok(q.journalPath(p).startsWith(path.join(p, 'queue-events')));
});

test('CLI emit prints the written line, and fails with usage on bad input', () => {
  const p = pipe();
  const r = spawnSync('node', [CLI, 'emit', '--dir', p, '--type', 'branch_merged', '--branch', 'agent/x', '--task-id', 'x'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const printed = JSON.parse(r.stdout);
  assert.equal(printed.type, 'branch_merged');
  assert.equal(printed.taskId, 'x');
  assert.equal(q.snapshot(p).length, 1);
  assert.equal(spawnSync('node', [CLI, 'emit', '--dir', p], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [CLI, 'emit', '--dir', p, '--type', 'nope'], { encoding: 'utf8' }).status, 1);
});
