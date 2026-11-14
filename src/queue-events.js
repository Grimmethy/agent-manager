'use strict';

// queue-events.js -- the queue-events journal (ADR-0024 stage S1: the writer announces, consumers react; docs/adr/0024-triggers-not-polls.md).
//
// A durable, append-only file of past-tense events that sweeps read INSTEAD of re-scanning queue/done on a timer. Node built-ins only and nothing imported from
// agent-manager: the filesystem and the clock are arguments, so the module can move into Grimmethy/triggers unchanged.
//
//   <pipelineDir>/queue-events/journal.jsonl            one JSON object per line, newline-terminated, always under 3500 bytes (one O_APPEND write is atomic)
//   <pipelineDir>/queue-events/journal.1.jsonl          the previous journal, after a rotation (journal.jsonl passed 5 MB)
//   <pipelineDir>/queue-events/positions/<consumer>.json   { offset, ino, head }: where that consumer has read up to. `head` is a hash of the file's first line:
//                                                           an inode number alone cannot identify a file (a rotated-away journal's inode is REUSED by the next one), so a position only
//                                                           matches a file whose inode AND first line are the same
//   <pipelineDir>/queue-events/reconcile.json           { total, byConsumer, lastAt }: what the sweeps' slow safety-net passes found that no event announced
// The directory is OUTSIDE queue/ on purpose: appends there must not move queue directory mtimes (src/pool-projects.js and src/queue-cache.js read them).
//
//   append(pipelineDir, event, { fs, now, maxBytes })   -> the line written
//   drain(pipelineDir, consumer, { fs })                -> { events, commit() }   nothing is saved until commit(): a consumer that crashes re-reads
//   snapshot(pipelineDir, { fs })                       -> events of the current journal, oldest first (a late subscriber's catch-up)
//   recordCorrection(pipelineDir, consumer, n, { fs, now }) / readCorrections(pipelineDir, { fs })
//   CLI: node src/queue-events.js emit --dir <pipelineDir> --type <type> [--branch B] [--task-id I] [--sha S] [--verdict V] [--source S]
// A "correction" means a reconcile pass found work no event announced, i.e. a producer forgot to emit; the counter is the health metric of the whole design.

const realFs = require('fs');
const crypto = require('crypto');
const path = require('path');

const TYPES = ['verdict_recorded', 'branch_merged'];
const MAX_LINE_BYTES = 3500;
const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024;

const dirOf = (pipelineDir) => path.join(pipelineDir, 'queue-events');
const journalPath = (pipelineDir) => path.join(dirOf(pipelineDir), 'journal.jsonl');
const rotatedPath = (pipelineDir) => path.join(dirOf(pipelineDir), 'journal.1.jsonl');
const positionPath = (pipelineDir, consumer) => path.join(dirOf(pipelineDir), 'positions', `${consumer}.json`);
const reconcilePath = (pipelineDir) => path.join(dirOf(pipelineDir), 'reconcile.json');

function safeConsumer(consumer) {
  if (typeof consumer !== 'string' || !/^[A-Za-z0-9._-]+$/.test(consumer)) throw new TypeError(`bad consumer name: ${JSON.stringify(consumer)}`);
  return consumer;
}

function writeJsonAtomic(fs, file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readJson(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function append(pipelineDir, event, { fs = realFs, now = () => new Date(), maxBytes = DEFAULT_ROTATE_BYTES } = {}) {
  if (!event || !TYPES.includes(event.type)) throw new RangeError(`unknown event type: ${event && event.type}`);
  let project = path.resolve(pipelineDir);
  try { project = fs.realpathSync(pipelineDir); } catch { /* not on disk yet: the given path */ }
  const rec = {
    at: event.at || now().toISOString(),
    type: event.type,
    branch: event.branch || null,
    taskId: event.taskId || null,
    sha: event.sha || null,
    verdict: event.verdict || null,
    source: event.source || null,
    project,
  };
  const line = `${JSON.stringify(rec)}\n`;
  if (Buffer.byteLength(line) >= MAX_LINE_BYTES) throw new RangeError(`event line is ${Buffer.byteLength(line)} bytes; the limit is ${MAX_LINE_BYTES - 1}`);
  const dir = dirOf(pipelineDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = journalPath(pipelineDir);
  try {
    if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, rotatedPath(pipelineDir));   // replaces the old journal.1.jsonl
  } catch { /* no journal yet, or another writer rotated it first */ }
  fs.appendFileSync(file, line);                                                           // one write on an O_APPEND descriptor
  return line;
}

// Identity of a journal file independent of its inode number: a hash of its first line ('' while the first line is still being written or the file is empty).
function headOf(fs, file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(512);
      const n = fs.readSync(fd, b, 0, 512, 0);
      const nl = b.indexOf(0x0a);
      if (nl < 0 || nl >= n) return '';
      return crypto.createHash('sha1').update(b.slice(0, nl)).digest('hex').slice(0, 12);
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// Complete lines of `file` from `offset` to its end -> { events, consumed } (a half-written last line stays unread until its newline arrives).
function readFrom(fs, file, offset) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { events: [], consumed: 0, size: 0 }; }
  const start = Math.min(Math.max(offset || 0, 0), buf.length);
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < start) return { events: [], consumed: 0, size: buf.length };
  const text = buf.slice(start, lastNl + 1).toString('utf8');
  const events = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e && TYPES.includes(e.type)) events.push(e); } catch { /* a corrupt line is skipped, never fatal */ }
  }
  return { events, consumed: lastNl + 1 - start, size: buf.length };
}

