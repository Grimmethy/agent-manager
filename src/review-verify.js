'use strict';

// Executed verification for the review step (2026-09-30, Grimmethy: "I don't see why this step can't be
// local using the tools we already have in place").
//
// Why: the reviewer (review-task.js) is a pure prompt->verdict call with no tools. It is handed the
// draft's own NARRATED "Acceptance:" results and votes on whether they sound right -- it never
// reproduces any of them. Every false rejection seen hand-processing tasks through it was the model
// misreading narrated evidence (a not-yet-applied diff read as "fabricated", a test count miscounted).
// This module turns that into fact: apply the diff in a private scratch worktree, run the tests that
// cover the changed files, and re-run the acceptance commands the draft claims PASS on.
//
// This file is only the engine. It is NOT wired into runReview yet (that is the next slice), so it changes no
// behavior on its own.
//
// Outcomes (never throws):
//   status 'failed'       -- a covering test fails, or a command the draft claimed PASS on really exits non-zero.
//   status 'passed'       -- the diff applied, something was actually executed, and everything executed confirmed.
//   status 'inconclusive' -- the diff would not apply (often a slice that depends on an unmerged earlier one), the
//                            sandbox is unavailable, something timed out, or nothing runnable was found. The caller
//                            must NOT treat this as a failure (same rule as PR #454: a timeout is not a regression).
//
// Safety: the commands come from a MODEL-written Acceptance block and run repo code from a not-yet-reviewed diff, so
// (1) only a tight allowlist of commands whose PASS means "exit 0" is ever executed (node --test / --check,
// python -m unittest / py_compile; no shell metacharacters, repo-relative paths only) -- notably NOT grep, where
// "PASS" often means "no matches" (exit 1); (2) everything runs inside the bwrap sandbox (sandbox.js) with a scrubbed
// environment, and if bwrap is missing the result is inconclusive rather than an unsandboxed run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { prepareAdhocWorktree, applyPartialDiff, cleanupAdhocWorktree } = require('./agentic-draft-common.js');
const { findAffectedTestFiles, parseNodeTestFailures, parsePyTestFailures } = require('./scoped-test-runner.js');
const { wrapWithSandbox } = require('./sandbox.js');

const COMMAND_TIMEOUT_MS = 120000;
const TEST_TIMEOUT_MS = 90000;
const TOTAL_BUDGET_MS = 300000;
const MAX_COMMANDS = 8;
const MAX_OUTPUT_CHARS = 4000;

function extractChangedFiles(diff) {
  const files = [];
  const re = /^diff --git a\/(\S+) b\/(\S+)$/gm;
  let m;
  while ((m = re.exec(String(diff || '')))) if (!files.includes(m[2])) files.push(m[2]);
  return files;
}

