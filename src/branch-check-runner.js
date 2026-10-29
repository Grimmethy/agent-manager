'use strict';

// Evidence for a branch verdict: check one unmerged branch in a scratch copy and say what was and was not run.
//
// Why: on 2026-10-29 the chat recorded 14 `merge` verdicts after 26 shell commands, none of which ran a test (its run_bash is read-only and limited to
// 30 seconds), and two of those merges were wrong when checked by hand (an added logger.error with no logger defined; a validator that rejected the
// repository's own scenario files). runBranchCheck gives a verdict something to rest on.
//
// What it does, in order: add a detached git worktree of the branch head under the OS temp dir, list the files the branch changes against `base`, work
// out whether the branch is docs-only, run two cheap static scans over the lines the branch ADDS, then run the first test harness that recognises the
// checkout (the harness list is supplied by the caller; the harness piece of this hub supplies the real ones). The worktree is always removed again and
// the project's own working tree is never written. It resolves to one plain object and never rejects: anything that goes wrong becomes a `notRun` line or a
// red `checked` entry, never a pass.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 240000;
const DEFAULT_BUDGET_MS = 600000;
const DEFAULT_MAX_TEST_FILES = 12;
const MAX_BUFFER = 8 * 1024 * 1024;
const SUMMARY_TAIL_CHARS = 600;

// The only process runner: never a shell. Resolves { code, stdout, stderr, timedOut }; never rejects.
function defaultExec(file, args, { cwd, env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: stdout || '', stderr: stderr || '', timedOut: false });
      const timedOut = !!err.killed;
      const code = typeof err.code === 'number' ? err.code : -1;
      resolve({ code, stdout: stdout || '', stderr: (stderr || '') || (typeof err.code === 'string' ? `${err.code}: ${err.message}` : ''), timedOut });
    });
  });
}

// Code from an unmerged branch runs with the owner's privileges: give it only what a test run needs, with HOME inside the scratch directory.
function childEnv(dir) {
  return { PATH: process.env.PATH || '', LANG: process.env.LANG || 'C.UTF-8', TMPDIR: dir, HOME: dir };
}

const tail = (text, n = SUMMARY_TAIL_CHARS) => {
  const t = String(text || '').trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
};

