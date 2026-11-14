'use strict';

// apply-target-hint.js: a failed adhoc apply names the other registered project the diff belongs to. Real git repos and a fixture projects registry; the end-to-end
// cases go through the real applyAdhocDiff. Run: node --test src/apply-target-hint.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { existingPathsInDiff, otherProjectForDiff, targetHintForFailure } = require('./apply-target-hint.js');
const { applyAdhocDiff } = require('./apply-adhoc-diff.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-hint-'));
  git(['init', '-q', '-b', 'main', dir]);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'T'], dir);
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'init'], dir);
  return dir;
}
function diffOf(repo, mutate) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-hint-scratch-'));
  git(['clone', '-q', repo, scratch]);
  git(['config', 'user.email', 't@example.com'], scratch);
  git(['config', 'user.name', 'T'], scratch);
  mutate(scratch);
  git(['add', '-A'], scratch);
  return git(['diff', '--cached'], scratch);
}
function world() {
  const core = makeRepo({ 'tracked.txt': 'v1\n' });
  const plugin = makeRepo({ 'content-pipeline/prompts.js': 'module.exports = 1;\n' });
  const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apply-hint-reg-')), 'projects.json');
  fs.writeFileSync(registry, JSON.stringify([
    { label: 'core-fixture', repoRoot: core, pipelineDir: path.join(core, 'pipe') },
    { label: 'wikiforge-fixture', repoRoot: plugin, pipelineDir: path.join(plugin, '..', 'wiki-pipe') },
  ]));
  const rawDiff = diffOf(plugin, (d) => fs.writeFileSync(path.join(d, 'content-pipeline/prompts.js'), 'module.exports = 2;\n'));
  return { core, plugin, registry, rawDiff };
}

test('existingPathsInDiff lists edited files once and leaves out files the diff creates', () => {
  const plugin = makeRepo({ 'a.js': '1\n', 'b.js': '1\n' });
  const raw = diffOf(plugin, (d) => { fs.writeFileSync(path.join(d, 'a.js'), '2\n'); fs.writeFileSync(path.join(d, 'new.js'), 'x\n'); });
  assert.deepEqual(existingPathsInDiff(raw), ['a.js']);
  assert.deepEqual(existingPathsInDiff(''), []);
});

test('otherProjectForDiff finds the one other project that holds the edited files', () => {
  const w = world();
  const p = otherProjectForDiff(w.rawDiff, w.core, { registryPath: w.registry });
  assert.equal(p.label, 'wikiforge-fixture');
  assert.equal(otherProjectForDiff(w.rawDiff, w.plugin, { registryPath: w.registry }), null, 'the plugin repo itself holds the files: no other project');
});

test('otherProjectForDiff says nothing when this repo has one of the files, when two projects match, or when the diff only creates files', () => {
  const w = world();
  const both = diffOf(w.core, (d) => fs.writeFileSync(path.join(d, 'tracked.txt'), 'v2\n'));
  assert.equal(otherProjectForDiff(both, w.core, { registryPath: w.registry }), null);
  const twin = makeRepo({ 'content-pipeline/prompts.js': 'module.exports = 1;\n' });
  const reg2 = path.join(path.dirname(w.registry), 'two.json');
  fs.writeFileSync(reg2, JSON.stringify([{ label: 'a', repoRoot: w.plugin }, { label: 'b', repoRoot: twin }]));
  assert.equal(otherProjectForDiff(w.rawDiff, w.core, { registryPath: reg2 }), null, 'ambiguous: do not guess');
  const created = diffOf(w.plugin, (d) => fs.writeFileSync(path.join(d, 'brand-new.js'), 'x\n'));
  assert.equal(otherProjectForDiff(created, w.core, { registryPath: w.registry }), null);
});

test('otherProjectForDiff stays quiet when this repo also has the file, even if another project has it too', () => {
  const core = makeRepo({ 'shared.txt': 'v1\n' });
  const other = makeRepo({ 'shared.txt': 'v1\n' });
  const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apply-hint-reg-')), 'projects.json');
  fs.writeFileSync(registry, JSON.stringify([{ label: 'core-fixture', repoRoot: core }, { label: 'other-fixture', repoRoot: other }]));
  const raw = diffOf(core, (d) => fs.writeFileSync(path.join(d, 'shared.txt'), 'v2\n'));
  assert.equal(otherProjectForDiff(raw, core, { registryPath: registry }), null, 'the diff fits THIS repo: a failure here is not a wrong-repo problem');
});

test('real applyAdhocDiff: a plugin-targeted record applied to the wrong repo fails with the hint and leaves the repo untouched', () => {
  const w = world();
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = w.registry;
  try {
    assert.throws(() => applyAdhocDiff({ task: { id: 'hint-1', domain: 'adhoc', rawDiff: w.rawDiff }, repoRoot: w.core, pipelineDir: os.tmpdir() }), (e) => {
      assert.match(e.message, /^git apply failed:/);
      assert.match(e.message, /No such file or directory/, 'the original git error is kept');
      assert.match(e.message, /HINT: .*project "wikiforge-fixture"/);
      assert.ok(e.message.includes(path.join(w.plugin, '..', 'wiki-pipe', 'queue', 'approved')), 'names the queue the record belongs in');
      return true;
    });
    assert.equal(git(['status', '--porcelain'], w.core), '');
  } finally {
    delete process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH;
  }
});

test('real applyAdhocDiff: the same record applied to its own project still works (the supported route), and an unrelated failure gets no hint', () => {
  const w = world();
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = w.registry;
  try {
    const ok = applyAdhocDiff({ task: { id: 'hint-2', domain: 'adhoc', rawDiff: w.rawDiff }, repoRoot: w.plugin, pipelineDir: os.tmpdir() });
    assert.deepEqual(ok.files, ['content-pipeline/prompts.js']);
    // the plugin file now says 2, so the same diff no longer applies there: a stale-context failure that must NOT be blamed on another project
    assert.throws(() => applyAdhocDiff({ task: { id: 'hint-3', domain: 'adhoc', rawDiff: w.rawDiff }, repoRoot: w.plugin, pipelineDir: os.tmpdir() }), (e) => {
      assert.match(e.message, /^git apply failed:/);
      assert.ok(!e.message.includes('HINT'), e.message);
      return true;
    });
  } finally {
    delete process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH;
  }
});

test('a missing or unreadable registry never hides the real error', () => {
  const w = world();
  assert.equal(targetHintForFailure(w.rawDiff, w.core, { registryPath: '/nonexistent/projects.json' }), '');
});
