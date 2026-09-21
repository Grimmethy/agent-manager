'use strict';

// The draft sandbox's toolchain (2026-09-20, PF HUB0005-01): a private copy of node_modules in the worktree, and a deterministic strip of
// plan-derived criteria that need a toolchain the sandbox does not have. Real git + real cp.
//
// Run: node --test src/lib/draft-sandbox.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { planNodeModules, sandboxHasToolchain, copyNodeModules, dropToolchainCriteria, filterCriteriaForSandbox } = require('./draft-sandbox.js');
const { prepareAdhocWorktree, cleanupAdhocWorktree } = require('../agentic-draft-common.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A JS project: origin + clone, package.json, .gitignore listing node_modules, and (optionally) an installed node_modules with a .bin symlink.
function makeProject({ installed = true, ignored = true, pkg = true } = {}) {
  const bare = tmp('sbx-origin-'); const repo = tmp('sbx-repo-');
  git(['init', '--bare', '-b', 'main', bare]); git(['clone', bare, repo]);
  git(['config', 'user.email', 't@example.com'], repo); git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  if (pkg) fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"p"}\n');
  if (ignored) fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(['add', '.'], repo); git(['commit', '-m', 'init'], repo); git(['push', 'origin', 'main'], repo);
  if (installed) {
    const nm = path.join(repo, 'node_modules');
    fs.mkdirSync(path.join(nm, 'typescript', 'bin'), { recursive: true }); fs.mkdirSync(path.join(nm, '.bin'));
    fs.writeFileSync(path.join(nm, 'typescript', 'bin', 'tsc'), '#!/bin/sh\necho tsc-ok\n', { mode: 0o755 });
    fs.symlinkSync('../typescript/bin/tsc', path.join(nm, '.bin', 'tsc'));
  }
  return repo;
}

test('planNodeModules: copy / no-project / disabled / absent / too-large', () => {
  assert.equal(planNodeModules(makeProject()).mode, 'copy');
  assert.equal(planNodeModules(makeProject({ pkg: false })).mode, 'no-project');
  assert.equal(planNodeModules(makeProject({ installed: false })).mode, 'absent');
  assert.equal(planNodeModules(makeProject(), { AGENT_MANAGER_DRAFT_NODE_MODULES: 'false' }).mode, 'disabled');
  assert.equal(planNodeModules(makeProject(), { AGENT_MANAGER_DRAFT_NODE_MODULES_MAX_MB: 'nonsense' }).mode, 'copy', 'a bad cap value falls back to the default');
});

test('planNodeModules: a node_modules over the cap is too-large', () => {
  const repo = makeProject();
  fs.writeFileSync(path.join(repo, 'node_modules', 'blob.bin'), Buffer.alloc(3 * 1024 * 1024));
  const r = planNodeModules(repo, { AGENT_MANAGER_DRAFT_NODE_MODULES_MAX_MB: '1' });
  assert.equal(r.mode, 'too-large');
  assert.ok(r.sizeMb >= 3);
  assert.equal(sandboxHasToolchain(repo, { AGENT_MANAGER_DRAFT_NODE_MODULES_MAX_MB: '1' }), false);
  assert.equal(sandboxHasToolchain(repo), true);
});

