'use strict';

// Tests for queue-cache.js: the RAM-only cache of parsed queue task files.
// Every test points the cache root at its own temp directory (AGENT_MANAGER_QUEUE_CACHE_DIR) and moves the clock itself through opts.now, so nothing
// depends on the real tick size of file timestamps. Run: node --test src/queue-cache.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openQueueCache, readTaskCached, cacheFileFor, REVALIDATE_MS, RACY_MS } = require('./queue-cache.js');

// Far enough after any real mtime that the racy-timestamp guard never applies unless a test wants it to.
const BASE = Date.now() + 10 * 24 * 3600 * 1000;

function setup(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-cache-test-'));
  const dir = path.join(root, 'pending');
  const cacheRootDir = path.join(root, 'cache');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  const saved = { dir: process.env.AGENT_MANAGER_QUEUE_CACHE_DIR, off: process.env.AGENT_MANAGER_QUEUE_CACHE };
  process.env.AGENT_MANAGER_QUEUE_CACHE_DIR = cacheRootDir;
  delete process.env.AGENT_MANAGER_QUEUE_CACHE;
  t.after(() => {
    if (saved.dir === undefined) delete process.env.AGENT_MANAGER_QUEUE_CACHE_DIR; else process.env.AGENT_MANAGER_QUEUE_CACHE_DIR = saved.dir;
    if (saved.off === undefined) delete process.env.AGENT_MANAGER_QUEUE_CACHE; else process.env.AGENT_MANAGER_QUEUE_CACHE = saved.off;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dir, cacheRootDir };
}

let bump = 0;
// A directory change the next scan can tell apart from the last one, whatever the filesystem's timestamp tick.
function touchDir(dir) {
  bump += 10000;
  const when = new Date(Date.now() + bump);
  fs.utimesSync(dir, when, when);
}

function scan(dir, now) {
  const cache = openQueueCache(dir, { now });
  const names = cache.names();
  const tasks = Object.fromEntries(names.map((n) => [n, readTaskCached(cache, path.join(dir, n)).task]));
  cache.save();
  return { cache, names, tasks };
}

test('an unchanged directory is served from the cache: same names, same tasks, no task file read', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a', n: 1 }, 'b.json': { id: 'b', n: 2 } });
  const first = scan(dir, BASE);
  assert.equal(first.cache.stats.reads, 2);
  assert.equal(first.cache.stats.statPasses, 1);
  const second = scan(dir, BASE + 1000);
  assert.equal(second.cache.stats.reads, 0);
  assert.equal(second.cache.stats.statPasses, 0);
  assert.equal(second.cache.stats.hits, 2);
  assert.deepEqual(second.names, first.names);
  assert.deepEqual(second.tasks, first.tasks);
  assert.deepEqual(second.names.slice().sort(), fs.readdirSync(dir).sort());
});

test('names come back in the same order readdir gives them', (t) => {
  const files = {};
  for (let i = 0; i < 25; i++) files[`t${i}.json`] = { id: i };
  const { dir } = setup(t, files);
  const order = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.deepEqual(scan(dir, BASE).names, order);
  assert.deepEqual(scan(dir, BASE + 1).names, order);
});

test('a file added to the directory is seen on the very next call', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a' } });
  scan(dir, BASE);
  fs.writeFileSync(path.join(dir, 'new.json'), JSON.stringify({ id: 'new' }));
  touchDir(dir);
  const next = scan(dir, BASE + 1000);
  assert.ok(next.names.includes('new.json'));
  assert.deepEqual(next.tasks['new.json'], { id: 'new' });
  assert.equal(next.cache.stats.reads, 1);
});

test('a file removed from the directory is dropped on the next call', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a' }, 'b.json': { id: 'b' } });
  scan(dir, BASE);
  fs.unlinkSync(path.join(dir, 'a.json'));
  touchDir(dir);
  const next = scan(dir, BASE + 1000);
  assert.deepEqual(next.names, ['b.json']);
  assert.ok(!('a.json' in next.tasks));
  // and the removed file's entry is gone from what was persisted, not just from the returned list
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFileFor(dir), 'utf8')).files), ['b.json']);
});

