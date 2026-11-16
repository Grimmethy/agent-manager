'use strict';

// plugin-canary-sweep.js -- run each enabled plugin's test suite when core HEAD moves, and queue an adhoc task for each plugin that goes red.
//
// Event-driven, not periodic (ADR-0024): this module adds no timer. It does nothing until sweepPluginCanaries() is called. The intended trigger is core HEAD
// moving, wired by a sibling task (watch .git/HEAD and .git/packed-refs, or a post-merge hook).
//
// Gates, in order, before any work: kill switch AGENT_MANAGER_PLUGIN_CANARY=false, then core HEAD equal to queue/plugin-canary-state.json's last_tested_sha.
// Plugins run one at a time, each in its own root (dirname(registerPath), as accessible-roots.js does), each with a timeout. A timeout counts as a failure.
// A plugin is filed at most once per core sha (state.filed[sha]). last_tested_sha is written only after the whole loop completes, so a crash mid-sweep
// re-runs the remaining plugins next time instead of skipping them. Per-plugin progress is still saved after each plugin.
// CLI: node plugin-canary-sweep.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { readPluginsManifest, enabledRegisterPaths } = require('./plugins-manifest.js');

const STATE_FILE = 'plugin-canary-state.json';
const SUITE_COMMAND = 'npm test';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function enabled() { return process.env.AGENT_MANAGER_PLUGIN_CANARY !== 'false'; }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

// Default spawn helper: resolves (never rejects) with { code, timedOut, stdout, stderr }.
function defaultRunCommand(command, { cwd, timeout, env } = {}) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const errOut = String(stderr || '');
      if (!err) return resolve({ code: 0, timedOut: false, stdout: out, stderr: errOut });
      resolve({ code: typeof err.code === 'number' ? err.code : 1, timedOut: !!err.killed, stdout: out, stderr: errOut });
    });
  });
}

// Read-only: prefer `git rev-parse HEAD`, fall back to reading .git/HEAD, the ref it names, or packed-refs.
function readHeadFromFiles(repoRoot) {
  const gitDir = path.join(repoRoot, '.git');
  let head;
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch { return null; }
  if (!head.startsWith('ref: ')) return head || null;
  const ref = head.slice(5).trim();
  try { const sha = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim(); if (sha) return sha; } catch { /* packed */ }
  try {
    for (const line of fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
      const m = line.match(/^([0-9a-f]{40}) (\S+)$/i);
      if (m && m[2] === ref) return m[1];
    }
  } catch { /* no packed-refs */ }
  return null;
}

async function coreHeadSha(repoRoot, runCommand, env) {
  const r = await runCommand('git rev-parse HEAD', { cwd: repoRoot, timeout: 30000, env });
  const out = r && r.code === 0 ? String(r.stdout || '').trim() : '';
  if (/^[0-9a-f]{40}$/i.test(out)) return out;
  return readHeadFromFiles(repoRoot);
}

async function sweepPluginCanaries({ repoRoot, pipelineDir, runCommand = defaultRunCommand, queueTask, statePath, timeoutMs = DEFAULT_TIMEOUT_MS, suiteCommand = SUITE_COMMAND, env, now = new Date(), dryRun = false } = {}) {
  if (!enabled()) return { skipped: 'disabled' };
  if (!repoRoot) throw new Error('sweepPluginCanaries: repoRoot required');
  const sweepEnv = env || { ...process.env, CI: '1' };
  const core = await coreHeadSha(repoRoot, runCommand, sweepEnv);
  if (!core) return { skipped: 'no-core-sha' };
  const stateFile = statePath || path.join(pipelineDir || repoRoot, 'queue', STATE_FILE);
  const state = readJson(stateFile) || {};
  state.plugins = state.plugins || {};
  state.filed = state.filed || {};
  if (state.last_tested_sha === core) return { skipped: 'unchanged', sha: core };

  const roots = enabledRegisterPaths(readPluginsManifest()).map((rp) => path.dirname(rp));
  const summary = { sha: core, ran: [], filed: [] };
  for (const root of roots) {
    const name = path.basename(root);
    const r = await runCommand(suiteCommand, { cwd: root, timeout: timeoutMs, env: sweepEnv });
    // A timed-out suite is a red canary, not a pass.
    const result = r.timedOut ? 'timeout' : (r.code === 0 ? 'pass' : 'fail');
    summary.ran.push({ name, result });
    state.plugins[name] = { sha: core, result, testedAt: now.toISOString() };
    const filedForSha = Array.isArray(state.filed[core]) ? state.filed[core] : [];
    if (result !== 'pass' && !filedForSha.includes(name) && !dryRun) {
      if (typeof queueTask !== 'function') throw new Error('sweepPluginCanaries: queueTask required to file a failing plugin');
      const tail = String(r.stderr || r.stdout || '').slice(-500);
      await queueTask({
        title: `Plugin canary red: ${name} at core ${core.slice(0, 10)}`,
        description: `Plugin ${name} (${root}) ${result === 'timeout' ? 'timed out' : 'failed'} running "${suiteCommand}" after core HEAD moved to ${core}. Check whether the core change broke this plugin and fix the plugin or the core interface it relies on.\n\nOutput tail:\n${tail}`,
        source: 'plugin-canary',
      });
      state.filed[core] = [...filedForSha, name];
      summary.filed.push(name);
    }
    if (!dryRun) writeJsonAtomic(stateFile, state);
  }
  // Only after the whole loop: a crash earlier leaves last_tested_sha stale, so the next run retries.
  if (!dryRun) {
    state.last_tested_sha = core;
    state.last_tested_at = now.toISOString();
    writeJsonAtomic(stateFile, state);
  }
  return summary;
}

module.exports = { sweepPluginCanaries, enabled, STATE_FILE };

if (require.main === module) {
  const { getConfig } = require('./config.js');
  const { repoRoot, pipelineDir } = getConfig();
  sweepPluginCanaries({ repoRoot, pipelineDir, dryRun: process.argv.includes('--dry-run') })
    .then((s) => process.stdout.write(JSON.stringify(s) + '\n'))
    .catch((e) => { console.error(e); process.exit(1); });
}
