'use strict';
// Tests for the JournalForge keep-and-resurface handoff. The fake receiver runs in a
// separate process because the handoff uses spawnSync, which blocks this process's event loop.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { handOffJournalEntry } = require('../src/journalforge-handoff.js');

const SENTINEL = 'SENTINEL-JF-TEXT-7f3a';
const ORIG_URL = process.env.JOURNALFORGE_URL;
const JOURNAL = { secondBrainPath: 'Journal/dates.md', actionable: false };

const SERVER_SRC = `
const http = require('http'); const fs = require('fs');
const mode = process.argv[2]; const logFile = process.argv[3];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    fs.appendFileSync(logFile, b + '\\n');
    if (mode === 'hang') return;
    res.writeHead(mode === '501' ? 501 : 200); res.end('{}');
  });
});
srv.listen(0, '127.0.0.1', () => { process.stdout.write(String(srv.address().port) + '\\n'); });
`;

function mkDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jf-handoff-')); }

function setUrl(v) {
  if (v === undefined) delete process.env.JOURNALFORGE_URL;
  else process.env.JOURNALFORGE_URL = v;
}

after(() => setUrl(ORIG_URL));

function startServer(mode) {
  const dir = mkDir();
  const script = path.join(dir, 'fake-server.js');
  const logFile = path.join(dir, 'received.log');
  fs.writeFileSync(script, SERVER_SRC);
  const proc = spawn(process.execPath, [script, mode, logFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    proc.on('error', reject);
    proc.stdout.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        resolve({ dir, url: `http://127.0.0.1:${Number(buf.slice(0, nl))}`, logFile, stop: () => proc.kill() });
      }
    });
  });
}

function received(logFile) {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
}

function entry(over = {}) {
  return { id: 'e1', serial: 1, rawText: `${SENTINEL} I want to go on a date`, capturedAt: '2026-10-22T10:00:00.000Z', ...over };
}

function handOff(e, result, dir) {
  return handOffJournalEntry({ entry: e, result, capturedAt: e.capturedAt, pipelineDir: dir });
}

test('journal + non-actionable entry is POSTed once and marked kept', async () => {
  const srv = await startServer('ok');
  try {
    setUrl(srv.url);
    const e = entry();
    const r = handOff(e, JOURNAL, srv.dir);
    assert.equal(r.handed, true);
    assert.equal(e.keptIn, 'journalforge');
    assert.ok(e.keptAt);
    const lines = received(srv.logFile);
    assert.equal(lines.length, 1);
    const body = JSON.parse(lines[0]);
    assert.equal(body.source, 'brain-dump:e1');
    assert.equal(body.path, 'Journal/dates.md');
    assert.equal(body.capturedAt, e.capturedAt);
  } finally { srv.stop(); }
});

test('refused / 501 / timeout are non-fatal and leave the entry unkept', async () => {
  const cases = [['refused', null], ['501', 'http-501'], ['hang', 'timeout']];
  for (const [mode, expected] of cases) {
    if (mode === 'refused') {
      setUrl('http://127.0.0.1:1');
      const e = entry();
      const r = handOff(e, JOURNAL, mkDir());
      assert.equal(r.handed, false);
      assert.equal(e.keptIn, undefined);
      assert.ok(['refused', 'error'].includes(r.reason));
      continue;
    }
    const srv = await startServer(mode);
    try {
      setUrl(srv.url);
      const e = entry();
      const r = handOff(e, JOURNAL, srv.dir);
      assert.equal(r.handed, false);
      assert.equal(r.reason, expected);
      assert.equal(e.keptIn, undefined);
    } finally { srv.stop(); }
  }
});

test('actionable not exactly false, non-journal, machine-raised, suppressed send nothing', async () => {
  const srv = await startServer('ok');
  try {
    setUrl(srv.url);
    const noActionable = { secondBrainPath: 'Journal/dates.md' };
    const cases = [
      [entry(), { ...JOURNAL, actionable: true }],
      [entry(), noActionable],
      [entry(), { ...JOURNAL, actionable: null }],
      [entry(), { secondBrainPath: 'Ideas/x.md', actionable: false }],
      [entry({ raisedBy: 'side-finding-sweep' }), JOURNAL],
      [entry({ suppressed: true }), JOURNAL],
    ];
    for (const [e, res] of cases) {
      const r = handOff(e, res, srv.dir);
      assert.equal(r.handed, false);
      assert.equal(e.keptIn, undefined);
    }
    assert.equal(received(srv.logFile).length, 0);
  } finally { srv.stop(); }
});

test('JOURNALFORGE_URL off or empty sends nothing', async () => {
  const srv = await startServer('ok');
  try {
    for (const v of ['off', '']) {
      setUrl(v);
      const e = entry();
      const r = handOff(e, JOURNAL, srv.dir);
      assert.equal(r.handed, false);
      assert.equal(r.reason, 'handoff-disabled');
    }
    assert.equal(received(srv.logFile).length, 0);
  } finally { srv.stop(); }
});

test('a kept entry is not handed over a second time', async () => {
  const srv = await startServer('ok');
  try {
    setUrl(srv.url);
    const e = entry();
    assert.equal(handOff(e, JOURNAL, srv.dir).handed, true);
    const second = handOff(e, JOURNAL, srv.dir);
    assert.equal(second.handed, false);
    assert.equal(second.reason, 'already-kept');
    assert.equal(received(srv.logFile).length, 1);
  } finally { srv.stop(); }
});

test('two distinct entries with identical text are both handed over', async () => {
  const srv = await startServer('ok');
  try {
    setUrl(srv.url);
    handOff(entry({ id: 'e1' }), JOURNAL, srv.dir);
    handOff(entry({ id: 'e2' }), JOURNAL, srv.dir);
    const sources = received(srv.logFile).map((l) => JSON.parse(l).source);
    assert.deepEqual(sources, ['brain-dump:e1', 'brain-dump:e2']);
  } finally { srv.stop(); }
});

function scanForText(dir, needle, skipName) {
  const hits = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { hits.push(...scanForText(full, needle, skipName)); continue; }
    if (name === skipName) continue;
    if (fs.readFileSync(full, 'utf8').includes(needle)) hits.push(full);
  }
  return hits;
}

test('log and pipeline files never contain the entry text', async () => {
  const srv = await startServer('501');
  try {
    setUrl(srv.url);
    handOff(entry({ id: 'e1' }), JOURNAL, srv.dir);
    setUrl('http://127.0.0.1:1');
    handOff(entry({ id: 'e2' }), JOURNAL, srv.dir);
    const hits = scanForText(srv.dir, SENTINEL, 'received.log');
    assert.deepEqual(hits, []);
  } finally { srv.stop(); }
});
