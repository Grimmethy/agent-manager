'use strict';

// Plugin watchdog scripts: the generic replacement for a hardcoded per-plugin block in scripts/queue-watcher.sh.
//
// An ENABLED plugins.json entry may declare
//   "watchdogScripts": ["relative/path/to/script.js"]
// and the watchdog runs each script once per tick (scripts/run-plugin-watchdog-scripts.sh), with a timeout, logging the script's first
// stdout line and isolating its failures. The watchdog is the project's single clock (ADR-0024, owner direction 2026-11-02: move away from
// timers), so a plugin that needs "check something cheap every tick, act only on a change" registers here instead of starting its own timer.
// A script must do one cheap edge check and return fast; anything slow starts a detached singleton (see scripts/lib/start-singleton-bg.sh).
//
// Interim: the event that would make this unnecessary is the queue-events journal (ADR-0024 S1, not built).
//
// Pure listing logic below; the CLI prints one "<plugin>\t<absolute script path>" line per script (what the shell helper reads), or --json.

const path = require('path');
const { readPluginsManifest } = require('./plugins-manifest.js');

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

// null when the script path is acceptable, else a short reason. rel must be relative, free of '..' and a .js file (which together keep it inside the plugin root).
function checkScript(rel) {
  if (typeof rel !== 'string' || !rel.trim()) return 'must be a non-empty string';
  const s = rel.trim();
  if (path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) return 'must be relative to the plugin root';
  if (s.split(/[\\/]+/).includes('..')) return "must not contain '..'";
  if (!s.endsWith('.js')) return 'must be a .js file';
  return null;
}

// manifest: the parsed plugins.json array. Returns { scripts: [{plugin, root, script, abs}], skipped: [{plugin, script, reason}] }; never throws.
function listWatchdogScripts(manifest) {
  const scripts = [];
  const skipped = [];
  if (!Array.isArray(manifest)) return { scripts, skipped };
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.enabled === false) continue;
    if (typeof entry.registerPath !== 'string' || !entry.registerPath.trim()) continue;
    if (entry.watchdogScripts === undefined) continue;
    const plugin = typeof entry.name === 'string' ? entry.name : '';
    if (!SAFE_NAME.test(plugin)) {
      skipped.push({ plugin, script: '', reason: 'plugin name must be letters, digits, dot, dash or underscore' });
      continue;
    }
    if (!Array.isArray(entry.watchdogScripts)) {
      skipped.push({ plugin, script: '', reason: 'watchdogScripts must be an array' });
      continue;
    }
    const root = path.dirname(entry.registerPath.trim());
    for (const rel of entry.watchdogScripts) {
      const reason = checkScript(rel);
      if (reason) skipped.push({ plugin, script: typeof rel === 'string' ? rel : '', reason });
      else scripts.push({ plugin, root, script: rel.trim(), abs: path.resolve(root, rel.trim()) });
    }
  }
  return { scripts, skipped };
}

function main(argv) {
  const { scripts, skipped } = listWatchdogScripts(readPluginsManifest());
  for (const s of skipped) process.stderr.write(`[plugin-watchdog-scripts] skipped ${s.plugin || '(unnamed)'} ${s.script}: ${s.reason}\n`);
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ scripts, skipped }) + '\n');
  else for (const s of scripts) process.stdout.write(`${s.plugin}\t${s.abs}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { listWatchdogScripts, checkScript };
