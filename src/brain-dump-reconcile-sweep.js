'use strict';

// brain-dump-reconcile-sweep.js -- the caller for src/brain-dump-reconcile.js (HUB0226, 2026-10-31).
//
// Why: the reconcile closes a brain-dump entry when a task that names it has merged or been superseded, but only the manual script called it, so nothing closed
// entries automatically. This sweep runs it from the watchdog tick.
//
// Triggers, not polls (ADR-0024): why no event exists -- tasks reach done/ from the dashboard merge route (python), from apply-task (node) and from sweeps, so there
// is no single place to announce from. The one signal every writer leaves is the mtime of <pipelineDir>/queue/done (it changes when a task file lands in it), plus the
// brain-dump file's own mtime. The idle cost per tick is two stat calls plus this node start; reconcile itself only runs when one of them moved. A slow full run
// (every RECONCILE_EVERY_MS) is the counted safety net: when it finds changes although neither mtime moved, `reconcileMissed` is set and a warning is logged,
// because that means a writer changed the work without touching done/ or the dump.
//
// AGENT_MANAGER_BRAIN_DUMP_RECONCILE=off|dry-run|on (default dry-run: logs what it would change, writes nothing). CLI: node brain-dump-reconcile-sweep.js
// prints one JSON line.

const fs = require('fs');
const path = require('path');

const RECONCILE_EVERY_MS = 6 * 60 * 60 * 1000;
const STATE_FILE = 'brain-dump-reconcile-state.json';

function mode(env = process.env) {
  const v = String(env.AGENT_MANAGER_BRAIN_DUMP_RECONCILE || 'dry-run').toLowerCase();
  return v === 'off' || v === 'false' || v === '0' ? 'off' : v === 'on' || v === 'true' || v === '1' ? 'on' : 'dry-run';
}

function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
}

function sweepBrainDumpReconcile({ reconcile, env = process.env, now = Date.now(), pipelineDir, brainDumpPath, log = (l) => console.error(l) } = {}) {
  const m = mode(env);
  const summary = { mode: m, ran: false };
  if (m === 'off') return summary;
  const run = reconcile || require('./brain-dump-reconcile.js').reconcileBrainDumpEntries;
  const queueDir = path.join(pipelineDir, 'queue');
  const statePath = path.join(queueDir, STATE_FILE);

  // Read the signals BEFORE running, so a change made while reconcile runs triggers the next tick.
  const doneMtimeMs = mtimeMs(path.join(queueDir, 'done'));
  const dumpMtimeMs = mtimeMs(brainDumpPath);
  const state = readState(statePath);
  const unchanged = state.doneMtimeMs === doneMtimeMs && state.dumpMtimeMs === dumpMtimeMs;
  const recent = Number.isFinite(state.lastRunAt) && now - state.lastRunAt < RECONCILE_EVERY_MS;
  if (unchanged && recent) return { ...summary, reason: 'unchanged' };

  const logger = { info: (l) => log(`[brain-dump-reconcile] ${l}`), warn: (l) => log(`[brain-dump-reconcile] ${l}`) };
  let result;
  try {
    result = run({ dryRun: m !== 'on', logger });
  } catch (e) {
    log(`[brain-dump-reconcile] ${e.message}`);
    return { ...summary, error: e.message };           // the saved state stays as it was, so the next tick retries
  }
  summary.ran = true;
  summary.counts = result.counts;
  summary.changes = result.changes.length;
  if (m === 'dry-run') for (const c of result.changes) log(`[brain-dump-reconcile] would ${c.action} ${c.entryId}${c.taskId ? ` (${c.taskId})` : ''}`);
  if (unchanged && result.changes.length) {
    summary.reconcileMissed = result.changes.length;
    log(`[brain-dump-reconcile] WARNING: ${result.changes.length} change(s) found by the periodic run although neither queue/done nor the brain dump changed: a writer is not announcing`);
  }
  try {
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ doneMtimeMs, dumpMtimeMs, lastRunAt: now }));
  } catch (e) { log(`[brain-dump-reconcile] could not save state: ${e.message}`); }
  return summary;
}

module.exports = { sweepBrainDumpReconcile, mode, RECONCILE_EVERY_MS, STATE_FILE };

if (require.main === module) {
  const config = require('./config.js');
  const cfg = config.getConfig ? config.getConfig() : config;
  // The same file reconcileBrainDumpEntries reads: AGENT_MANAGER_BRAIN_DUMP_PATH, else <pipelineDir>/brain-dump.json.
  const brainDumpPath = process.env.AGENT_MANAGER_BRAIN_DUMP_PATH || path.join(cfg.pipelineDir, 'brain-dump.json');
  const out = sweepBrainDumpReconcile({ pipelineDir: cfg.pipelineDir, brainDumpPath });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
