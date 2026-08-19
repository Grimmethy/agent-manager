'use strict';

// Append-only uptime sample log, one line (JSONL) per queue-watcher.sh tick, feeding
// system-report.js's downtime accounting (Grimmethy, 2026-08-19: "the report should track
// downtimes"). There is no separate always-on health-check process in this pipeline --
// queue-watcher.sh's own tick loop is the only thing that runs continuously regardless of
// which worker/reviewer lane is up, so it doubles as the sampler. This means a sample can
// only ever be taken while the WATCHDOG itself is alive; a gap in the log (no samples for
// longer than a few tick intervals) is itself the signal that the pipeline -- watchdog
// included -- was down for that stretch, not just an unmonitored blind spot. That's a
// real, if imperfect, limitation: self-monitoring can't observe its own downtime any more
// precisely than "no samples were written," which is exactly what gap-detection reports.
//
// Each sample: { at, instances: { <instanceId>: { pid, status, lastHeartbeat, ageSec,
// stale } } }. `stale` reuses dead-process-check.js's own STALE_HEARTBEAT_SECONDS/
// WORKER_ZOMBIE_THRESHOLD_SECONDS reasoning (worker-only: alive-but-unresponsive past the
// zombie threshold counts as down; a non-worker instance uses the tighter stale
// threshold) so "down" means the same thing here as it does to the daemon that actually
// restarts things.

const fs = require('fs');
const path = require('path');

const STALE_HEARTBEAT_SECONDS = 300;
const WORKER_ZOMBIE_THRESHOLD_SECONDS = 1200;
const MAX_LOG_AGE_DAYS = 35; // bounds the file indefinitely; see pruneOldSamples()

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logPath(instancesDir) {
  return path.join(instancesDir, '.uptime-log.jsonl');
}

// Appends one sample, reading every instances/*.json heartbeat that isn't itself a dotfile
// (see dead-process-check.js's identical filter and its own header for why -- .active-
// local-model.json / .watchdog-restart-cooldown.json / this log itself all live in the
// same directory and must never be mistaken for a real instance).
function appendSample(instancesDir, now = new Date()) {
  let names = [];
  try {
    names = fs.readdirSync(instancesDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return;
  }

  const instances = {};
  for (const name of names) {
    let hb;
    try {
      hb = JSON.parse(fs.readFileSync(path.join(instancesDir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!hb || !hb.instanceId) continue;
    const ageSec = hb.lastHeartbeat ? (now.getTime() - new Date(hb.lastHeartbeat).getTime()) / 1000 : null;
    const pidAlive = isProcessAlive(hb.pid);
    const isWorker = hb.instanceId.startsWith('worker-');
    const staleThreshold = isWorker ? WORKER_ZOMBIE_THRESHOLD_SECONDS : STALE_HEARTBEAT_SECONDS;
    const stale = !pidAlive || (ageSec != null && ageSec > staleThreshold);
    instances[hb.instanceId] = { pid: hb.pid ?? null, status: hb.status ?? null, lastHeartbeat: hb.lastHeartbeat ?? null, ageSec, stale };
  }

  const sample = { at: now.toISOString(), instances };
  fs.appendFileSync(logPath(instancesDir), JSON.stringify(sample) + '\n');
}

// Drops any sample older than MAX_LOG_AGE_DAYS -- called occasionally (see queue-
// watcher.sh's own tick cadence for this), not on every append, since it requires a full
// rewrite of the file.
function pruneOldSamples(instancesDir, now = new Date()) {
  const p = logPath(instancesDir);
  let lines;
  try {
    lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  } catch {
    return;
  }
  const cutoff = now.getTime() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;
  const kept = lines.filter((line) => {
    try {
      return new Date(JSON.parse(line).at).getTime() >= cutoff;
    } catch {
      return false; // drop unparseable lines too -- a corrupt line is worse than a missing sample.
    }
  });
  if (kept.length !== lines.length) fs.writeFileSync(p, kept.length ? kept.join('\n') + '\n' : '');
}

// Reads every sample with `at` inside [startIso, endIso) -- plus the single sample
// immediately BEFORE the window (if any), so a gap that started before the window but
// extends into it is still detected instead of silently starting the window's downtime
// clock at zero.
function readSamplesInWindow(instancesDir, startIso, endIso) {
  const p = logPath(instancesDir);
  let lines;
  try {
    lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const all = [];
  for (const line of lines) {
    try {
      const s = JSON.parse(line);
      all.push(s);
    } catch {
      // skip corrupt line
    }
  }
  all.sort((a, b) => new Date(a.at) - new Date(b.at));

  const inWindow = all.filter((s) => {
    const t = new Date(s.at).getTime();
    return t >= start && t < end;
  });
  const before = [...all].reverse().find((s) => new Date(s.at).getTime() < start);
  return before ? [before, ...inWindow] : inWindow;
}

module.exports = { appendSample, pruneOldSamples, readSamplesInWindow, logPath, isProcessAlive, STALE_HEARTBEAT_SECONDS, WORKER_ZOMBIE_THRESHOLD_SECONDS };

// CLI: `node uptime-log.js --sample`, called once per queue-watcher.sh tick (see that
// script's own comment for why THIS loop is the sampler). Prunes only ~1/60 of calls
// (roughly hourly at a 60s tick cadence) since pruneOldSamples rewrites the whole file.
if (require.main === module) {
  if (process.argv.includes('--sample')) {
    const { getConfig } = require('./config.js');
    const { pipelineDir } = getConfig();
    const instancesDir = path.join(pipelineDir, 'instances');
    appendSample(instancesDir);
    if (Math.random() < 1 / 60) pruneOldSamples(instancesDir);
  } else {
    console.error('Usage: node uptime-log.js --sample');
    process.exit(1);
  }
}
