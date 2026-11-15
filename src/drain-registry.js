'use strict';

// The detached plugin drains (pipeline-ops verify/nw/merger/checker/hub/scout, context-ops map/memory/impact, pf-loops pfscraper) register with the pipeline: a drain writes
// ~/.local/state/agent-manager/pids/drain-<name>.pid with its node pid (agent-manager-pipeline-ops src/trigger.js drain()). scripts/stop.sh stops them with the other daemons and leaves the
// pipeline-stopped marker (~/.local/state/agent-manager/pipeline-stopped). This is the WATCHDOG side, run once per tick by scripts/queue-watcher.sh (`node src/drain-registry.js sweep`):
//   marker present   -> SIGTERM every drain that is still running (a drain that missed the marker, or one started before the stop), one log line each;
//   marker absent    -> delete the pidfile of every drain whose pid is dead, so a stale file never makes the status lie (its trigger starts the drain again on its next wake-up).
// Standard library only. kill and alive are injectable so tests never signal a real process.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stateDir(env = process.env) {
  return path.join((env && env.HOME) || os.homedir(), '.local', 'state', 'agent-manager');
}
const pidsDir = (env) => path.join(stateDir(env), 'pids');
const markerPath = (env) => path.join(stateDir(env), 'pipeline-stopped');

function pipelineStopped(env = process.env) {
  return fs.existsSync(markerPath(env));
}

function defaultAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// [{ name, pid, running }] for every drain-<name>.pid with a valid pid, sorted by name. A garbled file and any other pidfile (plugin-*, worker-*, dashboard) are ignored.
function listDrains(env = process.env, alive = defaultAlive) {
  let files = [];
  try { files = fs.readdirSync(pidsDir(env)); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = /^drain-(.+)\.pid$/.exec(f);
    if (!m) continue;
    let pid;
    try { pid = Number(fs.readFileSync(path.join(pidsDir(env), f), 'utf8').trim()); } catch { continue; }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({ name: m[1], pid, running: alive(pid) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function sweep({ env = process.env, kill = (pid) => process.kill(pid, 'SIGTERM'), alive = defaultAlive, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const stopped = [];
  const removed = [];
  const drains = listDrains(env, alive);
  if (pipelineStopped(env)) {
    for (const d of drains) {
      if (!d.running) continue;
      try { kill(d.pid); } catch { continue; }
      stopped.push(d.name);
      log(`[watchdog] stopped drain ${d.name} (pid ${d.pid}): pipeline stopped`);
    }
  } else {
    for (const d of drains) {
      if (d.running) continue;
      try { fs.unlinkSync(path.join(pidsDir(env), `drain-${d.name}.pid`)); } catch { continue; }
      removed.push(d.name);
      log(`[watchdog] removed stale drain pidfile ${d.name}`);
    }
  }
  return { stopped, removed };
}

if (require.main === module && process.argv[2] === 'sweep') {
  let result = { stopped: [], removed: [] };
  try { result = sweep(); } catch (e) { process.stderr.write(`[watchdog] drain-registry sweep failed: ${e && e.message ? e.message : e}\n`); }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

module.exports = { stateDir, markerPath, pipelineStopped, listDrains, sweep };