test('an in-place edit is not seen before REVALIDATE_MS and is re-read once it has passed', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a', v: 1 } });
  scan(dir, BASE);
  const full = path.join(dir, 'a.json');
  fs.writeFileSync(full, JSON.stringify({ id: 'a', v: 2, longer: 'content' }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(full, later, later);
  // the directory itself did not change (an in-place write): its mtime is what the cache holds
  const before = scan(dir, BASE + REVALIDATE_MS - 1);
  assert.deepEqual(before.tasks['a.json'], { id: 'a', v: 1 });
  assert.equal(before.cache.stats.reads, 0);
  const after = scan(dir, BASE + REVALIDATE_MS);
  assert.deepEqual(after.tasks['a.json'], { id: 'a', v: 2, longer: 'content' });
  assert.equal(after.cache.stats.reads, 1);
  assert.equal(after.cache.stats.statPasses, 1);
});

test('a full pass re-reads only the files whose mtime or size changed', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a' }, 'b.json': { id: 'b' }, 'c.json': { id: 'c' } });
  scan(dir, BASE);
  const b = path.join(dir, 'b.json');
  fs.writeFileSync(b, JSON.stringify({ id: 'b', more: true }));
  // same size, only the mtime moves
  const c = path.join(dir, 'c.json');
  const later = new Date(Date.now() + 7000);
  fs.utimesSync(c, later, later);
  const pass = scan(dir, BASE + REVALIDATE_MS);
  assert.equal(pass.cache.stats.statPasses, 1);
  assert.equal(pass.cache.stats.reads, 2);
  assert.equal(pass.cache.stats.hits, 1);
  assert.deepEqual(pass.tasks['b.json'], { id: 'b', more: true });
});

test('a file whose size changes but whose mtime is identical is still re-read', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a', v: 1 } });
  const full = path.join(dir, 'a.json');
  // an mtime in whole seconds, so putting it back after the rewrite gives exactly the same mtimeMs and only the size can tell the two apart
  const PINNED_SECONDS = 1700000000;
  fs.utimesSync(full, PINNED_SECONDS, PINNED_SECONDS);
  scan(dir, BASE);
  fs.writeFileSync(full, JSON.stringify({ id: 'a', v: 22222 }));
  fs.utimesSync(full, PINNED_SECONDS, PINNED_SECONDS);
  assert.equal(fs.statSync(full).mtimeMs, PINNED_SECONDS * 1000);
  const pass = scan(dir, BASE + REVALIDATE_MS);
  assert.equal(pass.cache.stats.reads, 1);
  assert.deepEqual(pass.tasks['a.json'], { id: 'a', v: 22222 });
});

test('a corrupt JSON file gives a null task without throwing and is not re-parsed while unchanged', (t) => {
  const { dir } = setup(t, { 'ok.json': { id: 'ok' }, 'bad.json': '{ not json' });
  const first = scan(dir, BASE);
  assert.equal(first.tasks['bad.json'], null);
  assert.deepEqual(first.tasks['ok.json'], { id: 'ok' });
  const full = scan(dir, BASE + REVALIDATE_MS);
  assert.equal(full.cache.stats.reads, 0);
  assert.equal(full.tasks['bad.json'], null);
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ id: 'fixed', pad: 'x' }));
  const fixed = scan(dir, BASE + 2 * REVALIDATE_MS);
  assert.deepEqual(fixed.tasks['bad.json'], { id: 'fixed', pad: 'x' });
});

test('non-json files are not listed', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a' }, 'notes.txt': 'hello', 'tmp.json.part': '{}' });
  assert.deepEqual(scan(dir, BASE).names, ['a.json']);
});

test('the kill switch reads every time and writes no cache file', (t) => {
  const { dir, cacheRootDir } = setup(t, { 'a.json': { id: 'a' }, 'b.json': { id: 'b' } });
  process.env.AGENT_MANAGER_QUEUE_CACHE = 'FALSE';
  const first = scan(dir, BASE);
  const second = scan(dir, BASE + 1000);
  assert.equal(first.cache.stats.reads, 2);
  assert.equal(second.cache.stats.reads, 2);
  assert.equal(second.cache.stats.hits, 0);
  assert.deepEqual(second.tasks['a.json'], { id: 'a' });
  assert.equal(fs.existsSync(cacheRootDir), false);
  assert.equal(second.cache.save(), false);
});

test('the cache file lives under the cache root and never inside the queue directory', (t) => {
  const { dir, cacheRootDir } = setup(t, { 'a.json': { id: 'a' } });
  scan(dir, BASE);
  const file = cacheFileFor(dir);
  assert.ok(file.startsWith(cacheRootDir + path.sep));
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fs.readdirSync(dir), ['a.json']);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(saved.files), ['a.json']);
});

test('without an override the cache root is tmpfs when /dev/shm is usable', (t) => {
  setup(t, {});
  delete process.env.AGENT_MANAGER_QUEUE_CACHE_DIR;
  const shmUsable = (() => { try { return fs.statSync('/dev/shm').isDirectory(); } catch (_) { return false; } })();
  const file = cacheFileFor(os.tmpdir());
  if (shmUsable) assert.ok(file.startsWith('/dev/shm/agent-manager-queue-cache/'));
  else assert.ok(file.startsWith(path.join(os.tmpdir(), 'agent-manager-queue-cache')));
  assert.match(path.basename(file), /^[0-9a-f]{12}\.json$/);
});

