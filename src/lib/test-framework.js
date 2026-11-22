'use strict';

// test-framework.js -- does a NEW test file use a test framework its package can actually run?
//
// 2026-10-08 (TaxHarvest): three drafts created tests for a framework the project does not have -- PageErrorBoundary.test.tsx (jest + @testing-library/react),
// propertyType.test.js (jest) and Toast.test.tsx (@testing-library). The backend's 6 tests are all node:test, its Python tests are unittest/plain scripts,
// and the FRONTEND has no test runner at all (no jest/vitest/testing-library in any package.json, `build` is plain `vite build`). Each of those test files
// is dead code that can never run, and each was caught late, by hand, on a branch whose real change was fine. Nothing in the pipeline knew which
// framework a package uses, and the prompts never said, so the model fell back on jest habits. Replayed over agent-manager's own 75 created tests
// (59 node:test, 14 unittest, 1 pytest) the rule below flags none of the node:test or unittest ones.
//
// The rule (deterministic, no model): a created test file's framework must be AVAILABLE to its package --
//   * node:test     available for .js/.mjs/.cjs (built in); NOT for .ts/.tsx/.jsx, which node cannot run without a declared transpiler/runner;
//   * jest / vitest / testing-library / describe-it globals   available only if declared in a package.json from the file's directory up to the repo
//                     root (dependencies, devDependencies, scripts.test) OR already used by an existing test file in that package OR added by the SAME change;
//   * unittest      always; pytest only if declared (requirements/pyproject/setup.cfg) or already imported by an existing test.
// A package with NO runner and NO tests (the frontend) says so plainly instead of suggesting a framework.
//
// Also builds the one-line "test conventions" block the implement prompts carry, from the same facts. Never throws: any read failure means "available".

const fs = require('fs');
const path = require('path');