// Shell-free tokenizer: splits on whitespace, honours '...' and "..." quotes, and returns null if it sees any shell
// metacharacter outside quotes (pipes, &&, ;, redirects, $, backticks, subshells) or an unterminated quote.
function tokenize(cmd) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of String(cmd)) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/[|&;<>$`()\n\\]/.test(ch)) return null;
    if (/\s/.test(ch)) { if (started || cur) { tokens.push(cur); cur = ''; started = false; } continue; }
    cur += ch; started = true;
  }
  if (quote) return null;
  if (started || cur) tokens.push(cur);
  return tokens;
}

function isSafeRelPath(p) {
  return typeof p === 'string' && p && !path.isAbsolute(p) && !p.split('/').includes('..') && !p.startsWith('-') && /^[\w./@+-]+$/.test(p);
}

// One backticked command -> { bin: 'node'|'python', args } if it is on the allowlist, else null.
function classifyCommand(tokens) {
  if (!tokens || !tokens.length) return null;
  const [bin, ...rest] = tokens;
  if (bin === 'node') {
    const [flag, ...files] = rest;
    if ((flag === '--test' || flag === '--check') && files.length && files.every(isSafeRelPath) && files.every((f) => /\.(?:c|m)?[jt]s$/.test(f))) {
      return { bin: 'node', args: [flag, ...files] };
    }
    return null;
  }
  if (bin === 'python' || bin === 'python3') {
    if (rest[0] !== '-m') return null;
    const [mod, ...args] = rest.slice(1);
    if (mod === 'py_compile') {
      return args.length && args.every((f) => isSafeRelPath(f) && f.endsWith('.py')) ? { bin: 'python', args: ['-m', 'py_compile', ...args] } : null;
    }
    if (mod === 'unittest') {
      const out = [];
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === '-v') out.push(a);
        else if (a === 'discover') {
          out.push(a);
          // only `discover -s <relpath> -p <glob>` is understood
          for (let j = i + 1; j < args.length; j += 2) {
            if (!(args[j] === '-s' && isSafeRelPath(args[j + 1])) && !(args[j] === '-p' && /^[\w*.?-]+$/.test(args[j + 1] || ''))) return null;
            out.push(args[j], args[j + 1]);
          }
          i = args.length;
        } else if (/^[A-Za-z_][\w.]*$/.test(a)) out.push(a);
        else return null;
      }
      return out.length ? { bin: 'python', args: ['-m', 'unittest', ...out] } : null;
    }
  }
  return null;
}

// Every backticked segment of an Acceptance line's "check" text that is on the allowlist, in order.
function extractRunnableCommands(checkText) {
  const cmds = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(String(checkText || ''))) && cmds.length < 3) {
    const c = classifyCommand(tokenize(m[1]));
    if (c) cmds.push({ ...c, text: m[1].trim() });
  }
  return cmds;
}

function sandboxEnv(tmpDir, sandboxRoot) {
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: tmpDir,
    LANG: 'C.UTF-8',
    // Same reason as scoped-test-runner.childEnv: tests must never see the live pipeline's write targets.
    AGENT_MANAGER_REPO_ROOT: sandboxRoot,
    AGENT_MANAGER_APPLY_REPO_ROOT: sandboxRoot,
  };
}

// Runs one allowlisted command in the bwrap sandbox. { ran, exitCode, timedOut, output } or { ran: false, reason }.
function runSandboxed({ worktreeDir, bin, args, timeoutMs, pythonBin, mainRepoRoot }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verify-tmp-'));
  try {
    const realBin = bin === 'python' ? pythonBin : process.execPath;
    if (!realBin) return { ran: false, reason: 'no python interpreter available' };
    const readOnlyBinds = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', path.dirname(path.dirname(process.execPath))];
    if (mainRepoRoot) readOnlyBinds.push(path.join(mainRepoRoot, '.venv'));
    try { readOnlyBinds.push(path.dirname(path.dirname(fs.realpathSync(realBin)))); } catch { /* keep going */ }
    const wrapped = wrapWithSandbox(realBin, args, {
      workDir: worktreeDir,
      readOnlyBinds,
      writableBinds: [worktreeDir, tmpDir],
      env: sandboxEnv(tmpDir, tmpDir),
    });
    if (!wrapped.available) return { ran: false, reason: 'bwrap sandbox unavailable' };
    const r = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const timedOut = (r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM';
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    return { ran: true, exitCode: timedOut ? null : (typeof r.status === 'number' ? r.status : 1), timedOut: !!timedOut, output: output.slice(-MAX_OUTPUT_CHARS) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function worktreePaths(taskId) {
  const safe = String(taskId).replace(/[^\w.-]/g, '_');
  // Deliberately NOT agenticWorktreePaths(): a draft may be using that name for the same task id.
  return { worktreeDir: path.join(os.tmpdir(), `agent-manager-review-worktree-${safe}`), branchName: `throwaway/review-${safe}` };
}

// --- covering tests by changed symbol -------------------------------------------------------------------
// scoped-test-runner finds covering tests by file NAME (foo.js -> foo.test.js, foo.py -> test_foo.py). That convention holds for
// ~94% of src/*.js but not for python/dashboard/, where app.py and routes/*.py are covered by tests named for the feature
// (test_git_discard_branch.py, test_hub_data_route.py), so most dashboard diffs came back with "no covering tests". Fallback: find
// the test files in the changed file's own directory (or its parent) that mention a function/class the diff adds or changes.
const SYMBOL_STOPLIST = new Set(['main', 'test', 'setUp', 'tearDown', 'run', 'get', 'set', 'init', 'constructor', 'render', 'handler', 'wrapper', 'helper', 'callback']);
const MAX_SYMBOLS = 20;
const MAX_SYMBOL_TEST_FILES = 12;

function extractChangedSymbols(diff) {
  const found = [];
  const add = (name) => {
    if (name && name.length >= 5 && !SYMBOL_STOPLIST.has(name) && !found.includes(name)) found.push(name);
  };
  const declRe = /^(?:async\s+)?(?:function\*?\s+|def\s+|class\s+)([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
  for (const line of String(diff || '').split('\n')) {
    let body = null;
    if (line.startsWith('@@')) body = (line.match(/^@@[^@]*@@\s*(.*)$/) || [])[1];      // hunk header: the function the hunk sits in
    else if ((line[0] === '+' || line[0] === '-' || line[0] === ' ') && !/^(?:\+\+\+|---)/.test(line)) body = line.slice(1).trimStart();   // changed OR context: an edit inside a function shows its def as context
    if (!body) continue;
    const m = body.match(declRe);
    if (m) add(m[1] || m[2]);
    if (found.length >= MAX_SYMBOLS) break;
  }
  return found;
}

function symbolTestCandidates(repoRoot, changedFiles) {
  const dirs = new Set();
  for (const f of changedFiles || []) {
    if (!/\.(?:py|[jt]sx?)$/i.test(f)) continue;
    const dir = path.dirname(f);
    dirs.add(dir);
    dirs.add(path.dirname(dir));
  }
  const out = [];
  for (const d of dirs) {
    let names;
    try { names = fs.readdirSync(path.join(repoRoot, d)); } catch { continue; }
    for (const n of names) {
      if (/^test_[^/]+\.py$/i.test(n) || /\.test\.[jt]sx?$/i.test(n)) out.push(path.join(d, n).replace(/\\/g, '/'));
    }
  }
  return out;
}

// { js: [...], py: [...] } like findAffectedTestFiles, ranked by how many distinct changed symbols each test file mentions.
function findSymbolCoveringTests(repoRoot, changedFiles, symbols) {
  const res = { js: [], py: [] };
  if (!symbols || !symbols.length) return res;
  const escaped = symbols.map((sy) => sy.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&'));
  const scored = [];
  for (const rel of symbolTestCandidates(repoRoot, changedFiles)) {
    if ((changedFiles || []).includes(rel)) continue; // a test file the diff itself changes is handled by the primary finder
    let text;
    try { text = fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { continue; }
    let hits = 0;
    for (const sy of escaped) if (new RegExp(`(?<![\\w$])${sy}(?![\\w$])`).test(text)) hits += 1;
    if (hits) scored.push({ rel, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || a.rel.localeCompare(b.rel));
  for (const { rel } of scored.slice(0, MAX_SYMBOL_TEST_FILES)) (/\.py$/i.test(rel) ? res.py : res.js).push(rel);
  return res;
}

// The primary (file-name based) finder first; only when it finds NOTHING, fall back to tests that mention the changed symbols.
function findTestsWithSymbolFallback(repoRoot, changedFiles, diff) {
  const primary = findAffectedTestFiles(repoRoot, changedFiles);
  if (primary.js.length || primary.py.length) return primary;
  return findSymbolCoveringTests(repoRoot, changedFiles, extractChangedSymbols(diff));
}

function verifyDiff({ taskId, rawDiff, acceptanceResults = [], repoRoot, mainBranch, pythonBin, budgetMs = TOTAL_BUDGET_MS, deps = {} }) {
  const d = {
    prepare: prepareAdhocWorktree, applyDiff: applyPartialDiff, cleanup: cleanupAdhocWorktree, run: runSandboxed,
    findTests: findTestsWithSymbolFallback, ...deps,
  };
  const result = { status: 'inconclusive', reasons: [], apply: null, tests: null, commands: [] };
  const inconclusive = (reason) => { result.reasons.push(reason); return result; };
  if (!String(rawDiff || '').trim()) return inconclusive('no diff to verify');
  const { worktreeDir, branchName } = worktreePaths(taskId);
  const deadline = Date.now() + budgetMs;
  const py = pythonBin || (repoRoot && fs.existsSync(path.join(repoRoot, '.venv', 'bin', 'python')) ? path.join(repoRoot, '.venv', 'bin', 'python') : null);
  let prepared = false;
  try {
    const prep = d.prepare(repoRoot, mainBranch, worktreeDir, branchName);
    prepared = true;
    if (!prep || !prep.ok) return inconclusive(`could not create a scratch worktree: ${(prep && prep.reason) || 'unknown'}`);
    const applied = d.applyDiff(worktreeDir, rawDiff);
    result.apply = { applied: !!applied.applied, reason: applied.reason || null };
    if (!applied.applied) return inconclusive(`the diff does not apply to ${mainBranch} (often a slice that depends on an unmerged earlier one): ${applied.reason || 'unknown'}`);

    let anyTimeout = false;
    let sandboxMissing = false;
    let anyExecuted = false;
    const failures = [];
    const runOne = (bin, args, timeoutMs) => {
      const remaining = deadline - Date.now();
      if (remaining <= 1000) { anyTimeout = true; return { ran: true, timedOut: true, exitCode: null, output: '' }; }
      const r = d.run({ worktreeDir, bin, args, timeoutMs: Math.min(timeoutMs, remaining), pythonBin: py, mainRepoRoot: repoRoot });
      if (!r.ran) { sandboxMissing = true; return r; }
      anyExecuted = true;
      if (r.timedOut) anyTimeout = true;
      return r;
    };

    // 1. The tests that cover the changed files.
    const changed = extractChangedFiles(rawDiff);
    const affected = d.findTests(worktreeDir, changed, rawDiff);
    const suites = [];
    if (affected.js.length) suites.push({ label: 'js', bin: 'node', args: ['--test', ...affected.js], files: affected.js, parse: parseNodeTestFailures });
    if (affected.py.length) suites.push({ label: 'py', bin: 'python', args: ['-m', 'unittest', ...affected.py.map((f) => f.replace(/\.py$/, '').replace(/\//g, '.'))], files: affected.py, parse: parsePyTestFailures });
    if (suites.length) {
      result.tests = { ran: [], passed: true, failures: [], timedOut: false };
      for (const s of suites) {
        const r = runOne(s.bin, s.args, TEST_TIMEOUT_MS);
        if (!r.ran) { result.tests = null; break; }
        result.tests.ran.push(...s.files);
        if (r.timedOut) { result.tests.timedOut = true; result.tests.passed = null; continue; }
        if (r.exitCode !== 0) { result.tests.passed = false; result.tests.failures.push(...s.parse(r.output)); result.tests.raw = r.output; failures.push(`covering ${s.label} tests failed`); }
      }
    }

    // 2. Re-run the commands the draft claims PASS on.
    for (const ar of (acceptanceResults || []).slice(0, MAX_COMMANDS)) {
      const cmds = extractRunnableCommands(ar.check);
      for (const c of cmds) {
        const r = runOne(c.bin, c.args, COMMAND_TIMEOUT_MS);
        if (!r.ran) { result.commands.push({ criterion: ar.criterion, command: c.text, claimedPass: !!ar.pass, outcome: 'skipped', detail: r.reason }); continue; }
        let outcome;
        if (r.timedOut) outcome = 'inconclusive';
        else if (r.exitCode === 0) outcome = 'confirmed';
        else outcome = ar.pass ? 'contradicted' : 'confirmed-fail';
        if (outcome === 'contradicted') failures.push(`\`${c.text}\` exited ${r.exitCode} but the draft claimed PASS`);
        result.commands.push({ criterion: ar.criterion, command: c.text, claimedPass: !!ar.pass, outcome, exitCode: r.exitCode, detail: outcome === 'contradicted' ? r.output.slice(-800) : '' });
      }
    }

    if (failures.length) { result.status = 'failed'; result.reasons.push(...failures); return result; }
    if (sandboxMissing && !anyExecuted) return inconclusive('the bwrap sandbox is unavailable, so nothing was executed');
    if (anyTimeout) return inconclusive('a check timed out, which is not a failure');
    const confirmed = (result.tests && result.tests.passed === true) || result.commands.some((c) => c.outcome === 'confirmed');
    if (!confirmed) return inconclusive('no covering tests and no runnable acceptance commands were found');
    result.status = 'passed';
    return result;
  } catch (e) {
    return inconclusive(`verification errored (${String((e && e.message) || e).slice(0, 200)})`);
  } finally {
    if (prepared) { try { d.cleanup(repoRoot, worktreeDir, branchName); } catch { /* best-effort */ } }
  }
}

module.exports = {
  extractChangedSymbols, findSymbolCoveringTests, findTestsWithSymbolFallback,
  verifyDiff, extractChangedFiles, extractRunnableCommands, classifyCommand, tokenize, runSandboxed, worktreePaths,
  COMMAND_TIMEOUT_MS, TEST_TIMEOUT_MS, TOTAL_BUDGET_MS,
};