test('when the tmpfs directory cannot be created the cache root falls back to the OS temp dir', (t) => {
  setup(t, {});
  delete process.env.AGENT_MANAGER_QUEUE_CACHE_DIR;
  const realMkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (p, ...rest) => {
    if (String(p).startsWith('/dev/shm')) throw Object.assign(new Error('no tmpfs here'), { code: 'EACCES' });
    return realMkdir.call(fs, p, ...rest);
  });
  const file = cacheFileFor(os.tmpdir());
  assert.ok(file.startsWith(path.join(os.tmpdir(), 'agent-manager-queue-cache') + path.sep), file);
});

test('an unwritable cache root does not throw and the results stay correct', (t) => {
  const { root, dir } = setup(t, { 'a.json': { id: 'a' } });
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'a file where a directory is needed');
  process.env.AGENT_MANAGER_QUEUE_CACHE_DIR = path.join(blocker, 'cache');
  const first = scan(dir, BASE);
  assert.deepEqual(first.tasks['a.json'], { id: 'a' });
  assert.equal(first.cache.save(), false);
  const second = scan(dir, BASE + 1000);
  assert.deepEqual(second.tasks['a.json'], { id: 'a' });
  assert.equal(second.cache.stats.reads, 1);
});

test('two caches saving in turn leave valid JSON that a later open can use', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a' }, 'b.json': { id: 'b' } });
  const one = openQueueCache(dir, { now: BASE });
  const two = openQueueCache(dir, { now: BASE });
  one.names();
  two.names();
  assert.equal(one.save(), true);
  assert.equal(two.save(), true);
  const leftovers = fs.readdirSync(path.dirname(cacheFileFor(dir))).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(cacheFileFor(dir), 'utf8')));
  const later = scan(dir, BASE + 1000);
  assert.equal(later.cache.stats.reads, 0);
  assert.equal(later.names.length, 2);
});

test('a cache file with another version, or garbage, is ignored and rebuilt', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a' } });
  scan(dir, BASE);
  const file = cacheFileFor(dir);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...saved, version: 99 }));
  const other = scan(dir, BASE + 1000);
  assert.equal(other.cache.stats.statPasses, 1);
  assert.equal(other.cache.stats.reads, 1);
  fs.writeFileSync(file, '\u0000 definitely not json');
  const garbage = scan(dir, BASE + 2000);
  assert.equal(garbage.cache.stats.statPasses, 1);
  assert.deepEqual(garbage.tasks['a.json'], { id: 'a' });
});

test('REVALIDATE_MS is the exact bound of the fast path', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a' } });
  scan(dir, BASE);
  assert.equal(scan(dir, BASE + REVALIDATE_MS - 1).cache.stats.statPasses, 0);
  assert.equal(scan(dir, BASE + REVALIDATE_MS).cache.stats.statPasses, 1);
});

test('a directory changed less than RACY_MS before the scan is not trusted for the fast path', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a' } });
  const dirMtime = fs.statSync(dir).mtimeMs;
  scan(dir, dirMtime + RACY_MS - 1);
  const next = scan(dir, dirMtime + RACY_MS);
  assert.equal(next.cache.stats.statPasses, 1, 'racy scan must be redone');
  // once the scan itself is clearly after the directory change, the fast path applies
  const settled = scan(dir, dirMtime + RACY_MS * 3);
  assert.equal(settled.cache.stats.statPasses, 1, 'this scan is the first to record a non-racy time');
  assert.equal(scan(dir, dirMtime + RACY_MS * 3 + 1000).cache.stats.statPasses, 0);
});

test('a missing directory gives an empty list and does not throw', (t) => {
  const { root } = setup(t, {});
  const cache = openQueueCache(path.join(root, 'nope'), { now: BASE });
  assert.deepEqual(cache.names(), []);
  assert.equal(cache.save(), false);
});

test('readTaskCached reads a file the scan did not list directly, and reports a vanished one like readTaskSafe', (t) => {
  const { dir } = setup(t, { 'a.json': { id: 'a' } });
  const cache = openQueueCache(dir, { now: BASE });
  cache.names();
  fs.writeFileSync(path.join(dir, 'late.json'), JSON.stringify({ id: 'late' }));
  const late = readTaskCached(cache, path.join(dir, 'late.json'));
  assert.deepEqual(late.task, { id: 'late' });
  assert.ok(late.mtimeMs > 0);
  const gone = readTaskCached(cache, path.join(dir, 'gone.json'));
  assert.deepEqual(gone, { task: null, mtimeMs: 0 });
});
