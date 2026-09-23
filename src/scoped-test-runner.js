'use strict';

// Deterministic, scoped test-execution gate (2026-09-23, Grimmethy: "the review is adding
// 3-4 minutes to every single change we make -- that has to come down").
//
// This repo already has a real test suite (3,490 JS tests across 179 co-located
// *.test.js files, 442 Python tests) that NOTHING ever runs automatically -- no CI, no
// pre-merge hook, nothing. Confirmed live: change-review-86b45ff caught a diff that added
// a field to a return object but never updated its own test's exact-shape assertion --
// `node --test` would have failed instantly, deterministically, for free. The 3-4 minute
// LLM change_review call is reasoning ABOUT THE DIFF; it never actually runs anything, so
// it's neither faster nor more reliable than the test suite at catching "this diff breaks
// an existing test" -- it's strictly worse (slower, and only probabilistically likely to
// notice).
//
// Running the FULL suite as a gate is the wrong shape though -- measured live, 3,490 JS
// tests take 4m35s wall-clock, LONGER than the LLM call this exists to avoid. This module
// stays SCOPED: for a given set of changed files, it finds and runs only the test files
// that actually cover them (co-located <name>.test.js / test_<name>.py, the convention
// ~94% of this repo's own source files already follow, plus a bounded reverse-dependency
// search for a shared file's own dependents) so a typical small change checks in single-
// digit seconds, not minutes.
//
// What this can and cannot replace: it can fully replace the model for "does this diff
// break an EXISTING test" -- that's a fact, not a judgment call, and running the test IS
// the ground truth. It cannot replace semantic correctness review for a regression with
// NO existing test coverage (the change_review finding on 14e18c1, a crash on
// malformed-but-valid JSON, had no covering test anywhere -- no test suite, however
// complete, can fail a test that was never written). Callers should treat a `passed:
// true` result as "no test-detectable regression," never as "no regression."

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Caps keep this "scoped" in fact, not just in name -- a hot shared utility (imported
// from dozens of files) could otherwise balloon the reverse-dependency search back
// toward full-suite time, exactly the thing this module exists to avoid.
const MAX_REVERSE_DEP_FILES = 8;
const MAX_TEST_FILES = 12;
const RUN_TIMEOUT_MS = 45000; // must stay well under the ~3-4min LLM call this replaces

function isTestFile(file) {
  return /\.test\.[jt]sx?$/i.test(file) || /(?:^|\/)test_[^/]+\.py$/i.test(file);
}

// The co-located test for a changed source file, if one actually exists on disk --
// <name>.test.js next to <name>.js (JS/TS), test_<name>.py next to <name>.py (Python).
function coLocatedTestFor(repoRoot, file) {
  if (/\.py$/i.test(file)) {
    const dir = path.dirname(file);
    const name = path.basename(file, '.py');
    if (name.startsWith('test_')) return null; // it IS a test file, not something with one
    const candidate = path.join(dir, `test_${name}.py`).replace(/\\/g, '/');
    return fs.existsSync(path.join(repoRoot, candidate)) ? candidate : null;
  }
  if (!/\.[jt]sx?$/i.test(file)) return null;
  const ext = path.extname(file);
  const base = file.slice(0, -ext.length);
  const candidate = `${base}.test${ext}`;
  return fs.existsSync(path.join(repoRoot, candidate)) ? candidate : null;
}

// Bounded reverse-dependency search: which OTHER test files, sitting in the changed
// file's own directory or its parent, require()/import it by relative path? Deliberately
// NOT a repo-wide grep -- a common basename (e.g. "config") would match unrelated modules
// everywhere and defeat the whole point of staying scoped. A dependent outside these two
// directories is out of scope for this gate; the LLM review (or a human) still sees it.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function reverseDependents(repoRoot, file, alreadyIncluded) {
  if (!/\.[jt]sx?$/i.test(file) || isTestFile(file)) return [];
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const searchDirs = [...new Set([dir, path.dirname(dir)])];
  // Matches require('./util') / require('./util.js') / import ... from "../util" -- same
  // quote char on both ends, base immediately followed by either the closing quote or a
  // JS/TS extension then the closing quote, never a longer name that merely starts with
  // base (e.g. "./utility" must NOT match a search for "util").
  const re = new RegExp(`(['"])\\.\\.?/${escapeRegExp(base)}(?:\\.[jt]sx?)?\\1`);
  const hits = [];
  for (const d of searchDirs) {
    let entries;
    try { entries = fs.readdirSync(path.join(repoRoot, d)); } catch { continue; }
    for (const name of entries) {
      if (!/\.test\.[jt]sx?$/i.test(name)) continue;
      const rel = path.join(d, name).replace(/\\/g, '/');
      if (alreadyIncluded.has(rel)) continue;
      let content;
      try { content = fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { continue; }
      if (re.test(content)) {
        hits.push(rel);
        if (hits.length >= MAX_REVERSE_DEP_FILES) return hits;
      }
    }
  }
  return hits;
}

// { js: [...], py: [...] } -- repo-relative paths of every test file this gate will run
// for the given changed files. Never throws; an unreadable directory just yields fewer
// hits, same "a gap here degrades to less coverage, not a crash" discipline the rest of
// this pipeline's advisory checks already follow.
function findAffectedTestFiles(repoRoot, changedFiles) {
  const js = new Set();
  const py = new Set();
  for (const file of changedFiles || []) {
    if (isTestFile(file)) {
      // The change touched a test file directly -- run that file itself.
      if (fs.existsSync(path.join(repoRoot, file))) (/\.py$/i.test(file) ? py : js).add(file);
      continue;
    }
    const co = coLocatedTestFor(repoRoot, file);
    if (co) (/\.py$/i.test(co) ? py : js).add(co);
  }
  for (const file of changedFiles || []) {
    for (const dep of reverseDependents(repoRoot, file, js)) {
      js.add(dep);
      if (js.size >= MAX_TEST_FILES) break;
    }
  }
  return { js: [...js].slice(0, MAX_TEST_FILES), py: [...py].slice(0, MAX_TEST_FILES) };
}

function parseNodeTestFailures(output) {
  const out = [];
  const re = /^not ok \d+ - (.+)$/gm;
  let m;
  while ((m = re.exec(output))) out.push(m[1].trim());
  return out;
}

function parsePyTestFailures(output) {
  const out = [];
  const re = /^(?:FAIL|ERROR): (.+)$/gm;
  let m;
  while ((m = re.exec(output))) out.push(m[1].trim());
  return out;
}

// Node's own test runner sets NODE_TEST_CONTEXT on itself (confirmed live: present on
// process.env at read time despite not showing up in Object.keys(process.env) -- it is
// not a normal env var). A CHILD `node --test` that inherits it believes it is a worker
// reporting results back to a parent test runner over IPC rather than running standalone,
// and exits 0 regardless of whether its own tests actually passed -- confirmed live, the
// exact way this module's own test suite silently produced false "passed: true" results
// for a fixture that fails every time run directly. Strips it (and anything else in the
// same family, defensively) so this gate's own verdict never depends on whether ITS
// caller happens to be running under a test runner.
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('NODE_TEST_')) continue;
    env[k] = v;
  }
  return env;
}

