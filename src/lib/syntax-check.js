'use strict';

// syntax-check.js -- pure helpers for the changed-file syntax gate in review-verify.js.
//
// 2026-10-07 (TaxHarvest branch reviews): review-verify applied a diff and ran the covering tests but never checked that the files it
// CHANGED still parse. A model-drafted edit split an import (`from cadastral_utils import` / `from constants import X (`), the local
// reviewers approved it, the task reached pending-merge, and the requeued redraft produced the identical SyntaxError. A syntax error is
// mechanically decidable, so it is decided mechanically: a changed file that parses on the base but not with the diff is a hard failure.
//
// TypeScript/TSX is deliberately NOT checked (no `tsc` in the repos this pipeline reviews); those files are reported as skipped so the
// reviewers know the gap exists rather than assume coverage.

const fs = require('fs');
const path = require('path');

const NODE_EXT = new Set(['.js', '.mjs', '.cjs']);
// compile() performs the same checks as py_compile (including `return` outside a function) without writing a .pyc into the worktree.
const PY_CHECK_SCRIPT = 'import sys\ncompile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")';

// -> { kind: 'node'|'python'|'json', bin?, args? } | null (no checker for this extension)
function checkerFor(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (NODE_EXT.has(ext)) return { kind: 'node', bin: 'node', args: ['--check', file] };
  if (ext === '.py') return { kind: 'python', bin: 'python', args: ['-c', PY_CHECK_SCRIPT, file] };
  if (ext === '.json') return { kind: 'json' };
  return null;
}

// Node reports these when it classifies a .js file as the wrong module system for the nearest package.json -- an environment question,
// not a syntax error in the diff, so they are never counted as a failure.
const MODULE_FORMAT_RE = /Cannot use import statement outside a module|Unexpected token 'export'|require is not defined in ES module scope|Cannot use 'import\.meta' outside a module/;
function isModuleFormatAmbiguity(output) {
  return MODULE_FORMAT_RE.test(String(output || ''));
}

// First useful line of a checker's output: "<file>:<line> <SyntaxError message>" bounded to 300 chars.
function summarizeSyntaxError(output, file) {
  const text = String(output || '');
  const msg = (text.match(/^\s*((?:\w+Error|SyntaxError)[^\n]*)/m) || [])[1] || (text.trim().split('\n').filter(Boolean).pop() || 'syntax error');
  // Python's traceback starts with the checker script's OWN frame (`File "<string>", line 2`) and ends with the real location, so take the LAST
  // `line N`; node prints `<file>:<line>` first.
  const pyLines = [...text.matchAll(/\bline (\d+)\b/g)];
  const lineNo = pyLines.length ? pyLines[pyLines.length - 1][1] : (text.match(/:(\d+)\s*\n/) || [])[1];
  return `${file}${lineNo ? `:${lineNo}` : ''} ${msg.trim()}`.slice(0, 300);
}

// First existing interpreter: explicit pythonBin, repo .venv, AGENT_MANAGER_PYTHON, then the system python3. null when none exists.
function resolvePython({ explicit, repoRoot, env = process.env, exists = fs.existsSync } = {}) {
  const candidates = [
    explicit,
    repoRoot && path.join(repoRoot, '.venv', 'bin', 'python'),
    env && env.AGENT_MANAGER_PYTHON,
    '/usr/bin/python3',
    '/usr/local/bin/python3',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (exists(c)) return c; } catch { /* keep looking */ }
  }
  return null;
}

module.exports = { checkerFor, isModuleFormatAmbiguity, summarizeSyntaxError, resolvePython, PY_CHECK_SCRIPT };
