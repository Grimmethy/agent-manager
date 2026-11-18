'use strict';

// Unit tests for plugin smoke-load behaviour. The loader under test is ensureRegistered()
// in src/config.js: it reads the plugin manifest (AGENT_MANAGER_PLUGINS_MANIFEST) and
// require()s each enabled registerPath. ensureRegistered() runs once per process and reads
// the manifest path at require time, so every case runs in its own child process.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG_PATH = path.resolve(__dirname, '..', 'src', 'config.js');

// Creates a fresh temp directory and removes it when the test finishes.
function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-smoke-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Writes a plugin manifest (JSON array) listing the given register paths, all enabled.
function writeManifest(dir, registerPaths) {
  const entries = registerPaths.map((registerPath, i) => ({
    name: `plugin-${i}`,
    registerPath,
    enabled: true,
    description: 'smoke-load test fixture',
  }));
  const manifestPath = path.join(dir, 'plugins.json');
  fs.writeFileSync(manifestPath, JSON.stringify(entries));
  return manifestPath;
}

// Runs ensureRegistered() in a fresh child process against the given manifest and returns
// { ok, error } as the child reported them.
function runEnsure(manifestPath) {
  const script = `
    const { ensureRegistered } = require(${JSON.stringify(CONFIG_PATH)});
    try {
      ensureRegistered();
      process.stdout.write(JSON.stringify({ ok: true }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  `;
  const env = { ...process.env, AGENT_MANAGER_PLUGINS_MANIFEST: manifestPath };
  delete env.AGENT_MANAGER_REGISTER_PATH;
  const res = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    assert.fail(`child produced no JSON result (status ${res.status}); stderr: ${res.stderr}`);
  }
  return parsed;
}

test('throwing register.js is reported as ok:false with its error message', (t) => {
  const dir = makeTempDir(t);
  const pluginDir = path.join(dir, 'bad-plugin');
  fs.mkdirSync(pluginDir);
  const registerPath = path.join(pluginDir, 'register.js');
  fs.writeFileSync(registerPath, "throw new Error('boom');\n");
  const manifestPath = writeManifest(dir, [registerPath]);

  const result = runEnsure(manifestPath);

  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0, 'error message must be non-empty');
  assert.match(result.error, /boom/);
});

test('cleanly loading register.js is reported as ok:true', (t) => {
  const dir = makeTempDir(t);
  const pluginDir = path.join(dir, 'good-plugin');
  fs.mkdirSync(pluginDir);
  const registerPath = path.join(pluginDir, 'register.js');
  fs.writeFileSync(registerPath, 'module.exports = {};\n');
  const manifestPath = writeManifest(dir, [registerPath]);

  const result = runEnsure(manifestPath);

  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
});

test('non-plugin directory (no register.js) is reported as failing to load', (t) => {
  // Production has no explicit "not a plugin" message; a directory with no register.js makes
  // require() fail with "Cannot find module", which is the observed behaviour pinned here.
  const dir = makeTempDir(t);
  const notAPlugin = path.join(dir, 'not-a-plugin');
  fs.mkdirSync(notAPlugin);
  const registerPath = path.join(notAPlugin, 'register.js');
  const manifestPath = writeManifest(dir, [registerPath]);

  const result = runEnsure(manifestPath);

  assert.equal(result.ok, false);
  assert.match(result.error, /Cannot find module/);
});