const MAX_SCAN_FILES = 60;
const SKIP_DIRS = new Set(['node_modules', 'graphify-out', 'dist', 'build', 'coverage', '__pycache__', 'venv', '.venv']);
const JS_RUNNABLE = /\.(?:[cm]?js)$/i;
const TEST_PATH_RE = /(?:\.test\.|\.spec\.)[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.py$/i;

const isTestPath = (f) => TEST_PATH_RE.test(String(f || '').replace(/\\/g, '/'));

// ---- detection --------------------------------------------------------------------------------------------------------------------------------

function detectFramework(file, text) {
  const t = String(text || '');
  if (/\.py$/i.test(file)) {
    if (/^\s*(?:import|from)\s+pytest\b|@pytest\./m.test(t)) return 'pytest';
    if (/^\s*(?:import|from)\s+unittest\b/m.test(t)) return 'unittest';
    return 'other';
  }
  if (/require\(['"]node:test['"]\)|from ['"]node:test['"]/.test(t)) return 'node:test';
  if (/@testing-library\//.test(t)) return 'testing-library';
  if (/from ['"]vitest['"]|require\(['"]vitest['"]\)/.test(t)) return 'vitest';
  if (/\bjest\.(?:fn|spyOn|mock|resetModules|useFakeTimers|requireActual|restoreAllMocks|clearAllMocks)\b/.test(t)) return 'jest';
  if (/^\s*(?:describe|it|test)\s*\(/m.test(t)) return 'globals';
  return 'other';
}

// ---- what a package declares / uses ----------------------------------------------------------------------------------------------------------

const RUNNER_PATTERNS = [
  ['jest', /^(?:jest|ts-jest|babel-jest|@jest\/.+|jest-.+)$/],
  ['vitest', /^vitest$/],
  ['mocha', /^mocha$/],
  ['jasmine', /^jasmine(?:-core)?$/],
  ['ava', /^ava$/],
  ['testing-library', /^@testing-library\//],
  ['tsx', /^(?:tsx|ts-node)$/],
];

function declaredFromPackageJson(pkg) {
  const out = new Set();
  const names = [...Object.keys((pkg && pkg.dependencies) || {}), ...Object.keys((pkg && pkg.devDependencies) || {}), ...Object.keys((pkg && pkg.peerDependencies) || {})];
  for (const n of names) for (const [key, re] of RUNNER_PATTERNS) if (re.test(n)) out.add(key);
  const script = String((pkg && pkg.scripts && pkg.scripts.test) || '');
  for (const key of ['jest', 'vitest', 'mocha', 'jasmine', 'ava']) if (new RegExp(`\\b${key}\\b`).test(script)) out.add(key);
  return out;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// Directories from the file's own directory up to (and including) repoRoot.
function ancestorDirs(repoRoot, file) {
  const root = path.resolve(repoRoot);
  let dir = path.dirname(path.resolve(root, file));
  const out = [];
  for (let i = 0; i < 20; i++) {
    if (!dir.startsWith(root)) break;
    out.push(dir);
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return out;
}

// The nearest ancestor with a package.json (the package a JS/TS file belongs to), or null.
function packageDirFor(repoRoot, file) {
  for (const d of ancestorDirs(repoRoot, file)) if (fs.existsSync(path.join(d, 'package.json'))) return d;
  return null;
}

function declaredFrameworks(repoRoot, file) {
  const out = new Set();
  for (const d of ancestorDirs(repoRoot, file)) {
    const pkg = readJson(path.join(d, 'package.json'));
    if (pkg) for (const k of declaredFromPackageJson(pkg)) out.add(k);
  }
  return out;
}

function pythonDeclaresPytest(repoRoot, file) {
  for (const d of ancestorDirs(repoRoot, file)) {
    for (const f of ['requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt', 'pyproject.toml', 'setup.cfg', 'tox.ini']) {
      try { if (/\bpytest\b/i.test(fs.readFileSync(path.join(d, f), 'utf8'))) return true; } catch { /* absent */ }
    }
  }
  return false;
}

// Existing test files under `dir` (same language family as `ext`), skipping generated/vendor dirs, bounded.
function existingTests(dir, ext, exclude) {
  const out = [];
  const py = ext === 'py';
  const walk = (d, depth) => {
    if (out.length >= MAX_SCAN_FILES || depth > 8) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= MAX_SCAN_FILES) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (isTestPath(e.name) && (py ? e.name.endsWith('.py') : !e.name.endsWith('.py')) && !(exclude && exclude.has(path.resolve(full)))) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

// Map framework -> [example files] for the existing tests of a package.
function usedFrameworks(repoRoot, file, exclude) {
  const py = /\.py$/i.test(file);
  const dir = py ? path.dirname(path.resolve(repoRoot, file)) : (packageDirFor(repoRoot, file) || path.resolve(repoRoot));
  const root = py ? findPythonRoot(repoRoot, file) : dir;
  const used = new Map();
  for (const f of existingTests(root, py ? 'py' : 'js', exclude)) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const fw = detectFramework(f, text);
    if (fw === 'other') continue;
    if (!used.has(fw)) used.set(fw, []);
    if (used.get(fw).length < 3) used.get(fw).push(path.relative(path.resolve(repoRoot), f).replace(/\\/g, '/'));
  }
  return used;
}

// Python tests live next to their service dir; scan the file's directory and its parent (not the whole repo).
function findPythonRoot(repoRoot, file) {
  const dir = path.dirname(path.resolve(repoRoot, file));
  const parent = path.dirname(dir);
  return path.resolve(repoRoot).length < parent.length && path.basename(dir) === 'tests' ? parent : dir;
}

// ---- availability -------------------------------------------------------------------------------------------------------------------------------

// -> { ok, framework, reason, available: [names], examples: [paths], noRunner }
function frameworkAvailability(repoRoot, file, framework, { addedDeps = new Set(), exclude } = {}) {
  try {
    const py = /\.py$/i.test(file);
    const ext = path.extname(file).toLowerCase();
    const declared = declaredFrameworks(repoRoot, file);
    for (const d of addedDeps) declared.add(d);
    const used = usedFrameworks(repoRoot, file, exclude);
    const usedKeys = [...used.keys()];
    const examplesFor = (names) => names.flatMap((n) => used.get(n) || []).slice(0, 3);
    const jsRunnable = JS_RUNNABLE.test(ext);
    const hasNonNodeRunner = ['jest', 'vitest', 'mocha', 'jasmine', 'ava'].some((k) => declared.has(k) || used.has(k));
    const res = (ok, reason, over = {}) => ({ ok, framework, reason, available: [], examples: [], noRunner: false, ...over });

    if (framework === 'other') return res(true, 'framework not recognised');
    if (py) {
      if (framework === 'unittest') return res(true, 'unittest is always available');
      if (framework === 'pytest') {
        const ok = pythonDeclaresPytest(repoRoot, file) || used.has('pytest') || declared.has('pytest');
        return ok ? res(true, 'pytest is declared or used') : res(false, 'pytest is not declared in any requirements/pyproject here and no existing test imports it', { available: ['unittest'], examples: examplesFor(['unittest']) });
      }
      return res(true, 'python framework not checked');
    }

    // JS / TS
    const available = [];
    if (jsRunnable) available.push('node:test');
    for (const k of ['jest', 'vitest', 'mocha', 'jasmine', 'ava', 'testing-library']) if (declared.has(k) || used.has(k)) available.push(k);
    const anyJsTestsHere = usedKeys.length > 0;
    const noRunner = !jsRunnable && !hasNonNodeRunner && !declared.has('tsx') && !anyJsTestsHere;

    if (framework === 'node:test') {
      if (jsRunnable) return res(true, 'node:test is built in for .js/.mjs/.cjs');
      if (declared.has('tsx') || hasNonNodeRunner) return res(true, 'a TypeScript-capable runner is declared');
      return res(false, `node:test cannot run a ${ext} file (node does not execute TypeScript or JSX) and this package declares no runner`, { available, examples: examplesFor(usedKeys), noRunner });
    }
    if (framework === 'globals') {
      if (hasNonNodeRunner) return res(true, 'a describe/it runner is declared or used');
      return res(false, 'describe()/it() globals need jest, vitest or mocha, and none is declared or used in this package', { available, examples: examplesFor(usedKeys), noRunner });
    }
    if (declared.has(framework) || used.has(framework)) return res(true, `${framework} is declared or used`);
    return res(false, `${framework} is not installed (not in any package.json from this file up to the repo root) and no existing test uses it`, { available, examples: examplesFor(usedKeys), noRunner });
  } catch (e) {
    return { ok: true, framework, reason: `check skipped: ${e.message}`, available: [], examples: [], noRunner: false };
  }
}

// ---- checking a change -------------------------------------------------------------------------------------------------------------------------

// Runner names a piece of package.json text adds (dependencies written by the change itself).
const ADDED_DEP_RES = [
  ['jest', /["'](?:jest|ts-jest|babel-jest|@jest\/[^"']+|jest-[^"']+)["']/],
  ['vitest', /["']vitest["']/],
  ['mocha', /["']mocha["']/],
  ['jasmine', /["']jasmine(?:-core)?["']/],
  ['ava', /["']ava["']/],
  ['testing-library', /["']@testing-library\/[^"']+["']/],
  ['tsx', /["'](?:tsx|ts-node)["']/],
];
function depsAddedIn(text) {
  const out = new Set();
  for (const [key, re] of ADDED_DEP_RES) if (re.test(String(text || ''))) out.add(key);
  return out;
}

// files: [{ path, content }] test files the change CREATES; packageText: concatenated text the change writes into package.json files.
function checkNewTestFiles({ repoRoot, files, packageText = '' }) {
  const flags = [];
  const addedDeps = depsAddedIn(packageText);
  const exclude = new Set((files || []).map((f) => path.resolve(repoRoot, f.path)));
  for (const f of files || []) {
    if (!isTestPath(f.path)) continue;
    const fw = detectFramework(f.path, f.content);
    const a = frameworkAvailability(repoRoot, f.path, fw, { addedDeps, exclude });
    if (a.ok) continue;
    flags.push({ type: 'test-framework-unavailable', file: f.path, framework: fw, reason: a.reason, available: a.available, examples: a.examples, noRunner: a.noRunner });
  }
  return flags;
}

// The Group B change set (JSON): created test files with content, and what it writes into package.json files.
function inspectChangeSet(items) {
  const files = [];
  let packageText = '';
  for (const i of Array.isArray(items) ? items : []) {
    if (!i || typeof i.file !== 'string') continue;
    if (i.mode === 'create' && typeof i.content === 'string') {
      if (isTestPath(i.file)) files.push({ path: i.file, content: i.content });
      if (/(^|\/)package\.json$/.test(i.file)) packageText += `\n${i.content}`;
    } else if (i.mode === 'edit' && /(^|\/)package\.json$/.test(i.file)) packageText += `\n${i.replace || ''}`;
  }
  return { files, packageText };
}

// A unified diff: created test files with their added text, and the added lines of any package.json.
function inspectDiff(diff) {
  const files = [];
  let packageText = '';
  for (const chunk of String(diff || '').split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/\S+ b\/(\S+)/.exec(chunk);
    if (!m) continue;
    const added = chunk.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
    if (/^new file mode/m.test(chunk) && isTestPath(m[1])) files.push({ path: m[1], content: added });
    if (/(^|\/)package\.json$/.test(m[1])) packageText += `\n${added}`;
  }
  return { files, packageText };
}

function feedbackFor(flags) {
  return flags.map((f) => {
    const have = f.available.length ? `This package can run: ${f.available.join(', ')}.` : 'This package has no test runner configured.';
    const ex = f.examples.length ? ` Follow an existing test, e.g. ${f.examples.join(' or ')}.` : '';
    const plain = f.noRunner
      ? ' There is no test runner (and no existing test) here, so a test for this file could never run: do NOT create it; say in your summary that the change is untested and why, or propose adding a runner as its own separate change.'
      : '';
    return `\`${f.file}\` is written for ${f.framework}, which is not usable here: ${f.reason}. ${have}${ex}${plain}`;
  }).join(' ');
}

function gateMode(env = process.env) {
  const v = String(env.AGENT_MANAGER_TEST_FRAMEWORK_GATE || '').trim().toLowerCase();
  return v === 'advisory' || v === 'off' ? v : 'block';
}

// ---- the prompt line -----------------------------------------------------------------------------------------------------------------------------

const TESTISH_RE = /\btests?\b|\.test\.|\.spec\.|\bspec\b|unit test|\bassert/i;
const cache = new Map();

function conventionsFor(repoRoot, file) {
  const py = /\.py$/i.test(file);
  const pkgDir = py ? path.dirname(path.resolve(repoRoot, file)) : (packageDirFor(repoRoot, file) || path.resolve(repoRoot));
  const key = `${repoRoot}|${pkgDir}|${py}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const rel = path.relative(repoRoot, pkgDir);
  const probe = path.join(rel, py ? 'test_x.py' : 'x.test.tsx');
  const used = usedFrameworks(repoRoot, path.join(rel, py ? 'test_x.py' : 'x.test.js'));
  const declared = declaredFrameworks(repoRoot, path.join(rel, 'x.js'));
  const tsOk = py ? null : frameworkAvailability(repoRoot, probe, 'node:test').ok;
  const value = {
    dir: rel.replace(/\\/g, '/') || '.', py, tsOk, hasTests: used.size > 0,
    used: [...used.entries()],
    missing: py ? [] : ['jest', 'vitest', 'testing-library'].filter((k) => !declared.has(k) && !used.has(k)),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

// One grounded block for the prompt, or '' when the task has nothing to do with tests or no package can be determined.
function testConventionsBlock(repoRoot, task, targetFiles) {
  try {
    const text = `${(task && task.title) || ''}\n${(task && task.promptContext && task.promptContext.rawText) || ''}\n${(task && task.planResponse) || ''}`;
    if (!TESTISH_RE.test(text)) return '';
    const pkgs = new Map();
    for (const f of targetFiles || []) {
      if (!f || typeof f !== 'string' || /^\.\.|^\//.test(f)) continue;
      const c = conventionsFor(repoRoot, f);
      if (!pkgs.has(c.dir + c.py)) pkgs.set(c.dir + c.py, c);
    }
    if (!pkgs.size) return '';
    const lines = [];
    for (const c of pkgs.values()) {
      const fw = c.used.map(([k, ex]) => `${k} (e.g. ${ex[0]})`);
      const notInstalled = c.missing.length ? ` ${c.missing.map((k) => (k === 'testing-library' ? '@testing-library' : k)).join(', ')} ${c.missing.length === 1 ? 'is' : 'are'} NOT installed.` : '';
      if (c.py) lines.push(`- \`${c.dir}\` (Python): tests use ${fw.length ? fw.join(', ') : 'unittest'}; do not introduce pytest unless it is already declared.`);
      else if (c.hasTests) lines.push(`- \`${c.dir}\`: tests use ${fw.join(', ')}.${notInstalled}${c.tsOk ? '' : ' TypeScript/React (.ts/.tsx) tests cannot run here.'}`);
      else lines.push(`- \`${c.dir}\`: NO test suite or runner exists here. A plain .js test may use node:test; TypeScript/React (.ts/.tsx) tests cannot run, so do not create them -- say in your summary that the change is untested.${notInstalled}`);
    }
    return ['TEST CONVENTIONS (read from this repository, not assumed -- a test written for a framework the package does not have can never run and will be rejected):', ...lines].join('\n');
  } catch { return ''; }
}

function clearCache() { cache.clear(); }

module.exports = {
  detectFramework, frameworkAvailability, checkNewTestFiles, inspectChangeSet, inspectDiff, feedbackFor, gateMode, testConventionsBlock,
  isTestPath, declaredFromPackageJson, packageDirFor, depsAddedIn, clearCache,
};
