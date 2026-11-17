'use strict';
// Isolated plugin smoke-load helper. Checks whether a repo is a plugin (via its own plugins.json)
// and smoke-loads its register file in a child process, so plugin code never runs in the caller.
// CLI: node src/plugin-smoke-load.js <dir>  -> prints one JSON line { ok, error }.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Upper bound for a single smoke-load child process.
const SMOKE_TIMEOUT_MS = 10000;

// Reads <repoPath>/plugins.json and returns the first enabled entry's registerPath (resolved
// against the repo root) if that file exists on disk. Never requires or executes plugin code.
function isPluginRepo(repoPath) {
  const none = { isPlugin: false, registerPath: null };
  if (typeof repoPath !== 'string' || !repoPath.trim()) return none;
  const root = path.resolve(repoPath);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugins.json'), 'utf8'));
  } catch (_) {
    return none;
  }
  if (!Array.isArray(manifest)) return none;
  const declares = manifest.some((e) => e && e.enabled !== false
    && typeof e.registerPath === 'string' && e.registerPath.trim());
  if (!declares) return none;
  const abs = path.join(root, 'register.js');
  if (!fs.existsSync(abs)) return none;
  return { isPlugin: true, registerPath: abs };
}

// Smoke-loads a plugin repo's register file in an isolated child process and prints one JSON line.
function smokeLoad(dir) {
  const info = isPluginRepo(dir);
  let result;
  if (!info.isPlugin) {
    result = { ok: false, error: 'not a plugin repo' };
  } else {
    const r = spawnSync(process.execPath, [__filename, '--child', info.registerPath], {
      timeout: SMOKE_TIMEOUT_MS,
      cwd: path.resolve(dir),
      encoding: 'utf8',
    });
    if (r.error) {
      result = { ok: false, error: r.error.code === 'ETIMEDOUT' ? 'timed out' : String(r.error.message || r.error) };
    } else if (r.signal) {
      result = { ok: false, error: `killed by signal ${r.signal}` };
    } else if (r.status !== 0) {
      const line = String(r.stderr || '').split('\n').map((s) => s.trim()).find(Boolean);
      result = { ok: false, error: line || `exited with status ${r.status}` };
    } else {
      result = { ok: true, error: null };
    }
  }
  console.log(JSON.stringify(result));
  return result;
}

if (require.main === module) {
  const argv = process.argv;
  if (argv[2] === '--child') {
    // Child mode: load the register file; any throw is reported on stderr with exit 1.
    try {
      require(argv[3]);
    } catch (err) {
      process.stderr.write(String((err && err.message) || err) + '\n');
      process.exit(1);
    }
    process.exit(0);
  } else if (!argv[2]) {
    process.stderr.write('usage: node src/plugin-smoke-load.js <dir>\n');
    process.exitCode = 2;
  } else {
    smokeLoad(argv[2]);
    process.exitCode = 0;
  }
}

module.exports = { isPluginRepo, smokeLoad };
