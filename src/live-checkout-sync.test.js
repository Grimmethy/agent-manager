'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { consume, reconcile, CONSUMER } = require('./live-checkout-sync.js');

const PIPE = '/pipeline';
const QE = path.join(PIPE, 'queue-events');
const JOURNAL = path.join(QE, 'journal.jsonl');
const RECONCILE = path.join(QE, 'reconcile.json');
const AUDIT = path.join(QE, 'live-checkout-sync.audit.jsonl');
const ALLOWED = new Set(['fetch', 'rev-parse', 'rev-list', 'symbolic-ref', 'status']);

// In-memory fs: every method queue-events and live-checkout-sync call. Nothing touches the real disk.
function makeFs() {
  const files = new Map();
  const inos = new Map();
  let nextIno = 100;
  const inoOf = (p) => {
    if (!inos.has(p)) inos.set(p, nextIno++);
    return inos.get(p);
  };
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const toBuf = (d) => (Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
  return {
    files,
    statSync(p) {
      if (!files.has(p)) throw enoent(p);
      return { ino: inoOf(p), size: files.get(p).length };
    },
    readFileSync(p, enc) {
      if (!files.has(p)) throw enoent(p);
      const b = files.get(p);
      return enc ? b.toString(enc) : Buffer.from(b);
    },
    writeFileSync(p, d) {
      files.set(p, toBuf(d));
    },
    appendFileSync(p, d) {
      files.set(p, Buffer.concat([files.get(p) || Buffer.alloc(0), toBuf(d)]));
    },
    renameSync(a, b) {
      if (!files.has(a)) throw enoent(a);
      const n = inoOf(a);
      files.set(b, files.get(a));
      files.delete(a);
      inos.delete(a);
      inos.set(b, n);
    },
    openSync(p) {
      if (!files.has(p)) throw enoent(p);
      return p;
    },
    readSync(fd, target, off, len, pos) {
      const src = files.get(fd);
      const n = Math.max(0, Math.min(len, src.length - pos));
      src.copy(target, off, pos, pos + n);
      return n;
    },
    closeSync() {},
    mkdirSync() {},
    realpathSync(p) {
      return p;
    },
  };
}

function journalLine(type) {
  const rec = { at: '2026-11-15T00:00:00.000Z', type, branch: 'b', taskId: null, sha: null, verdict: null, source: 'test', project: PIPE };
  return `${JSON.stringify(rec)}\n`;
}

// Scripted git: records every argv, answers by argv[0].
function makeGit({ fetchError = null, behind = 0, ahead = 0, branch = 'main' } = {}) {
  const calls = [];
  const execGit = (args) => {
    calls.push(args);
    switch (args[0]) {
      case 'fetch':
        if (fetchError) throw new Error(fetchError);
        return '';
      case 'symbolic-ref':
        return `${branch}\n`;
      case 'rev-list':
        return `${behind}\t${ahead}\n`;
      default:
        throw new Error(`unexpected git verb: ${args[0]}`);
    }
  };
  return { execGit, calls };
}

function makeDeps(fs, git, mode = 'dry-run') {
  return {
    fs,
    execGit: git.execGit,
    clock: () => Date.parse('2026-11-16T00:00:00.000Z'),
    env: { AGENT_MANAGER_REPO_ROOT: '/repo', AGENT_MANAGER_LIVE_CHECKOUT_SYNC: mode },
  };
}

function readAudit(fs) {
  const raw = fs.files.get(AUDIT);
  if (!raw) return [];
  return raw.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
}

// Silences the console.error that consume/reconcile emit on a fetch failure.
function quiet(fn) {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
}

test('zero events: consume makes no git call', () => {
  const fs = makeFs();
  fs.files.set(JOURNAL, Buffer.from(journalLine('verdict_recorded')));
  const git = makeGit();
  const rec = consume(PIPE, makeDeps(fs, git));
  assert.equal(rec.state, 'idle');
  assert.equal(git.calls.length, 0);
  assert.deepEqual(readAudit(fs), []);
});

test('three branch_merged events in one drain: exactly one fetch and one checkDrift', () => {
  const fs = makeFs();
  fs.files.set(JOURNAL, Buffer.from(journalLine('branch_merged').repeat(3)));
  const git = makeGit();
  const rec = consume(PIPE, makeDeps(fs, git));
  assert.equal(rec.events, 3);
  const verbs = git.calls.map((a) => a[0]);
  assert.equal(verbs.filter((v) => v === 'fetch').length, 1);
  // checkDrift issues exactly one symbolic-ref and one rev-list, so one call means one checkDrift.
  assert.equal(verbs.filter((v) => v === 'symbolic-ref').length, 1);
  assert.equal(verbs.filter((v) => v === 'rev-list').length, 1);
});

test('reconcile with drift and no events records exactly one correction', () => {
  const fs = makeFs();
  const rec = reconcile(PIPE, makeDeps(fs, makeGit({ behind: 2 })));
  assert.equal(rec.intended, 'sync');
  const corr = JSON.parse(fs.files.get(RECONCILE).toString('utf8'));
  assert.equal(corr.total, 1);
});

test('reconcile when current records no correction', () => {
  const fs = makeFs();
  const rec = reconcile(PIPE, makeDeps(fs, makeGit({ behind: 0 })));
  assert.equal(rec.intended, 'none');
  assert.equal(fs.files.has(RECONCILE), false);
});

test('fetch error produces an error audit line and does not throw', () => {
  const fs = makeFs();
  fs.files.set(JOURNAL, Buffer.from(journalLine('branch_merged')));
  const git = makeGit({ fetchError: 'network down' });
  const rec = quiet(() => consume(PIPE, makeDeps(fs, git)));
  assert.equal(rec.state, 'error');
  const audit = readAudit(fs);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].state, 'error');
  assert.equal(audit[0].consumer, CONSUMER);
  assert.match(audit[0].error, /network down/);
});

test('every recorded git call is a verb from the allowlist', () => {
  const fs = makeFs();
  fs.files.set(JOURNAL, Buffer.from(journalLine('branch_merged')));
  const git = makeGit({ behind: 1 });
  const deps = makeDeps(fs, git);
  consume(PIPE, deps);
  reconcile(PIPE, deps);
  assert.ok(git.calls.length > 0);
  for (const argv of git.calls) {
    assert.ok(ALLOWED.has(argv[0]), `disallowed git verb: ${argv[0]}`);
  }
});