// A timeout is NOT a failure -- confirmed live: src/local-draft.test.js's own header
// documents it can legitimately wait on a real `flock` for up to 600s under GPU-lane
// contention with the live pipeline (the exact condition this gate always runs under,
// since it executes DURING live pipeline processing). Conflating "didn't finish in
// RUN_TIMEOUT_MS" with "asserted something false" would auto-file a false "confirmed
// regression" on every commit touching a lock-contending file. `passed: null` marks this
// inconclusive -- same "stay silent, let the LLM decide" treatment as no-coverage-exists,
// never folded into a hard pass or fail.
function runJsTests(repoRoot, files) {
  if (!files.length) return null;
  try {
    execFileSync('node', ['--test', ...files], {
      cwd: repoRoot, timeout: RUN_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(),
    });
    return { ran: files, passed: true, failures: [] };
  } catch (e) {
    const timedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    return { ran: files, passed: timedOut ? null : false, failures: parseNodeTestFailures(out), raw: out.slice(0, 4000), timedOut };
  }
}

// Defaults to the repo's own .venv when the caller doesn't name an interpreter -- plain
// `python3` is whatever's on PATH, which on this machine is the bare system interpreter
// with no project dependencies installed (confirmed live: every test that imports app.py
// failed with "ModuleNotFoundError: No module named 'flask'", a false regression signal
// for 100% of Python-touching commits, not a real one -- Flask lives only in
// <repoRoot>/.venv, same venv the dashboard itself is actually launched with).
function defaultPythonBin(repoRoot) {
  const venvPy = path.join(repoRoot, '.venv', 'bin', 'python');
  return fs.existsSync(venvPy) ? venvPy : 'python3';
}