test('a real worktree gets a PRIVATE COPY: tsc runs there, .bin symlinks survive, git stays clean, and changes never reach the shared checkout', () => {
  const repo = makeProject();
  const wt = path.join(tmp('sbx-wt-parent-'), 'wt');
  const prep = prepareAdhocWorktree(repo, 'main', wt, 'throwaway/adhoc-sbx');
  assert.equal(prep.ok, true);
  assert.equal(prep.nodeModules.copied, true);
  assert.equal(execFileSync(path.join(wt, 'node_modules', '.bin', 'tsc'), { encoding: 'utf8' }).trim(), 'tsc-ok', 'the tool runs through the copied .bin symlink');
  assert.ok(fs.lstatSync(path.join(wt, 'node_modules', '.bin', 'tsc')).isSymbolicLink());
  assert.equal(git(['status', '--porcelain'], wt).trim(), '', 'node_modules is ignored, so the draft diff is unaffected');
  // Isolation: an `npm install`-style change inside the sandbox must not write through.
  fs.writeFileSync(path.join(wt, 'node_modules', 'typescript', 'bin', 'tsc'), 'CLOBBERED');
  fs.rmSync(path.join(wt, 'node_modules', 'typescript'), { recursive: true, force: true });
  assert.equal(fs.readFileSync(path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), 'utf8'), '#!/bin/sh\necho tsc-ok\n', 'the shared copy is untouched');
  cleanupAdhocWorktree(repo, wt, 'throwaway/adhoc-sbx');
  assert.equal(fs.existsSync(wt), false, 'cleanup removes the worktree, copy included');
  assert.equal(fs.existsSync(path.join(repo, 'node_modules', '.bin', 'tsc')), true, 'and never the shared node_modules');
});

test('no copy (and the worktree still succeeds) when node_modules is absent, too large, switched off, or not gitignored', () => {
  const cases = [
    [makeProject({ installed: false }), {}, /no installed node_modules/],
    [makeProject(), { AGENT_MANAGER_DRAFT_NODE_MODULES: 'false' }, /AGENT_MANAGER_DRAFT_NODE_MODULES=false/],
    [makeProject({ ignored: false }), {}, /not gitignored/],
  ];
  for (const [repo, env, why] of cases) {
    const wt = path.join(tmp('sbx-wt-parent-'), 'wt');
    const r = copyNodeModules(repo, (git(['worktree', 'add', wt, '-b', 'b' + Math.random().toString(36).slice(2), 'origin/main'], repo), wt), { env });
    assert.equal(r.copied, false);
    assert.match(r.reason, why);
    assert.equal(fs.existsSync(path.join(wt, 'node_modules')), false);
  }
});

test('a failed copy leaves NO half-installed node_modules behind and never throws', () => {
  const repo = makeProject();
  const wt = path.join(tmp('sbx-wt-parent-'), 'wt');
  git(['worktree', 'add', wt, '-b', 'sbx-fail', 'origin/main'], repo);
  const run = (cmd, args, opts) => {
    if (cmd === 'cp') { fs.mkdirSync(path.join(wt, 'node_modules')); fs.writeFileSync(path.join(wt, 'node_modules', 'partial'), 'x'); throw new Error('no space left on device'); }
    return execFileSync(cmd, args, opts);
  };
  const r = copyNodeModules(repo, wt, { run });
  assert.equal(r.copied, false);
  assert.match(r.reason, /copy failed: no space left/);
  assert.equal(fs.existsSync(path.join(wt, 'node_modules')), false);
});

test('dropToolchainCriteria drops criteria that need to RUN the JS toolchain and keeps the rest', () => {
  const { criteria, dropped } = dropToolchainCriteria([
    '`src/lib/tileGrid.ts` contains exactly one `export function latLngToPx` -- `grep -c` returns 1.',
    '`npx tsc --noEmit` (or the project\'s equivalent type-check command) completes with zero errors.',
    'The build passes: `npm run build` exits 0.',
    'Type-checking the changed file reports no errors.',
    'vitest run src/lib/tileGrid.test.ts passes.',
    '`git diff --name-only` shows only src/lib/tileGrid.ts.',
    'The function is named latLngToPx and returns { px, py }.',
  ]);
  assert.equal(criteria.length, 3);
  assert.equal(dropped.length, 4);
  assert.ok(criteria.every((c) => !/tsc|npm|vitest|Type-check/i.test(c)));
});

