'use strict';

// Test harnesses for branch-check-runner.js: which of a project's own tests cover what a branch changed, and the command that runs them.
//
// A harness is { id, detect(worktreeDir, fs, { repoRoot, changedFiles }) -> boolean, plan({ worktreeDir, changedFiles, maxTestFiles, grep, repoRoot })
// -> { commands: [{ what, file, args, cwd, env? }], notRun: string[] } }. The runner uses the first harness whose detect says yes and runs its commands in
// a scratch worktree of the branch.
//
// Harnesses are recognised by marker files in the checkout, never by the repository's name, and only when the branch changed files the harness knows how to
// test (a Python-only branch in a repository that also has a package.json must not be told "no test covers this" by the JavaScript harness). Changed code files
// a chosen harness does not run tests for are named in notRun, so a partial check cannot read as a complete one.

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__']);
const CODE_EXT = /\.(?:js|cjs|mjs|ts|tsx|py|sh|html|css)$/;
const JS_FILE = /\.(?:js|cjs|mjs)$/;
const JS_TEST_FILE = /\.test\.(?:js|cjs|mjs)$/;
const PY_FILE = /\.py$/;
const PY_TEST_FILE = /(?:^|\/)test_[^/]*\.py$/;
const SMALL_SUITE_FILES = 40;

const isDir = (fsl, p) => { try { return fsl.statSync(p).isDirectory(); } catch (_) { return false; } };
const isFile = (fsl, p) => { try { return fsl.statSync(p).isFile(); } catch (_) { return false; } };

// Relative paths (with /) of the files under root, at most maxDepth directories deep, that satisfy predicate.
function walk(fsl, root, maxDepth, predicate) {
  const out = [];
  const visit = (rel, depth) => {
    let entries = [];
    try { entries = fsl.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < maxDepth && !SKIP_DIRS.has(e.name)) visit(next, depth + 1); } else if (predicate(next)) out.push(next);
    }
  };
  visit('', 0);
  return out;
}

// Changed code files this harness does not run tests for, as one notRun line (docs, data and config files are not code and are left out).
function uncoveredNote(changedFiles, covers) {
  const left = changedFiles.filter((f) => CODE_EXT.test(f) && !covers(f));
  return left.length ? [`changed files this harness does not run tests for: ${left.join(', ')}`] : [];
}

const stripExt = (file) => path.basename(file).replace(/\.[^.]+$/, '');

// ---- 1. tokenfold: a Python package with a script-style suite under core/ ----------------------------------------------------------------------------------
const tokenfoldCore = {
  id: 'tokenfold-core',
  detect(dir, fsl, ctx = {}) {
    return isFile(fsl, path.join(dir, 'core', 'tests', 'test_core.py')) && isDir(fsl, path.join(dir, 'core', 'tokenfold'))
      && (ctx.changedFiles || []).some((f) => /^core\/.*\.py$/.test(f));
  },
  async plan({ worktreeDir, changedFiles = [] }) {
    return {
      commands: [{ what: 'tokenfold core tests', file: 'python3', args: ['tests/test_core.py'], cwd: path.join(worktreeDir, 'core'), env: { PYTHONPATH: '.' } }],
      notRun: uncoveredNote(changedFiles, (f) => /^core\/.*\.py$/.test(f)),
    };
  },
};

// ---- 2. node --test: JavaScript projects --------------------------------------------------------------------------------------------------------------------
// The test files that cover a change: every changed test file, plus every test file that mentions the basename of a changed source file.
async function coveringTestFiles({ worktreeDir, changedFiles = [], grep, maxTestFiles = 12 }) {
  const exists = (f) => isFile(fs, path.join(worktreeDir, f));
  const tests = new Set(changedFiles.filter((f) => JS_TEST_FILE.test(f) && exists(f)));
  const search = typeof grep === 'function' ? grep : async () => [];
  const names = [...new Set(changedFiles.filter((f) => JS_FILE.test(f) && !JS_TEST_FILE.test(f) && exists(f)).map(stripExt))];
  for (const name of names) {
    for (const glob of ['*.test.js', '*.test.mjs', '*.test.cjs']) {
      for (const hit of await search(name, glob)) if (!hit.includes('node_modules/')) tests.add(hit);
    }
  }
  const all = [...tests].sort();
  const files = all.slice(0, maxTestFiles);
  const notRun = [];
  if (!all.length) notRun.push('no test file covers the changed files');
  else if (all.length > files.length) notRun.push(`${all.length - files.length} more covering test files not run: ${all.slice(maxTestFiles).join(', ')}`);
  return { files, notRun };
}