// docsOnly: at least one changed path and every one of them under docs/ or Docs/ or a markdown file.
function docsOnlyPaths(paths) {
  return paths.length > 0 && paths.every((p) => /^docs\//i.test(p) || /\.md$/i.test(p));
}

// The lines a unified diff with no context (-U0) ADDS, with their line numbers in the new file.
function addedLines(diffText) {
  const out = [];
  let line = 0;
  for (const raw of String(diffText || '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) { out.push({ line, text: raw.slice(1) }); line += 1; }
  }
  return out;
}

const LOGGER_USE = /(?<![\w.])(logger|log)\.(?:debug|info|warning|warn|error|exception|critical|log)\b/;

// Is `name` bound anywhere in this Python source: assigned, imported, or a function parameter. `import logging` alone does not bind `logger`.
function pythonNameIsBound(source, name) {
  const assigned = new RegExp(`(?:^|[\\s;])${name}\\s*(?::[^=\\n]+)?=[^=]`, 'm');
  const imported = new RegExp(`^\\s*(?:import\\s+[^\\n]*\\b${name}\\b|from\\s+\\S+\\s+import\\s+[^\\n]*\\b${name}\\b)`, 'm');
  const parameter = new RegExp(`\\bdef\\s+\\w+\\s*\\([^)]*\\b${name}\\b`, 'm');
  return assigned.test(source) || imported.test(source) || parameter.test(source);
}

const REQUIRE_RELATIVE = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;

function localRequireExists(worktreeDir, fromFile, target) {
  const base = path.resolve(worktreeDir, path.dirname(fromFile), target);
  return ['', '.js', '.json', '.cjs', '.mjs', '/index.js'].some((ext) => fs.existsSync(base + ext) && !(ext === '' && fs.statSync(base).isDirectory()));
}

async function runBranchCheck(opts = {}) {
  const clock = typeof opts.now === 'function' ? opts.now : Date.now;
  const started = clock();
  const exec = opts.exec || defaultExec;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const budgetMs = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : DEFAULT_BUDGET_MS;
  const maxTestFiles = Number(opts.maxTestFiles) > 0 ? Number(opts.maxTestFiles) : DEFAULT_MAX_TEST_FILES;
  const { repoRoot, branch, headSha, base } = opts;
  const result = {
    headSha, branch, base, repoRoot, changedFiles: [], docsOnly: false, harness: null, testsRun: false, checked: [], notRun: [], durationMs: 0, checkedAt: '',
  };
  let dir = null;
  let worktreeAdded = false;
  try {
    if (![repoRoot, headSha, base].every((v) => typeof v === 'string' && v.trim())) {
      result.notRun.push('repoRoot, headSha and base are required to check a branch');
      return result;
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-branch-check-'));
    const env = childEnv(dir);
    const git = (args, cwd) => exec('git', args, { cwd: cwd || dir, env, timeoutMs: 60000 });

    const added = await git(['-C', repoRoot, 'worktree', 'add', '--detach', dir, headSha], repoRoot);
    if (added.code !== 0) {
      result.notRun.push(`could not create the scratch worktree for ${headSha}: ${tail(added.stderr) || 'git worktree add failed'}`);
      return result;
    }
    worktreeAdded = true;

    const names = await git(['diff', '--name-only', `${base}...${headSha}`]);
    if (names.code !== 0) {
      result.notRun.push(`could not list the files changed against ${base}: ${tail(names.stderr) || 'git diff failed'}`);
      return result;
    }
    result.changedFiles = names.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    result.docsOnly = docsOnlyPaths(result.changedFiles);

    const addedFor = async (file) => addedLines((await git(['diff', '-U0', `${base}...${headSha}`, '--', file])).stdout);

    // Static scan 1: a Python file that now calls logger.<level>(...) / log.<level>(...) but never binds that name.
    const pyFiles = result.changedFiles.filter((f) => f.endsWith('.py') && fs.existsSync(path.join(dir, f)));
    if (pyFiles.length) {
      const problems = [];
      for (const file of pyFiles) {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        for (const { line, text } of await addedFor(file)) {
          const m = LOGGER_USE.exec(text);
          if (m && !pythonNameIsBound(source, m[1])) problems.push(`${file}:${line} uses ${m[1]} but the module never imports or assigns it`);
        }
      }
      result.checked.push({
        kind: 'static', what: 'undefined logger name in added Python lines', command: '(static scan of the lines the branch adds)', ok: problems.length === 0,
        summary: problems.length ? problems.join('; ') : `${pyFiles.length} changed Python file(s): every logger or log name the branch uses is bound`,
      });
    }

    // Static scan 2: a JavaScript file that now requires a local file that does not exist.
    const jsFiles = result.changedFiles.filter((f) => /\.(?:js|cjs|mjs)$/.test(f) && fs.existsSync(path.join(dir, f)));
    if (jsFiles.length) {
      const problems = [];
      for (const file of jsFiles) {
        for (const { line, text } of await addedFor(file)) {
          if (/^\s*(?:\/\/|\*)/.test(text)) continue;
          for (const m of text.matchAll(REQUIRE_RELATIVE)) {
            if (!localRequireExists(dir, file, m[2])) problems.push(`${file}:${line} requires ${m[2]} which does not exist`);
          }
        }
      }
      result.checked.push({
        kind: 'static', what: 'missing local require in added JavaScript lines', command: '(static scan of the lines the branch adds)', ok: problems.length === 0,
        summary: problems.length ? problems.join('; ') : `${jsFiles.length} changed JavaScript file(s): every local require the branch adds resolves`,
      });
    }

    // Tests: the first harness that recognises this checkout. The harness list comes from the caller (an empty list means none).
    const harnesses = Array.isArray(opts.harnesses) ? opts.harnesses : [];
    let chosen = null;
    for (const h of harnesses) {
      try { if (h && h.detect(dir, fs)) { chosen = h; break; } } catch (_) { /* a harness that cannot tell does not match */ }
    }
    if (!chosen) {
      result.notRun.push('no test harness recognised for this repo');
    } else {
      result.harness = chosen.id;
      const grep = async (pattern, pathspec) => {
        const r = await git(['grep', '-l', '-F', '-e', pattern, '--', pathspec]);
        return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      };
      const plan = await chosen.plan({ worktreeDir: dir, changedFiles: result.changedFiles, maxTestFiles, grep });
      for (const line of (plan && plan.notRun) || []) result.notRun.push(line);
      for (const c of (plan && plan.commands) || []) {
        const remaining = budgetMs - (clock() - started);
        if (remaining <= 0) { result.notRun.push(`skipped, the ${Math.round(budgetMs / 1000)} s check budget is used up: ${c.what}`); continue; }
        const run = await exec(c.file, c.args, { cwd: c.cwd || dir, env: { ...env, ...(c.env || {}) }, timeoutMs: Math.min(timeoutMs, remaining) });
        const command = [c.file, ...(c.args || [])].join(' ');
        result.checked.push({
          kind: 'tests', what: c.what, command, ok: run.code === 0 && !run.timedOut,
          summary: run.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exit ${run.code}${tail(run.stdout || run.stderr) ? `: ${tail(run.stdout || run.stderr)}` : ''}`,
        });
      }
    }
  } catch (e) {
    result.notRun.push(`the check stopped early: ${e && e.message ? e.message : e}`);
  } finally {
    if (dir) {
      try {
        if (worktreeAdded) {
          await exec('git', ['-C', repoRoot, 'worktree', 'remove', '--force', dir], { cwd: repoRoot, env: childEnv(os.tmpdir()), timeoutMs: 60000 });
          await exec('git', ['-C', repoRoot, 'worktree', 'prune'], { cwd: repoRoot, env: childEnv(os.tmpdir()), timeoutMs: 60000 });
        }
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        result.notRun.push(`the scratch directory ${dir} may not have been removed: ${e && e.message ? e.message : e}`);
      }
    }
    result.testsRun = result.checked.some((c) => c.kind === 'tests');
    result.durationMs = clock() - started;
    result.checkedAt = new Date(clock()).toISOString();
  }
  return result;
}

module.exports = { runBranchCheck, defaultExec, childEnv, docsOnlyPaths, addedLines, pythonNameIsBound, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_TEST_FILES };
