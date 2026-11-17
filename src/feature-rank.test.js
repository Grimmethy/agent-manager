'use strict';

// Tests for src/feature-rank.js -- the shared rank map helper.
//
// Coverage:
//   - valid write then read
//   - replace semantics (slug dropped by later push becomes unranked)
//   - invalid payload rejected and old file intact
//   - missing file, corrupt JSON, empty map all return ok:false with the right reason
//   - mtime cache re-reads after a rewrite
//   - audit line written once per state change only
//   - rankForSlug returns null for absent/falsy slug
//   - syncStatus returns correct structure

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const featureRank = require('./feature-rank.js');

// --- Helpers ------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feature-rank-test-'));
}

// Override AGENT_MANAGER_INSTANCES_DIR so tests never touch the real instances dir.
function withInstancesDir(dir, fn) {
  const prev = process.env.AGENT_MANAGER_INSTANCES_DIR;
  process.env.AGENT_MANAGER_INSTANCES_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_INSTANCES_DIR;
    else process.env.AGENT_MANAGER_INSTANCES_DIR = prev;
  }
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function readAuditLines(dir) {
  const file = path.join(dir, 'feature-rank-audit.log');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// --- Tests --------------------------------------------------------------------

test('writeRankMap then readRankMap: round-trip preserves ranks', () => {
  const dir = makeTmpDir();
  try {
    withInstancesDir(dir, () => {
      const now = new Date('2026-01-15T10:00:00.000Z');
      const map = { 'auth': 1, 'billing': 2, 'search': 3 };
      const result = featureRank.writeRankMap(map, now);
      assert.equal(result.ok, true);
      assert.equal(result.count, 3);

      const state = featureRank.readRankMap();
      assert.equal(state.ok, true);
      assert.deepEqual(state.ranks, map);
      assert.equal(state.receivedAt, '2026-01-15T10:00:00.000Z');
      assert.equal(state.count, 3);
      assert.equal(state.reason, 'read');

      // File exists on disk
      const rankMapPath = featureRank._getRankMapPath(null);
      assert.ok(fs.existsSync(rankMapPath));
    });
  } finally {
    cleanupDir(dir);
  }
});

test('replace semantics: slug dropped by a later push becomes unranked', () => {
  const dir = makeTmpDir();
  try {
    withInstancesDir(dir, () => {
      featureRank.writeRankMap({ a: 1, b: 2, c: 3 }, new Date());
      let state = featureRank.readRankMap();
      assert.equal(state.ok, true);
      assert.deepEqual(state.ranks, { a: 1, b: 2, c: 3 });

      // Push a smaller map -- 'c' is dropped
      featureRank.writeRankMap({ a: 1, b: 2 }, new Date());
      state = featureRank.readRankMap();
      assert.equal(state.ok, true);
      assert.deepEqual(state.ranks, { a: 1, b: 2 });
      assert.equal(state.count, 2);

      // 'c' is now unranked
      assert.equal(featureRank.rankForSlug('c'), null);
      assert.equal(featureRank.rankForSlug('a'), 1);
      assert.equal(featureRank.rankForSlug('b'), 2);
    });
  } finally {
    cleanupDir(dir);
  }
});

test('invalid payload rejected: old file remains intact', () => {
  const dir = makeTmpDir();
  try {
    withInstancesDir(dir, () => {
      // Write a valid map first
      featureRank.writeRankMap({ x: 10 }, new Date('2026-01-01T00:00:00.000Z'));
      let state = featureRank.readRankMap();
      assert.equal(state.ok, true);
      assert.equal(state.ranks.x, 10);

      // Try invalid: not an object
      assert.throws(() => featureRank.writeRankMap('string', new Date()), /map must be a plain object/);
      state = featureRank.readRankMap();
      assert.equal(state.ok, true);
      assert.equal(state.ranks.x, 10); // unchanged

      // Try invalid: integer value
      assert.throws(() => featureRank.writeRankMap({ a: 'not-int' }, new Date()), /must be an integer/);
      state = featureRank.readRankMap();
      assert.equal(state.ok, true);
      assert.equal(state.ranks.x, 10); // unchanged

      // Try invalid: too many entries
      const bigMap = {};
      for (let i = 0; i < 5001; i++) bigMap[`s${i}`] = i;
      assert.throws(() => featureRank.writeRankMap(bigMap, new Date()), /exceeds 5000/);
      state = featureRank.readRankMap();
      assert.equal(state.ok, true);
      assert.equal(state.ranks.x, 10); // unchanged

      // Try invalid: non-Date now
      assert.throws(() => featureRank.writeRankMap({ a: 1 }, 'not-a-date'), /not a valid date/);
      state = featureRank.readRankMap();
      assert.equal(state.ok, true);
      assert.equal(state.ranks.x, 10); // unchanged
    });
  } finally {
    cleanupDir(dir);
  }
});

test('missing file returns ok:false with reason "missing"', () => {
  const dir = makeTmpDir();
  try {
    withInstancesDir(dir, () => {
      // No write -- file does not exist
      const state = featureRank.readRankMap();
      assert.equal(state.ok, false);
      assert.equal(state.reason, 'missing');

      // rankForSlug on missing file returns null
      assert.equal(featureRank.rankForSlug('anything'), null);

      // syncStatus reports not synced
      const s = featureRank.syncStatus();
      assert.equal(s.synced, false);
    });
  } finally {
    cleanupDir(dir);
  }
});

test('corrupt JSON returns ok:false with reason "unreadable"', () => {
  const dir = makeTmpDir();
  try {
    withInstancesDir(dir, () => {
      // Write a valid file first
      featureRank.writeRankMap({ a: 1 }, new Date());
      let state = featureRank.readRankMap();
      assert.equal(state.ok, true);

      // Corrupt the file
      const rankMapPath = featureRank._getRankMapPath(null);
      fs.writeFileSync(rankMapPath, '{invalid json{{{');

      // Force cache invalidation so we re-read
      featureRank._resetCache();
      state = featureRank.readRankMap();
      assert.equal(state.ok, false);
      assert.equal(state.reason, 'unreadable');

      // rankForSlug returns null
      assert.equal(featureRank.rankForSlug('a'), null);
    });
  } finally {
    cleanupDir(dir);
  }
});

test('empty map (no ranks key) returns ok:false with reason "empty"', () => {
  const dir = makeTmpDir();
  try {
    withInstancesDir(dir, () => {
      // Write a valid file first
      featureRank.writeRankMap({ a: 1 }, new Date());
      let state = featureRank.readRankMap();
      assert.equal(state.ok, true);

      // Overwrite with empty object
      const rankMapPath = featureRank._getRankMapPath(null);
      fs.writeFileSync(rankMapPath, JSON.stringify({}));
      featureRank._resetCache();
      state = featureRank.readRankMap();
      assert.equal(state.ok, false);
      assert.equal(state.reason, 'empty');

      // Overwrite with ranks: null
      fs.writeFileSync(rankMapPath, JSON.stringify({ ranks: null, receivedAt: 'x', count: 0 }));
      featureRank._resetCache();
      state = featureRank.readRankMap();
      assert.equal(state.ok, false);
      assert.equal(state.reason, 'empty');

      assert.equal(featureRank.rankForSlug('anything'), null);
    });
  } finally {
    cleanupDir(dir);
  }
});

test('mtime cache: re-reads after a rewrite changes mtime', () => {
  const dir = makeTmpDir();
  try {
    withInstancesDir(dir, () => {
      const now1 = new Date('2026-06-01T12:00:00.000Z');
      featureRank.writeRankMap({ a: 1 }, now1);
      let state = featureRank.readRankMap();
      assert.equal(state.ok, true);
      assert.equal(state.reason, 'read');
      assert.equal(state.receivedAt, '2026-06-01T12:00:00.000Z');

      // Second read should be cached
      featureRank._resetCache(); // reset cache but file mtime is same
      // Actually, we need to test that when mtime is unchanged we get cached result
      // But we just reset the cache, so it will re-read. Let's test the cache properly:
      state = featureRank.readRankMap(); // this reads and caches
      assert.equal(state.reason, 'read');

      // Now read again -- should be cached (same mtime)
      state = featureRank.readRankMap();
      assert.equal(state.ok, true);
      assert.equal(state.reason, 'cached');

      // Now rewrite the file (changes mtime)
      const now2 = new Date('2026-06-01T12:00:01.000Z');
      featureRank.writeRankMap({ a: 2 }, now2);
      state = featureRank.readRankMap();
      assert.equal(state.ok, true);
      assert.notEqual(state.reason, 'cached'); // should re-read due to mtime change
      assert.equal(state.receivedAt, '2026-06-01T12:00:01.000Z');
      assert.equal(state.ranks.a, 2);
    });
  } finally {
    cleanupDir(dir);
  }
});

test('audit: one line per state change, no duplicates for identical consecutive states', () => {
  const dir = makeTmpDir();
  try {
    withInstancesDir(dir, () => {
      featureRank._resetAudit();

      // Initial read of missing file -> audit line: {state: 'missing'}
      featureRank.readRankMap();
      let lines = readAuditLines(dir);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].state, 'missing');

      // Second read of missing file -> no new line (dedup)
      featureRank.readRankMap();
      lines = readAuditLines(dir);
      assert.equal(lines.length, 1); // still one

      // Write a valid file -> audit line: {state: 'ok'}
      featureRank.writeRankMap({ a: 1 }, new Date());
      lines = readAuditLines(dir);
      assert.equal(lines.length, 2);
      assert.equal(lines[1].state, 'ok');

      // Read ok file -> no new line (ok -> ok is no change)
      featureRank.readRankMap();
      lines = readAuditLines(dir);
      assert.equal(lines.length, 2); // still two

      // Corrupt file -> audit line: {state: 'unreadable'}
      const rankMapPath = featureRank._getRankMapPath(null);
      fs.writeFileSync(rankMapPath, '{bad');
      featureRank._resetCache();
      featureRank.readRankMap();
      lines = readAuditLines(dir);
      assert.equal(lines.length, 3);
      assert.equal(lines[2].state, 'unreadable');

      // Read corrupt file again -> no new line (dedup)
      featureRank.readRankMap();
      lines = readAuditLines(dir);
      assert.equal(lines.length, 3); // still three

      // Write valid again -> audit line: {state: 'ok'}
      featureRank.writeRankMap({ b: 2 }, new Date());
      lines = readAuditLines(dir);
      assert.equal(lines.length, 4);
      assert.equal(lines[3].state, 'ok');

      // Verify each line has ts and state fields
      for (const line of lines) {
        assert.ok(line.ts, 'each line has ts');
        assert.ok(line.state, 'each line has state');
      }
    });
  } finally {
    cleanupDir(dir);
  }
});

