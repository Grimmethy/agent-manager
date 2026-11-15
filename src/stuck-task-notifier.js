'use strict';

// stuck-task-notifier.js -- notify the owner immediately when a PREMIUM task lands in blocked
// or needs-clarification. Event-driven via src/wait-for-change.js; the 600-second timeout is
// the only safety-net timer and is documented on its own line.
//
// Why (2026-11-14): a build waited tens of minutes on a blocked premium piece because nobody
// looked until the next scheduled check. The existing owner notifier (src/notify.js) is the one
// phone path; this module is a trigger, not a poll.
//
// Design:
//   * scanOnce({queueDirs, seenPath, notifyFn, readTask}) walks blocked/ and needs-clarification/
//     under each queueDir, skips anything already recorded in seenPath, reads new entries, and
//     notifies ONLY when premiumPriority is true.
//   * On the very first run (no seen file) every existing entry is recorded as seen WITHOUT
//     notifying, so the pile that already exists does not flood the phone.
//   * The drain CLI loops: one scanOnce at startup, then waitForChange with a 600-second
//     timeout. On event or catchup, scanOnce again on the affected dirs. On timeout, only the
//     in-memory pending keys are retried -- no directory scan per tick.
//
// Noise control: notify()'s own dedupe (key 'stuck:<state>:<taskId>' per 60 min for urgent)
// means a task re-entering the same state within 60 minutes of the last notification will be
// reported as 'duplicate' and never reach the phone. The seen file still treats it as new (its
// mtime changed), so the next trigger will try again. If the owner needs to force a resend,
// delete the task file and recreate it (or wait 60 minutes).
//
// State file format (seenPath): object keyed by '<queueDir>|<task id>|<mtimeMs>' (string).
// Written atomically via src/atomic-write.js. A corrupt file is treated as missing on read.
//
// Collaborators are injectable (notifyFn, readTask, waitForChange) so tests use temp dirs and
// fakes only. Node built-ins only.

const fs = require('fs');
const path = require('path');
const { notify } = require('./notify.js');
const { waitForChange, poolQueueDirs } = require('./wait-for-change.js');
const { writeJsonAtomicSync } = require('./atomic-write.js');

const BLOCKED = 'blocked';
const NEEDS_CLARIFICATION = 'needs-clarification';
const STATES = [BLOCKED, NEEDS_CLARIFICATION];
const SEEN_FILE_VERSION = 1;
const DEFAULT_TIMEOUT_SEC = 600;
const TEXT_CAP = 300;
const JSON_EXT = '.json';

// ---- Seen-file helpers ----

function loadSeen(seenPath) {
  try {
    const raw = fs.readFileSync(seenPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.version === 'number' && parsed.version === SEEN_FILE_VERSION && typeof parsed.entries === 'object' && parsed.entries === parsed.entries) {
      return parsed.entries;
    }
  } catch { /* corrupt or missing: treat as empty */ }
  return {};
}

function saveSeen(seenPath, entries) {
  const dir = path.dirname(seenPath);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomicSync(seenPath, { version: SEEN_FILE_VERSION, entries });
}

function seenKey(queueDir, id, mtimeMs) {
  return `${queueDir}|${id}|${mtimeMs}`;
}

// ---- Core scan ----