function runPyTests(repoRoot, files, pythonBin) {
  if (!files.length) return null;
  const modules = files.map((f) => f.replace(/\.py$/, '').replace(/\//g, '.'));
  try {
    execFileSync(pythonBin || defaultPythonBin(repoRoot), ['-m', 'unittest', ...modules], {
      cwd: repoRoot, timeout: RUN_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(),
    });
    return { ran: files, passed: true, failures: [] };
  } catch (e) {
    const timedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    return { ran: files, passed: timedOut ? null : false, failures: parsePyTestFailures(out), raw: out.slice(0, 4000), timedOut };
  }
}

// The gate itself. Returns null when there is nothing to check (no covering test exists
// for any changed file -- the common, expected case for a repo with ~94% but not 100%
// co-location, and the ONLY case where this stays silent rather than reporting a real
// pass/fail). Otherwise { passed, ran, failures, jsRaw, pyRaw }. Never throws -- a runner-
// level problem (missing python3, a bad cwd) degrades to null exactly like "no covering
// test", never blocks the caller on this check's OWN failure.
function runScopedTests(repoRoot, changedFiles, opts = {}) {
  let affected;
  try {
    affected = findAffectedTestFiles(repoRoot, changedFiles);
  } catch {
    return null;
  }
  if (!affected.js.length && !affected.py.length) return null;
  let jsResult = null;
  let pyResult = null;
  try { jsResult = runJsTests(repoRoot, affected.js); } catch { /* degrade below */ }
  try { pyResult = runPyTests(repoRoot, affected.py, opts.pythonBin); } catch { /* degrade below */ }
  if (!jsResult && !pyResult) return null;
  // Combine per-suite verdicts: a real `false` (an actual assertion failed) always wins --
  // that's a genuine confirmed regression regardless of what the other suite did. Absent
  // that, a `null` (timed out -- inconclusive, not "passed") makes the combined result
  // inconclusive too, since claiming `passed: true` when one suite never actually finished
  // would be just as wrong as claiming `passed: false`. Only true+true (or a suite that
  // didn't run at all) combines to true.
  const verdicts = [jsResult ? jsResult.passed : undefined, pyResult ? pyResult.passed : undefined]
    .filter((v) => v !== undefined);
  const anyFalse = verdicts.includes(false);
  const anyNull = verdicts.includes(null);
  const passed = anyFalse ? false : anyNull ? null : true;
  if (passed === null) return null;
  return {
    passed,
    ran: [...(jsResult ? jsResult.ran : []), ...(pyResult ? pyResult.ran : [])],
    failures: [...((jsResult && jsResult.failures) || []), ...((pyResult && pyResult.failures) || [])],
    jsRaw: jsResult && jsResult.raw,
    pyRaw: pyResult && pyResult.raw,
  };
}

module.exports = {
  findAffectedTestFiles,
  runScopedTests,
  runJsTests,
  runPyTests,
  parseNodeTestFailures,
  parsePyTestFailures,
  MAX_REVERSE_DEP_FILES,
  MAX_TEST_FILES,
  RUN_TIMEOUT_MS,
};
