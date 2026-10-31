'use strict';

// A RAM-only cache of the parsed task files in one queue stage directory (queue/pending, ...).
//
// Why: every worker claim used to list queue/pending and read + parse EVERY file in it (3576 files / 58 MB measured 2026-10-28): 0.7 s with a warm
// page cache and 43.8 s on a cold HDD, and the reads competed with model loads for the same disk. This cache lets a tick that finds the directory
// unchanged pay one stat of the directory and read no task file at all.
//
// It lives in tmpfs (/dev/shm), never on a disk: the queue is rewritten constantly and the owner does not want that traffic on the SSD or extra
// writes on the HDD. Losing it (reboot, kill switch) only costs one full scan.
//
// How it stays correct:
//   - A file added to or removed from the directory changes the directory's mtime, so the next call sees it.
//   - An in-place edit of an existing file does not change the directory's mtime; every REVALIDATE_MS the directory gets a full stat pass, which
//     re-reads any file whose mtime or size changed. So such an edit is seen within REVALIDATE_MS.
//   - File timestamps tick in coarse steps (a few ms), so a change made in the same tick as a scan can leave the directory mtime unchanged. Like git's
//     "racy" index entries, a directory modified less than RACY_MS before the scan is not trusted for the fast path next time.
//   - Fail open: any problem reading, parsing or writing the cache falls back to a direct read and never throws to the caller. The kill switch
//     AGENT_MANAGER_QUEUE_CACHE=false makes everything behave exactly like the uncached code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REVALIDATE_MS = 60000;
const RACY_MS = 2000;
const CACHE_VERSION = 1;

function cacheDisabled() {
  return /^false$/i.test(String(process.env.AGENT_MANAGER_QUEUE_CACHE || '').trim());
}

// env override, then tmpfs, then the OS temp dir (only when /dev/shm is missing or cannot be written: creating our directory there is the test).
function cacheRoot() {
  if (process.env.AGENT_MANAGER_QUEUE_CACHE_DIR) return process.env.AGENT_MANAGER_QUEUE_CACHE_DIR;
  const shm = '/dev/shm/agent-manager-queue-cache';
  try {
    fs.mkdirSync(shm, { recursive: true });
    return shm;
  } catch (_) { /* no usable tmpfs */ }
  return path.join(os.tmpdir(), 'agent-manager-queue-cache');
}

function realDir(dir) {
  try { return fs.realpathSync(dir); } catch (_) { return dir; }
}

function cacheFileFor(dir) {
  const id = crypto.createHash('sha1').update(realDir(dir)).digest('hex').slice(0, 12);
  return path.join(cacheRoot(), `${id}.json`);
}

function emptyState(dir) {
  return { version: CACHE_VERSION, dir, dirMtimeMs: 0, checkedAtMs: 0, names: [], files: {} };
}

function loadState(file, dir) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && s.version === CACHE_VERSION && s.dir === dir && Array.isArray(s.names) && s.files && typeof s.files === 'object') return s;
  } catch (_) { /* missing, garbage or another version: start empty */ }
  return emptyState(dir);
}

// Same shape and semantics as readTaskSafe in next-claimable-task.js: task is null when the file is unreadable or corrupt, mtimeMs is 0 when it vanished.
function readFileTask(fullPath) {
  let mtimeMs = 0;
  let size = 0;
  try { const st = fs.statSync(fullPath); mtimeMs = st.mtimeMs; size = st.size; } catch (_) { /* vanished */ }
  let task = null;
  try { task = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch (_) { /* corrupt or partial write */ }
  return { task, mtimeMs, size };
}

function openQueueCache(dir, opts = {}) {
  const now = () => (opts.now !== undefined ? opts.now : Date.now());
  const stats = { reads: 0, hits: 0, statPasses: 0 };
  const disabled = cacheDisabled();
  const real = realDir(dir);
  const file = cacheFileFor(dir);
  const state = disabled ? emptyState(real) : loadState(file, real);
  let dirty = false;
  let namesMemo = null;
  const fresh = new Set(); // files read during this open's full pass: served from the cache afterwards, but not counted as hits

  function listJson() {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  }

  function names() {
    if (namesMemo) return namesMemo.slice();
    if (disabled) {
      try { namesMemo = listJson(); } catch (_) { namesMemo = []; }
      return namesMemo.slice();
    }
    let dirStat;
    try { dirStat = fs.statSync(dir); } catch (_) { namesMemo = []; return []; }
    const t = now();
    const trusted = state.dirMtimeMs === dirStat.mtimeMs
      && t - state.checkedAtMs < REVALIDATE_MS
      && state.checkedAtMs - state.dirMtimeMs > RACY_MS;
    if (trusted) {
      namesMemo = state.names.slice();
      return namesMemo.slice();
    }
    // Full pass. The directory mtime is taken BEFORE the readdir, so a change made while we scan shows up as a different mtime next call.
    let listed;
    try { listed = listJson(); } catch (_) { namesMemo = []; return []; }
    stats.statPasses += 1;
    const files = {};
    const kept = [];
    for (const name of listed) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; } // vanished since the readdir
      const prev = state.files[name];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
        files[name] = prev;
      } else {
        const read = readFileTask(full);
        stats.reads += 1;
        fresh.add(name);
        files[name] = { mtimeMs: read.mtimeMs || st.mtimeMs, size: st.size, task: read.task };
      }
      kept.push(name);
    }
    state.files = files;
    state.names = kept;
    state.dirMtimeMs = dirStat.mtimeMs;
    state.checkedAtMs = t;
    dirty = true;
    namesMemo = kept;
    return kept.slice();
  }

  function save() {
    if (disabled || !dirty) return false;
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
      dirty = false;
      return true;
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (_e) { /* nothing to clean */ }
      return false;
    }
  }

  return { dir, names, save, stats, entry: (name) => state.files[name] || null, fresh, disabled };
}

// { task, mtimeMs } for fullPath, from the cache when its directory scan already holds the file, else read directly (and not cached).
function readTaskCached(cache, fullPath) {
  if (cache && !cache.disabled) {
    const hit = cache.entry(path.basename(fullPath));
    if (hit) {
      if (!cache.fresh.has(path.basename(fullPath))) cache.stats.hits += 1;
      return { task: hit.task, mtimeMs: hit.mtimeMs };
    }
  }
  const read = readFileTask(fullPath);
  if (cache) cache.stats.reads += 1;
  return { task: read.task, mtimeMs: read.mtimeMs };
}

module.exports = { openQueueCache, readTaskCached, cacheFileFor, REVALIDATE_MS, RACY_MS };
