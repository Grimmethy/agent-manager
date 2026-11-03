'use strict';

// wait-for-change.js -- block until one of the given directories changes, or the fallback time is up (ADR-0024 stage S3: lanes wake on change instead of
// re-checking on a timer).
//
//   node src/wait-for-change.js --timeout <secs> [--since <epoch-ms>] [--debounce <ms>] [--pool-queues <homeQueueDir>] [dir ...]
//
// Prints ONE line to stdout and exits 0:
//   event <dir>      an entry was ADDED to (or renamed into) a watched directory, after a short debounce so a burst is one wake. Removals are ignored on
//                    purpose: another lane claiming a task out of pending/ must not wake every idle lane (that would tick MORE often than the old timer).
//   catchup <dir>    with --since: an entry whose ctime is newer than that moment is ALREADY in a watched directory (it arrived between the lane's last look and this
//                    process finishing its start-up, which takes seconds on a loaded box). Returns at once. Checked by ctime because a file moved in with `mv` keeps its
//                    old mtime; removals never create a newer entry, so a claim by another lane cannot trigger it.
//   timeout          nothing was added for --timeout seconds. This is the SAFETY NET: the lane then re-checks exactly as it did on every old tick, and
//                    counts a timeout wake that finds work as a reconcile correction (a producer changed state without announcing it in a queue directory)
//   sleep            no directory could be watched: waited the full timeout, which is the old behaviour
// Register, catch up once, then react (ADR-0024): the catch-up is --since, the reaction is the watch.
// Watches are released on exit. fs.watch (inotify) works on the HDD queue dirs and on /dev/shm here; `inotifywait` is not installed.
//
// --pool-queues <homeQueueDir> adds queue/pending and queue/adhoc of the home project and of every registered project (lanes may borrow work from them).

const fs = require('fs');
const path = require('path');

// -> Promise<{ reason: 'event'|'catchup'|'timeout'|'sleep', dir?: string }>. `watch` is injectable for tests.
const CATCHUP_SCAN_CAP = 5000;

// First entry of `dir` whose ctime is newer than sinceMs. Only looked at when the directory's own mtime moved after sinceMs (one stat), so an idle directory costs one stat.
function newerEntry(dir, sinceMs) {
  try {
    if (fs.statSync(dir).mtimeMs <= sinceMs) return null;
    const names = fs.readdirSync(dir).slice(0, CATCHUP_SCAN_CAP);
    for (const name of names) {
      try { if (fs.statSync(path.join(dir, name)).ctimeMs > sinceMs) return name; } catch { /* removed meanwhile */ }
    }
  } catch { /* unreadable: the watch and the timeout still cover it */ }
  return null;
}

function waitForChange({ dirs, timeoutMs, sinceMs = null, debounceMs = 1000, watch = fs.watch, exists = fs.existsSync }) {
  return new Promise((resolve) => {
    const watchers = [];
    let done = false;
    let timer = null;
    let debounce = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(debounce);
      for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
      resolve(result);
    };
    const existing = [...new Set(dirs)].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    for (const dir of existing) {
      try {
        const w = watch(dir, { persistent: true }, (eventType, filename) => {
          if (debounce) return;
          // 'rename' is how inotify reports a create, a delete and a move; only an entry that EXISTS now was added. No filename reported: treat as added.
          if (eventType !== 'rename') return;
          if (filename && !exists(path.join(dir, String(filename)))) return;
          debounce = setTimeout(() => finish({ reason: 'event', dir }), debounceMs);
        });
        w.on('error', () => { /* a directory that vanished: the timeout still covers it */ });
        watchers.push(w);
      } catch { /* cannot watch this one: skip it */ }
    }
    if (sinceMs !== null) {
      for (const dir of existing) { if (newerEntry(dir, sinceMs)) return finish({ reason: 'catchup', dir }); }   // after the watches exist: nothing can fall in a gap
    }
    const reasonOnTimeout = watchers.length ? 'timeout' : 'sleep';
    timer = setTimeout(() => finish({ reason: reasonOnTimeout }), timeoutMs);
  });
}

function poolQueueDirs(homeQueueDir) {
  const dirs = [];
  const add = (queueDir) => { for (const sub of ['pending', 'adhoc']) dirs.push(path.join(queueDir, sub)); };
  if (homeQueueDir) add(homeQueueDir);
  try {
    const { registeredProjects } = require('./pool-projects.js');
    for (const p of registeredProjects()) add(path.join(p.pipelineDir, 'queue'));
  } catch { /* the home project alone is still a correct (smaller) watch set */ }
  return dirs;
}

module.exports = { waitForChange, poolQueueDirs };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = { timeout: 120, since: null, debounce: 1000 };
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--timeout') opt.timeout = Number(args[++i]);
    else if (a === '--since') opt.since = Number(args[++i]);
    else if (a === '--debounce') opt.debounce = Number(args[++i]);
    else if (a === '--pool-queues') dirs.push(...poolQueueDirs(args[++i]));
    else dirs.push(a);
  }
  if (!Number.isFinite(opt.timeout) || opt.timeout <= 0) opt.timeout = 120;
  waitForChange({ dirs, timeoutMs: opt.timeout * 1000, sinceMs: Number.isFinite(opt.since) ? opt.since : null, debounceMs: Number.isFinite(opt.debounce) ? opt.debounce : 1000 })
    .then((r) => { console.log(r.dir ? `${r.reason} ${r.dir}` : r.reason); process.exit(0); });
}
