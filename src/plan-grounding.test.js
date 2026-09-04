'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildPlanGrounding, groundingCovers, PLAN_GROUNDING_MAX_CHARS } = require('./plan-grounding.js');

const _envSnapshot = { root: process.env.AGENT_MANAGER_REPO_ROOT, grep: process.env.AGENT_MANAGER_GREP_DIRS };
test.after(() => {
  if (_envSnapshot.root === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT;
  else process.env.AGENT_MANAGER_REPO_ROOT = _envSnapshot.root;
  if (_envSnapshot.grep === undefined) delete process.env.AGENT_MANAGER_GREP_DIRS;
  else process.env.AGENT_MANAGER_GREP_DIRS = _envSnapshot.grep;
});

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-grounding-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  // grepCodebase reads AGENT_MANAGER_REPO_ROOT via getConfig(); point it at this tmp repo
  // so config resolution succeeds regardless of what other test files left in the env.
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  return dir;
}
const adhoc = (rawText, extra = {}) => ({ source: 'manual', domain: 'adhoc', promptContext: { rawText, ...extra } });

test('null when repoRoot unresolvable', () => {
  assert.equal(buildPlanGrounding(adhoc('do a thing'), { repoRoot: '' }), null);
});

test('null when nothing to say (no anchor files, no grep hits)', () => {
  const dir = makeRepo({ 'src/a.js': 'x\n' });
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  const g = buildPlanGrounding(adhoc('reorganize the widget layout entirely'), { repoRoot: dir });
  assert.equal(g, null);
});

test('anchor file the task names is read fresh and rendered', () => {
  const dir = makeRepo({ 'src/widget-store.js': 'function renderWidgetStore() { return COOLDOWN_TRACKER; }\n' });
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  const g = buildPlanGrounding(adhoc('Change renderWidgetStore in src/widget-store.js'), { repoRoot: dir });
  assert.ok(g);
  assert.deepEqual(g.anchorPaths, ['src/widget-store.js']);
  assert.match(g.text, /--- src\/widget-store\.js ---/);
  assert.match(g.text, /renderWidgetStore/);
});

test('grep hits on task identifiers, path:line format', () => {
  const dir = makeRepo({
    'src/a.js': 'const HANDLER_TIMEOUT_MS = 5000;\n',
    'src/b.js': 'if (HANDLER_TIMEOUT_MS > 0) {}\n',
  });
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  const g = buildPlanGrounding(adhoc('Make HANDLER_TIMEOUT_MS configurable'), { repoRoot: dir });
  assert.ok(g);
  assert.match(g.text, /GREP HITS/);
  assert.match(g.text, /src\/a\.js:1: const HANDLER_TIMEOUT_MS/);
});

test('grep hits for a file already shown as an anchor are dropped', () => {
  const dir = makeRepo({ 'src/widget-store.js': 'const WIDGET_LIMIT = 3;\nfunction renderWidgetStore() {}\n' });
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  const g = buildPlanGrounding(adhoc('Raise WIDGET_LIMIT in src/widget-store.js and touch renderWidgetStore'), { repoRoot: dir });
  assert.ok(g);
  // widget-store.js is an anchor; its grep hits must not also appear in the GREP HITS section
  const grepSection = g.text.split('GREP HITS')[1] || '';
  assert.doesNotMatch(grepSection, /widget-store\.js/);
});

test('total text hard-capped at PLAN_GROUNDING_MAX_CHARS', () => {
  const big = 'const BIG_IDENTIFIER_TOKEN = 1;\n' + 'x'.repeat(50000);
  const dir = makeRepo({ 'src/huge.js': big });
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  const g = buildPlanGrounding(adhoc('edit BIG_IDENTIFIER_TOKEN in src/huge.js'), { repoRoot: dir });
  assert.ok(g);
  assert.ok(g.text.length <= PLAN_GROUNDING_MAX_CHARS + 40, `text was ${g.text.length}`);
});

test('groundingCovers: true when every named path + identifier is represented', () => {
  const dir = makeRepo({ 'src/store.js': 'function updateStoreCache() {}\n' });
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  const t = adhoc('Fix updateStoreCache in src/store.js');
  const g = buildPlanGrounding(t, { repoRoot: dir });
  assert.equal(groundingCovers(t, g), true);
});

test('groundingCovers: false for an architectural task with no identifiers/files', () => {
  const dir = makeRepo({ 'src/store.js': 'x\n' });
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  const t = adhoc('Improve the overall performance of the dashboard');
  const g = buildPlanGrounding(t, { repoRoot: dir });
  assert.equal(groundingCovers(t, g), false);
});

test('groundingCovers: false when a named identifier has no hit anywhere', () => {
  const dir = makeRepo({ 'src/store.js': 'function present_helper_fn() {}\n' });
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  const t = adhoc('Wire present_helper_fn to the missing_other_helper it should call');
  const g = buildPlanGrounding(t, { repoRoot: dir });
  // missing_other_helper is nowhere -> not covered
  assert.equal(groundingCovers(t, g), false);
});

// --- multi-repo (2026-09-04): also grep a loaded plugin's own repo -----------------------

function withPluginManifest(pluginRegisterPath, fn) {
  const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-grounding-manifest-'));
  const manifestPath = path.join(manifestDir, 'plugins.json');
  fs.writeFileSync(manifestPath, JSON.stringify([{ name: 'plugin', registerPath: pluginRegisterPath, enabled: true }]));
  const prev = process.env.AGENT_MANAGER_PLUGINS_MANIFEST;
  process.env.AGENT_MANAGER_PLUGINS_MANIFEST = manifestPath;
  delete require.cache[require.resolve('./plugins-manifest.js')];
  delete require.cache[require.resolve('./accessible-roots.js')];
  delete require.cache[require.resolve('./plan-grounding.js')];
  try {
    return fn(require('./plan-grounding.js'));
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_PLUGINS_MANIFEST; else process.env.AGENT_MANAGER_PLUGINS_MANIFEST = prev;
    delete require.cache[require.resolve('./plugins-manifest.js')];
    delete require.cache[require.resolve('./accessible-roots.js')];
    delete require.cache[require.resolve('./plan-grounding.js')];
  }
}

test('buildPlanGrounding surfaces a hit from a loaded plugin repo, tagged with its name', () => {
  const primary = makeRepo({ 'src/a.js': 'const unrelated = 1;\n' });
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-grounding-plugin-'));
  fs.mkdirSync(path.join(plugin, 'src'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'src', 'function-length-review.js'), 'function registerFunctionLengthFix() {}\n');

  withPluginManifest(path.join(plugin, 'register.js'), ({ buildPlanGrounding: bpg }) => {
    const g = bpg(adhoc('fix registerFunctionLengthFix so it stops recursively splitting'), { repoRoot: primary });
    assert.ok(g, 'expected real grounding to be produced');
    const pluginTag = path.basename(fs.realpathSync(plugin));
    assert.match(g.text, new RegExp(`\\[${pluginTag}\\] src/function-length-review\\.js`));
    assert.ok(g.grepHits.some((h) => h.root && h.file === 'src/function-length-review.js'));
  });
});

test('buildPlanGrounding: zero plugins loaded is unaffected (no manifest -> primary repo only)', () => {
  const primary = makeRepo({ 'src/a.js': 'function widgetHelper() {}\n' });
  const g = buildPlanGrounding(adhoc('fix widgetHelper'), { repoRoot: primary });
  assert.ok(g);
  assert.doesNotMatch(g.text, /^\[/m, 'no repo tag should appear when nothing but the primary repo was searched');
});