function drain(pipelineDir, consumer, { fs = realFs } = {}) {
  safeConsumer(consumer);
  const pos = readJson(fs, positionPath(pipelineDir, consumer));
  const cur = journalPath(pipelineDir), old = rotatedPath(pipelineDir);
  let curIno = null, oldIno = null, curSize = 0;
  try { const st = fs.statSync(cur); curIno = st.ino; curSize = st.size; } catch { /* no journal yet */ }
  try { oldIno = fs.statSync(old).ino; } catch { /* never rotated */ }
  const events = [];
  let nextOffset = 0;
  if (curIno === null && oldIno === null) return { events, commit() {} };
  const curHead = curIno !== null ? headOf(fs, cur) : '';
  const oldHead = oldIno !== null ? headOf(fs, old) : '';
  // A saved position belongs to a file only if the inode AND the first line match (inode numbers are reused) and it does not point past the end.
  const onCur = !!pos && curIno !== null && pos.ino === curIno && pos.head === curHead && (pos.offset || 0) <= curSize;
  const onOld = !!pos && oldIno !== null && pos.ino === oldIno && pos.head === oldHead;
  if (onCur) {
    const r = readFrom(fs, cur, pos.offset);
    events.push(...r.events); nextOffset = (pos.offset || 0) + r.consumed;
  } else {
    if (onOld) events.push(...readFrom(fs, old, pos.offset).events);   // rotated since the last drain: the rest of the old file first
    if (curIno !== null) {
      const r = readFrom(fs, cur, 0);
      events.push(...r.events); nextOffset = r.consumed;
    }
  }
  return {
    events,
    commit() {
      if (curIno === null) return;
      writeJsonAtomic(fs, positionPath(pipelineDir, consumer), { offset: nextOffset, ino: curIno, head: curHead });
    },
  };
}

function snapshot(pipelineDir, { fs = realFs } = {}) {
  return readFrom(fs, journalPath(pipelineDir), 0).events;
}

function recordCorrection(pipelineDir, consumer, n = 1, { fs = realFs, now = () => new Date() } = {}) {
  safeConsumer(consumer);
  const cur = readJson(fs, reconcilePath(pipelineDir)) || {};
  const byConsumer = cur.byConsumer && typeof cur.byConsumer === 'object' ? cur.byConsumer : {};
  const add = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  byConsumer[consumer] = (byConsumer[consumer] || 0) + add;
  const out = { total: (Number(cur.total) || 0) + add, byConsumer, lastAt: add > 0 ? now().toISOString() : cur.lastAt || null };
  writeJsonAtomic(fs, reconcilePath(pipelineDir), out);
  return out;
}

function readCorrections(pipelineDir, { fs = realFs } = {}) {
  const cur = readJson(fs, reconcilePath(pipelineDir)) || {};
  return { total: Number(cur.total) || 0, byConsumer: cur.byConsumer && typeof cur.byConsumer === 'object' ? cur.byConsumer : {}, lastAt: cur.lastAt || null };
}

module.exports = { append, drain, snapshot, recordCorrection, readCorrections, TYPES, MAX_LINE_BYTES, DEFAULT_ROTATE_BYTES, journalPath, rotatedPath };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
  if (cmd !== 'emit' || !opt.dir || !opt.type) {
    console.error('usage: queue-events.js emit --dir <pipelineDir> --type <verdict_recorded|branch_merged> [--branch B] [--task-id I] [--sha S] [--verdict V] [--source S]');
    process.exit(2);
  }
  try {
    process.stdout.write(append(opt.dir, { type: opt.type, branch: opt.branch, taskId: opt['task-id'], sha: opt.sha, verdict: opt.verdict, source: opt.source }));
  } catch (e) { console.error(`queue-events: ${e.message}`); process.exit(1); }
}