const nodeTest = {
  id: 'node-test',
  detect(dir, fsl, ctx = {}) {
    const marker = isFile(fsl, path.join(dir, 'package.json'))
      || ['src', 'test', 'tests', 'scripts'].some((d) => walk(fsl, path.join(dir, d), 3, (f) => JS_TEST_FILE.test(f)).length > 0);
    return marker && (ctx.changedFiles || []).some((f) => JS_FILE.test(f));
  },
  async plan({ worktreeDir, changedFiles = [], maxTestFiles = 12, grep, repoRoot }) {
    const { files, notRun } = await coveringTestFiles({ worktreeDir, changedFiles, grep, maxTestFiles });
    // A fresh worktree has no installed packages: borrow the project checkout's.
    const link = path.join(worktreeDir, 'node_modules');
    if (repoRoot && isDir(fs, path.join(repoRoot, 'node_modules')) && !fs.existsSync(link)) {
      try { fs.symlinkSync(path.join(repoRoot, 'node_modules'), link, 'dir'); } catch (_) { /* tests that need packages will say so */ }
    }
    const commands = files.length ? [{ what: `node tests (${files.length} covering file${files.length === 1 ? '' : 's'})`, file: 'node', args: ['--test', ...files], cwd: worktreeDir }] : [];
    return { commands, notRun: [...notRun, ...uncoveredNote(changedFiles, (f) => JS_FILE.test(f))] };
  },
};

// ---- 3. Python with the project's own virtualenv and flat test_*.py files -----------------------------------------------------------------------------------
const venvPython = (repoRoot) => path.join(repoRoot, '.venv', 'bin', 'python');
const flatTests = (fsl, dir) => walk(fsl, dir, 3, (f) => PY_TEST_FILE.test(f) && (!f.includes('/') || f.startsWith('python/')));

const pythonVenvFlat = {
  id: 'python-venv-flat',
  detect(dir, fsl, ctx = {}) {
    return !!ctx.repoRoot && isFile(fsl, venvPython(ctx.repoRoot)) && (ctx.changedFiles || []).some((f) => PY_FILE.test(f)) && flatTests(fsl, dir).length > 0;
  },
  async plan({ worktreeDir, changedFiles = [], maxTestFiles = 12, repoRoot, fsLike = fs }) {
    const py = venvPython(repoRoot);
    const allTests = flatTests(fsLike, worktreeDir).sort();
    const wanted = new Set(changedFiles.filter((f) => PY_TEST_FILE.test(f) && isFile(fsLike, path.join(worktreeDir, f))));
    for (const f of changedFiles.filter((x) => PY_FILE.test(x) && !PY_TEST_FILE.test(x))) {
      for (const t of allTests) if (path.basename(t) === `test_${stripExt(f)}.py`) wanted.add(t);
    }
    const notRun = uncoveredNote(changedFiles, (f) => PY_FILE.test(f));
    if (!wanted.size) {
      if (allTests.length > SMALL_SUITE_FILES) {
        return { commands: [], notRun: [`no test file covers the changed files, and the suite (${allTests.length} test files) is too large to run whole`, ...notRun] };
      }
      const where = path.dirname(allTests[0]);
      return {
        commands: [{ what: 'python tests (whole suite)', file: py, args: ['-m', 'unittest', 'discover', '-p', 'test_*.py'], cwd: path.join(worktreeDir, where) }],
        notRun: ['no test file is named for the changed files: ran the whole suite', ...notRun],
      };
    }
    const sorted = [...wanted].sort();
    const run = sorted.slice(0, maxTestFiles);
    if (sorted.length > run.length) notRun.unshift(`${sorted.length - run.length} more covering test files not run: ${sorted.slice(maxTestFiles).join(', ')}`);
    const byDir = new Map();
    for (const t of run) {
      const d = path.dirname(t);
      byDir.set(d, [...(byDir.get(d) || []), stripExt(t)]);
    }
    const commands = [...byDir].map(([d, modules]) => ({
      what: `python tests (${modules.length} covering module${modules.length === 1 ? '' : 's'} in ${d === '.' ? 'the repository root' : d})`,
      file: py, args: ['-m', 'unittest', ...modules], cwd: path.join(worktreeDir, d),
    }));
    return { commands, notRun };
  },
};

// ---- 4. Python with src/ and tests/ -------------------------------------------------------------------------------------------------------------------------
const pythonSrcTests = {
  id: 'python-src-tests',
  detect(dir, fsl, ctx = {}) {
    return isDir(fsl, path.join(dir, 'src')) && walk(fsl, path.join(dir, 'tests'), 1, (f) => /^test_[^/]*\.py$/.test(f)).length > 0
      && (ctx.changedFiles || []).some((f) => PY_FILE.test(f));
  },
  async plan({ worktreeDir, changedFiles = [] }) {
    return {
      commands: [{ what: 'python tests (unittest discover -s tests)', file: 'python3', args: ['-m', 'unittest', 'discover', '-s', 'tests'], cwd: worktreeDir, env: { PYTHONPATH: 'src' } }],
      notRun: uncoveredNote(changedFiles, (f) => PY_FILE.test(f)),
    };
  },
};

// Detection order matters: tokenfold has both a package and tests, so its more specific marker goes first.
const DEFAULT_HARNESSES = [tokenfoldCore, nodeTest, pythonVenvFlat, pythonSrcTests];

module.exports = { DEFAULT_HARNESSES, coveringTestFiles, HARNESSES: { tokenfoldCore, nodeTest, pythonVenvFlat, pythonSrcTests }, walk, SMALL_SUITE_FILES };