test('rankForSlug: returns null for absent slug, falsy slug, and non-string slug', () => {
  const dir = makeTmpDir();
  try {
    withInstancesDir(dir, () => {
      featureRank.writeRankMap({ auth: 1, billing: 2 }, new Date());
      assert.equal(featureRank.rankForSlug('auth'), 1);
      assert.equal(featureRank.rankForSlug('billing'), 2);
      assert.equal(featureRank.rankForSlug('nonexistent'), null);
      assert.equal(featureRank.rankForSlug(null), null);
      assert.equal(featureRank.rankForSlug(''), null);
      assert.equal(featureRank.rankForSlug(123), null); // non-string
    });
  } finally {
    cleanupDir(dir);
  }
});

test('syncStatus: correct structure for synced and unsynced states', () => {
  const dir = makeTmpDir();
  try {
    withInstancesDir(dir, () => {
      // Missing file
      let s = featureRank.syncStatus();
      assert.equal(s.synced, false);
      assert.equal(s.reason, 'missing');
      assert.equal(s.receivedAt, undefined);
      assert.equal(s.count, undefined);

      // After write
      featureRank.writeRankMap({ a: 1 }, new Date('2026-01-01T00:00:00.000Z'));
      s = featureRank.syncStatus();
      assert.equal(s.synced, true);
      assert.equal(s.reason, 'read');
      assert.equal(s.receivedAt, '2026-01-01T00:00:00.000Z');
      assert.equal(s.count, 1);

      // After corrupt
      const rankMapPath = featureRank._getRankMapPath(null);
      fs.writeFileSync(rankMapPath, '{bad');
      featureRank._resetCache();
      s = featureRank.syncStatus();
      assert.equal(s.synced, false);
      assert.equal(s.reason, 'unreadable');
    });
  } finally {
    cleanupDir(dir);
  }
});

test('atomic write: no partial file on crash-like conditions (temp file cleanup)', () => {
  const dir = makeTmpDir();
  try {
    withInstancesDir(dir, () => {
      featureRank.writeRankMap({ a: 1 }, new Date());
      const rankMapPath = featureRank._getRankMapPath(null);
      assert.ok(fs.existsSync(rankMapPath));

      // No leftover temp files in the instances dir
      const files = fs.readdirSync(dir);
      const tmpFiles = files.filter((f) => f.includes('.tmp'));
      assert.equal(tmpFiles.length, 0, `no temp files left, found: ${tmpFiles.join(', ')}`);
    });
  } finally {
    cleanupDir(dir);
  }
});
