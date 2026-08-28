'use strict';

// Regression (2026-08-28): after the hygiene-plugin split, requiring prompts.js ->
// task-sources.js no longer registers the moved sources -- only ensureRegistered()
// (config.js), which loads AGENT_MANAGER_REGISTER_PATH, does. The worker's draft entry
// point (local-draft.js) and the reviewer's (review-task.js) were relying on the old
// eager side effect, so every plugin-source task hit "no prompt template for
// source=arch_review" (draft) or had its advisoryProse verdict wrongly auto-rejected
// (review). This pins that each loop entry point calls ensureRegistered() at module load.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// A minimal plugin: registers one source with a marker flag, via the same registry the
// real entry points use.
function writePluginFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-points-plugin-'));
  const file = path.join(dir, 'register.js');
  fs.writeFileSync(file, [
    "'use strict';",
    "const { registerTaskSource } = require(" + JSON.stringify(path.join(__dirname, 'task-source-registry.js')) + ");",
    "if (!require(" + JSON.stringify(path.join(__dirname, 'task-source-registry.js')) + ").getRegisteredSource('__plugin_probe__')) {",
    "  registerTaskSource('__plugin_probe__', { priority: 999, next: () => null, __fromPlugin: true });",
    "}",
  ].join('\n'));
  return file;
}

function freshRequire(rel) {
  delete require.cache[require.resolve(rel)];
  // config.js's `registered` one-shot guard is module state -- bust it too so
  // ensureRegistered() actually re-runs on this fresh entry-point require.
  delete require.cache[require.resolve('./config.js')];
  return require(rel);
}

for (const entryPoint of ['./local-draft.js', './review-task.js', './apply-task.js', './get-grounding-source.js']) {
  test(`${entryPoint} calls ensureRegistered() at module load (picks up AGENT_MANAGER_REGISTER_PATH plugins)`, () => {
    const prevRegister = process.env.AGENT_MANAGER_REGISTER_PATH;
    const prevRepoRoot = process.env.AGENT_MANAGER_REPO_ROOT;
    process.env.AGENT_MANAGER_REGISTER_PATH = writePluginFixture();
    process.env.AGENT_MANAGER_REPO_ROOT = process.cwd();
    try {
      const { clearRegistry, getRegisteredSource } = freshRequire('./task-source-registry.js');
      clearRegistry();
      const { clearModelProfileRegistry } = require('./model-profile-registry.js');
      clearModelProfileRegistry();
      delete require.cache[require.resolve('./task-sources.js')];
      delete require.cache[require.resolve('./prompts.js')];
      freshRequire(entryPoint);
      const probe = getRegisteredSource('__plugin_probe__');
      assert.ok(probe && probe.__fromPlugin, `requiring ${entryPoint} must have run ensureRegistered() and loaded the plugin`);
    } finally {
      if (prevRegister === undefined) delete process.env.AGENT_MANAGER_REGISTER_PATH; else process.env.AGENT_MANAGER_REGISTER_PATH = prevRegister;
      if (prevRepoRoot === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prevRepoRoot;
      delete require.cache[require.resolve('./config.js')];
    }
  });
}
