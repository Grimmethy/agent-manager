'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  sweep, isDue, markChecked,
} = require('./proactive-file-decompose-sweep.js');

function tmpPipeline(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-decompose-'));
  for (const s of ['file-decompose-requests', 'coordinating', 'adhoc', 'instances']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'queue', 'file-length-flags.json'), JSON.stringify({
    findings: files.map((f) => ({ file: f, lines: 6000 })),
  }));
  return dir;
}

function writeFixtureSource(dir, relPath, symbolNames) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, symbolNames.map((n) => `function ${n}() {}`).join('\n') + '\n');
}

function fakeCall(moves) {
  return async () => ({ response: JSON.stringify(moves) });
}

const SYMS = ['renderA', 'renderB', 'renderC', 'renderD', 'extra1', 'extra2'];
const MOVES = [
  { newFile: 'src/lib/a.js', kind: 'script-extract', symbols: ['renderA', 'renderB'] },
  { newFile: 'src/lib/b.js', kind: 'script-extract', symbols: ['renderC', 'renderD'] },
];

test('isDue: true on a fresh instancesDir (never checked), false right after markChecked, true again after CHECK_INTERVAL_MS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-instances-'));
  assert.equal(isDue(dir), true);
  const now = new Date('2026-01-01T00:00:00Z');
  markChecked(dir, now);
  assert.equal(isDue(dir, now), false);
  assert.equal(isDue(dir, new Date(now.getTime() + 23 * 60 * 60 * 1000)), false);
  assert.equal(isDue(dir, new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1)), true);
});

test('sweep: not due and not forced -> no-op, nothing filed', async () => {
  const dir = tmpPipeline(['src/big.js']);
  markChecked(path.join(dir, 'instances'));
  writeFixtureSource(dir, 'src/big.js', SYMS);
  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES) });
  assert.equal(summary.due, false);
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests')).length, 0);
});

test('sweep: force=true runs even when not due, and files a request for a genuinely oversized file', async () => {
  const dir = tmpPipeline(['src/big.js']);
  markChecked(path.join(dir, 'instances'));
  writeFixtureSource(dir, 'src/big.js', SYMS);

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
  assert.equal(summary.filed, 1);

  const reqs = fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests'));
  assert.equal(reqs.length, 1);
  const req = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'file-decompose-requests', reqs[0]), 'utf8'));
  assert.equal(req.sourceFile, 'src/big.js');
  assert.match(req.note, /no waiting task/);

  // Hub/one-pass materialised in the same run -- not left as a dangling request.
  assert.ok(req.hubId || req.onePassTaskId, 'request was processed into a real hub or one-pass task this same run');
});

test('sweep: due (no force needed) also files, and marks the schedule so the next call is not due', async () => {
  const dir = tmpPipeline(['src/big.js']);
  writeFixtureSource(dir, 'src/big.js', SYMS);

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES) });
  assert.equal(summary.due, true);
  assert.equal(summary.filed, 1);
  assert.equal(isDue(path.join(dir, 'instances')), false, 'schedule stamped after a real run');
});

test('sweep: a file that already has ANY existing file-decompose-request is skipped, not re-filed', async () => {
  const dir = tmpPipeline(['src/big.js']);
  writeFixtureSource(dir, 'src/big.js', SYMS);
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'hand-authored.json'),
    JSON.stringify({ id: 'hand-authored', sourceFile: 'src/big.js', moves: [] }));

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
  assert.equal(summary.filed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests')).length, 1, 'still just the one pre-existing request');
});

test('sweep: a file with a recent commit (hot file) is skipped', async () => {
  const dir = tmpPipeline(['src/big.js']);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'x'], { cwd: dir });
  writeFixtureSource(dir, 'src/big.js', SYMS);
  execFileSync('git', ['add', 'src/big.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'recent'], { cwd: dir });

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
  assert.equal(summary.filed, 0);
  assert.equal(summary.skipped, 1);
});

test('sweep: bounded to MAX_FILES_PER_RUN (1) even with 2 eligible oversized files', async () => {
  const dir = tmpPipeline(['src/big1.js', 'src/big2.js']);
  writeFixtureSource(dir, 'src/big1.js', SYMS);
  writeFixtureSource(dir, 'src/big2.js', SYMS);

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
  assert.equal(summary.filed, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests')).length, 1);
});

test('sweep: AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE=false is a total no-op, even with force', async () => {
  const dir = tmpPipeline(['src/big.js']);
  writeFixtureSource(dir, 'src/big.js', SYMS);
  const prev = process.env.AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE;
  process.env.AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE = 'false';
  try {
    const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
    assert.equal(summary.filed, 0);
    assert.equal(fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests')).length, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE; else process.env.AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE = prev;
  }
});

test('sweep: no oversized files at all -> due but nothing to do, still marks checked', async () => {
  const dir = tmpPipeline([]);
  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES) });
  assert.equal(summary.due, true);
  assert.equal(summary.filed, 0);
  assert.equal(isDue(path.join(dir, 'instances')), false, 'still marks checked on a clean run');
});
