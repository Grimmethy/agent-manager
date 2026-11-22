'use strict';

// Pins the current batch-write bypass: sweep() files one adhoc child per filled spec section
// and never calls generationThrottled. If a future pacing change is added to the filing path,
// this test must be deliberately updated.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const ENV_KEYS = ['AGENT_MANAGER_REPO_ROOT', 'AGENT_MANAGER_PIPELINE_DIR', 'AGENT_MANAGER_APPLY_REPO_ROOT', 'AGENT_MANAGER_PRODUCT_SPEC_TO_HUB'];
const NOW = Date.parse('2026-11-14T00:00:00Z');

function loadModules() {
  for (const f of ['config.js', 'product-spec-to-hub.js', 'product-spec-assembly.js', 'generation-throttle.js']) {
    delete require.cache[path.join(SRC, f)];
  }
  return {
    cfg: require(path.join(SRC, 'config.js')),
    spec: require(path.join(SRC, 'product-spec-to-hub.js')),
    asm: require(path.join(SRC, 'product-spec-assembly.js')),
    throttle: require(path.join(SRC, 'generation-throttle.js')),
  };
}

function section(id, title, body) {
  return '<!-- section:' + id + ' -->\n## ' + title + '\n\n' + body + '\n<!-- /section:' + id + ' -->';
}

function jsonFiles(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
}

function readChildren(adhocDir) {
  return jsonFiles(adhocDir).map((n) => JSON.parse(fs.readFileSync(path.join(adhocDir, n), 'utf8')));
}

// The spy is only meaningful if the module under test calls generationThrottled through the
// module object. Current fileHub() does not import generation-throttle.js, so this counts 0.
function installSpy(throttle) {
  const original = throttle.generationThrottled;
  assert.equal(typeof original, 'function', 'generation-throttle.js must export generationThrottled');
  const calls = { n: 0 };
  throttle.generationThrottled = function spy(...args) {
    calls.n += 1;
    return original.apply(this, args);
  };
  return { calls, restore() { throttle.generationThrottled = original; } };
}

function withFixture(makeSections, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bypass-audit-'));
  try {
    process.env.AGENT_MANAGER_REPO_ROOT = root;
    process.env.AGENT_MANAGER_PIPELINE_DIR = root;
    delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    delete process.env.AGENT_MANAGER_PRODUCT_SPEC_TO_HUB;
    const mods = loadModules();
    const sections = makeSections(mods);
    const specPath = path.resolve(root, mods.cfg.getConfig().productSpecPath);
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, '# Spec\n\n' + sections.join('\n\n') + '\n');
    const reqDir = path.join(root, 'queue', 'product-spec-requests');
    fs.mkdirSync(reqDir, { recursive: true });
    fs.writeFileSync(
      path.join(reqDir, 'req-bypass.json'),
      JSON.stringify({ id: 'REQ-BYPASS', title: 'Bypass audit', buildHub: true }, null, 2)
    );
    const adhocDir = path.join(root, 'queue', 'adhoc');
    return fn({ root, adhocDir, mods });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('batch-write bypass pin: three filled sections write exactly 3 adhoc files and never call generationThrottled', () => {
  withFixture(
    () => [
      section('AC-1', 'Alpha', 'Build alpha in full.'),
      section('AC-2', 'Beta', 'Build beta in full.'),
      section('AC-3', 'Gamma', 'Build gamma in full.'),
    ],
    ({ root, adhocDir, mods }) => {
      const spy = installSpy(mods.throttle);
      try {
        const summary = mods.spec.sweep({ pipelineDir: root, force: false, now: NOW });
        assert.equal(summary.errors, 0, 'sweep reported errors');
        assert.equal(summary.filedHubs, 1, 'sweep did not file the hub');
        assert.equal(jsonFiles(adhocDir).length, 3, 'expected exactly 3 adhoc files');
        assert.equal(spy.calls.n, 0, 'generationThrottled was called during fileHub');
      } finally {
        spy.restore();
      }
    }
  );
});

test('protected case: a short-but-real one-word section still produces its own child file', () => {
  withFixture(
    () => [
      section('AC-1', 'Short', 'Yes.'),
      section('AC-2', 'Other', 'Build other in full.'),
    ],
    ({ root, adhocDir, mods }) => {
      const spy = installSpy(mods.throttle);
      try {
        mods.spec.sweep({ pipelineDir: root, force: false, now: NOW });
        const specs = readChildren(adhocDir).map((r) => r.promptContext && r.promptContext.specSection);
        assert.ok(specs.includes('AC-1'), 'expected a child file for AC-1');
        assert.ok(specs.includes('AC-2'), 'expected a child file for AC-2');
      } finally {
        spy.restore();
      }
    }
  );
});

test('placeholder-only section produces no child file (pins the existing filled filter)', () => {
  withFixture(
    (mods) => [
      section('AC-1', 'Real one', 'Build real one in full.'),
      section('AC-2', 'Pending', mods.asm.SPEC_PENDING_PLACEHOLDER),
      section('AC-3', 'Real three', 'Build real three in full.'),
    ],
    ({ root, adhocDir, mods }) => {
      const spy = installSpy(mods.throttle);
      try {
        // force=true skips the wait-for-all gate; sweep then builds only the filled sections.
        const summary = mods.spec.sweep({ pipelineDir: root, force: true, now: NOW });
        assert.equal(summary.errors, 0, 'sweep reported errors');
        assert.equal(jsonFiles(adhocDir).length, 2, 'expected exactly 2 adhoc files');
        const specs = readChildren(adhocDir).map((r) => r.promptContext && r.promptContext.specSection);
        assert.ok(!specs.includes('AC-2'), 'placeholder-only section must not produce a child file');
      } finally {
        spy.restore();
      }
    }
  );
});