test('filterCriteriaForSandbox: only plan-derived criteria, only for a JS project whose sandbox has NO toolchain', () => {
  const tsc = ['`npx tsc --noEmit` reports zero errors.', 'grep -c foo returns 1.'];
  const noDeps = makeProject({ installed: false });
  const withDeps = makeProject();
  const drop = filterCriteriaForSandbox({ criteria: tsc, source: 'plan-derived', repoRoot: noDeps });
  assert.deepEqual(drop.criteria, ['grep -c foo returns 1.']);
  assert.equal(drop.dropped.length, 1);
  assert.equal(filterCriteriaForSandbox({ criteria: tsc, source: 'plan-derived', repoRoot: withDeps }).dropped.length, 0, 'the sandbox CAN run it, so it stays');
  assert.equal(filterCriteriaForSandbox({ criteria: tsc, source: 'promptContext', repoRoot: noDeps }).dropped.length, 0, 'a criterion the task author wrote is never silently dropped');
  assert.equal(filterCriteriaForSandbox({ criteria: tsc, source: 'plan-derived', repoRoot: makeProject({ pkg: false, installed: false }) }).dropped.length, 0, 'not a JS project');
  assert.equal(filterCriteriaForSandbox({ criteria: tsc, source: 'plan-derived', repoRoot: noDeps, env: { AGENT_MANAGER_DRAFT_NODE_MODULES: 'false' } }).dropped.length, 0, 'switched off');
  assert.deepEqual(filterCriteriaForSandbox({ criteria: [], source: 'plan-derived', repoRoot: noDeps }), { criteria: [], dropped: [] });
});

test('a repo whose node_modules is itself a symlink still gets a real, private copy', () => {
  const repo = makeProject({ installed: false });
  const realTree = tmp('sbx-real-nm-');
  fs.mkdirSync(path.join(realTree, 'pkg')); fs.writeFileSync(path.join(realTree, 'pkg', 'index.js'), 'orig');
  fs.symlinkSync(realTree, path.join(repo, 'node_modules'));
  const wt = path.join(tmp('sbx-wt-parent-'), 'wt');
  git(['worktree', 'add', wt, '-b', 'sbx-link', 'origin/main'], repo);
  fs.writeFileSync(path.join(realTree, 'pkg', 'blob.bin'), Buffer.alloc(3 * 1024 * 1024));
  assert.equal(planNodeModules(repo, { AGENT_MANAGER_DRAFT_NODE_MODULES_MAX_MB: '1' }).mode, 'too-large', 'the size cap measures the real tree, not the link');
  assert.equal(copyNodeModules(repo, wt).copied, true);
  assert.equal(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), false, 'a real directory, not a link into the shared tree');
  fs.writeFileSync(path.join(wt, 'node_modules', 'pkg', 'index.js'), 'changed');
  assert.equal(fs.readFileSync(path.join(realTree, 'pkg', 'index.js'), 'utf8'), 'orig');
});

// STDOUT is local-draft.js's machine channel: one JSON result line the worker JSON.parses. #420 logged here with console.log, so every draft that copied
// node_modules read as "draft call failed" (2026-09-20: 58 wasted drafts, 4 tasks to needs-clarification).
test('prepareAdhocWorktree writes NOTHING to stdout, for a copy and for the "no node_modules" note alike; the note goes to stderr', () => {
  for (const installed of [true, false]) {
    const repo = makeProject({ installed });
    const wt = path.join(tmp('sbx-wt-parent-'), 'wt');
    const out = []; const err = [];
    const origWrite = process.stdout.write; const origErr = console.error;
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    console.error = (...a) => { err.push(a.join(' ')); };
    let prep;
    try { prep = prepareAdhocWorktree(repo, 'main', wt, `throwaway/adhoc-stdout-${installed}`); }
    finally { process.stdout.write = origWrite; console.error = origErr; }
    assert.equal(prep.ok, true);
    assert.equal(out.join(''), '', `installed=${installed}: nothing may reach stdout`);
    assert.match(err.join('\n'), /\[draft-sandbox\]/, `installed=${installed}: the note is on stderr`);
    cleanupAdhocWorktree(repo, wt, `throwaway/adhoc-stdout-${installed}`);
  }
});