async function scanOnce({ queueDirs, seenPath, notifyFn, readTask }) {
  const entries = loadSeen(seenPath);
  const isNewInstall = !fs.existsSync(seenPath);
  let notified = 0;
  const pending = []; // {queueDir, state, id, mtimeMs} -- retry on timeout / resend

  for (const queueDir of queueDirs) {
    for (const state of STATES) {
      const dir = path.join(queueDir, state);
      let files;
      try {
        files = fs.readdirSync(dir).filter((n) => n.endsWith(JSON_EXT));
      } catch {
        // Directory missing or unreadable: skip silently.
        continue;
      }
      for (const file of files) {
        const fullPath = path.join(dir, file);
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        const id = file.slice(0, -JSON_EXT.length);
        const mtimeMs = String(stat.mtimeMs);
        const key = seenKey(queueDir, id, mtimeMs);
        if (entries[key]) continue;

        let task;
        try {
          const raw = readTask(fullPath);
          task = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          // Corrupt JSON: leave unseen so the watcher re-triggers on the next event.
          continue;
        }
        if (!task || typeof task !== 'object') continue;

        if (isNewInstall) {
          // First run: record every existing entry without notifying.
          entries[key] = true;
          continue;
        }

        if (task.premiumPriority !== true) {
          entries[key] = true;
          continue;
        }

        const title = String(task.title || task.id || id || '').slice(0, 200);
        const displayTitle = title || id;
        let text = '';
        if (state === BLOCKED && task.blockedReason) {
          text = String(task.blockedReason).slice(0, TEXT_CAP);
        } else if (state === NEEDS_CLARIFICATION && task.clarificationQuestion) {
          text = String(task.clarificationQuestion).slice(0, TEXT_CAP);
        } else if (state === NEEDS_CLARIFICATION && task.question) {
          text = String(task.question).slice(0, TEXT_CAP);
        }

        pending.push({ queueDir, state, id, mtimeMs, key, title: displayTitle, text });
      }
    }
  }

  // Notify for each new premium entry.
  for (const p of pending) {
    try {
      const result = await notifyFn({
        level: 'urgent',
        key: `stuck:${p.state}:${p.id}`,
        title: `${p.state}: ${p.title} (premium)`,
        text: p.text || `${p.state}: ${p.title} (premium)`,
      });
      if (result && result.sent === true) {
        entries[p.key] = true;
        notified += 1;
      } else if (result && result.reason === 'duplicate') {
        // Already suppressed by notify()'s window; still record so we don't keep trying.
        entries[p.key] = true;
        notified += 1;
      }
      // Any other outcome (no-url, error, rate-limited, etc.): leave unseen so the next
      // trigger retries.
    } catch {
      // notifyFn must not throw per the contract, but be defensive: leave unseen.
    }
  }

  saveSeen(seenPath, entries);
  return { notified, isNew: isNewInstall, pending };
}

// ---- Drain loop ----

async function drain({ homeQueueDir, notifyFn, readTask, seenPath, timeoutSec = DEFAULT_TIMEOUT_SEC, waitForChangeFn }) {
  const wfc = waitForChangeFn || waitForChange;
  const queueDirs = [homeQueueDir, ...poolQueueDirs(homeQueueDir, STATES)];
  // Dedupe the dirs (home may appear in poolQueueDirs if it has subdirs matching STATES).
  const uniqueDirs = [...new Set(queueDirs)];

  // Initial scan (records existing entries silently if first run).
  await scanOnce({ queueDirs: uniqueDirs, seenPath, notifyFn, readTask });

  // Loop: block on watcher, then rescan.
  while (true) {
    const result = await wfc({
      dirs: uniqueDirs,
      timeoutMs: timeoutSec * 1000,
      subdirs: STATES,
    });
    if (result.reason === 'timeout' || result.reason === 'sleep') {
      // Safety net: rescan everything (a missed event or a long idle).
      await scanOnce({ queueDirs: uniqueDirs, seenPath, notifyFn, readTask });
      continue;
    }
    // event or catchup: rescan the affected directory's parents.
    await scanOnce({ queueDirs: uniqueDirs, seenPath, notifyFn, readTask });
  }
}

// ---- CLI ----

function parseArgs(argv) {
  const out = { _dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--drain') out.drain = true;
    else if (a === '--home-queue') out.homeQueueDir = argv[++i];
    else if (a === '--seen') out.seenPath = argv[++i];
    else if (a === '--timeout') out.timeoutSec = Number(argv[++i]);
    else if (a === '--pool-queues') out.poolQueues = true;
    else if (!a.startsWith('--')) out._dirs.push(a);
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.drain) {
    const homeQueueDir = args.homeQueueDir || process.env.AGENT_MANAGER_HOME_QUEUE_DIR || '';
    const seenPath = args.seenPath || path.join(process.cwd(), '.stuck-task-seen.json');
    if (!homeQueueDir) {
      process.stderr.write('stuck-task-notifier: --home-queue <dir> required for --drain\n');
      return 2;
    }
    await drain({
      homeQueueDir,
      seenPath,
      timeoutSec: Number.isFinite(args.timeoutSec) ? args.timeoutSec : DEFAULT_TIMEOUT_SEC,
    });
    return 0;
  }
  // Default: one-shot scan.
  const queueDirs = args._dirs.length ? args._dirs : [];
  if (queueDirs.length === 0) {
    process.stderr.write('usage: node src/stuck-task-notifier.js --drain [--home-queue <dir>] [--seen <path>] [--timeout <secs>]\n       node src/stuck-task-notifier.js <queueDir> [<queueDir> ...]\n');
    return 2;
  }
  const seenPath = args.seenPath || path.join(process.cwd(), '.stuck-task-seen.json');
  const result = await scanOnce({ queueDirs, seenPath, notifyFn: notify, readTask: (f) => fs.readFileSync(f, 'utf8') });
  process.stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { scanOnce, drain, main, parseArgs, seenKey, STATES };
