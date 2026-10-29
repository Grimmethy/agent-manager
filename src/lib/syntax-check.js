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
const nodeModule = require('module');

const NODE_EXT = new Set(['.js', '.mjs', '.cjs']);
// compile() performs the same checks as py_compile (including `return` outside a function) without writing a .pyc into the worktree.
const PY_CHECK_SCRIPT = 'import sys\ncompile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")';

// -> { kind: 'node'|'python'|'json'|'ts', bin?, args? } | null (no checker for this extension)
// 'ts' (.ts/.tsx) has no external command: it is parsed in-process by checkTypeScript below, so review-verify's command runner never sees it.
function checkerFor(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return { kind: 'ts', tsx: ext === '.tsx' };
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

// --- TypeScript / TSX (parse only) -------------------------------------------------------------------------------------------------
// 2026-10-08: neither `tsc` nor esbuild is installed in the repos this pipeline edits, so .ts/.tsx were skipped outright -- and the frontend is 91 .tsx
// + 30 .ts files. Two parsers, both parse-only (nothing is installed, written or run):
//   esbuild   resolved from AGENT_MANAGER_TS_TOOLS (a node_modules dir, e.g. a sibling project's), then from the consumer repo / the file's package.
//             Handles .ts AND .tsx, reports line:column.
//   node      node:module.stripTypeScriptTypes in 'transform' mode (Node >= 22.13, no dependency). Handles .ts only -- it cannot parse JSX.
// A .tsx file with no esbuild is SKIPPED with a stated reason, never failed.
const _esbuildCache = new Map();
function loadEsbuild(dirOrModulePath, repoRoot) {
  const key = `${dirOrModulePath}|${repoRoot || ''}`;
  if (_esbuildCache.has(key)) return _esbuildCache.get(key);
  let mod = null;
  try {
    const req = nodeModule.createRequire(path.join(dirOrModulePath, 'package.json'));
    mod = require(req.resolve('esbuild'));
    if (!mod || typeof mod.transformSync !== 'function') mod = null;
  } catch { mod = null; }
  _esbuildCache.set(key, mod);
  return mod;
}
function resolveEsbuild({ file, repoRoot, env = process.env }) {
  const tools = String(env.AGENT_MANAGER_TS_TOOLS || '').trim();
  if (tools) {
    // Accept either the node_modules directory or its parent.
    const m = loadEsbuild(path.basename(tools) === 'node_modules' ? path.dirname(tools) : tools, repoRoot);
    if (m) return m;
  }
  if (repoRoot) {
    const dirs = [];
    let d = path.dirname(path.resolve(repoRoot, file || '.'));
    const root = path.resolve(repoRoot);
    while (d.startsWith(root)) { dirs.push(d); if (d === root) break; d = path.dirname(d); }
    for (const dir of dirs) { const m = loadEsbuild(dir, repoRoot); if (m) return m; }
  }
  return null;
}

// -> { ok: true } | { error, line, column, message } | { skip: reason }
function checkTypeScript(file, text, { repoRoot, env = process.env } = {}) {
  const tsx = path.extname(String(file)).toLowerCase() === '.tsx';
  const es = resolveEsbuild({ file, repoRoot, env });
  if (es) {
    try {
      es.transformSync(String(text), { loader: tsx ? 'tsx' : 'ts', logLevel: 'silent' });
      return { ok: true };
    } catch (e) {
      const x = e && Array.isArray(e.errors) ? e.errors[0] : null;
      if (!x) return { skip: `esbuild failed to run: ${String((e && e.message) || e).slice(0, 120)}` };
      const line = x.location ? x.location.line : null;
      return { error: `${file}${line ? `:${line}` : ''} ${x.text}`.slice(0, 300), line, column: x.location ? x.location.column : null, message: x.text };
    }
  }
  if (tsx) return { skip: 'no .tsx parser: esbuild does not resolve (set AGENT_MANAGER_TS_TOOLS to a node_modules directory that has it)' };
  if (typeof nodeModule.stripTypeScriptTypes !== 'function') return { skip: 'no .ts parser: Node has no stripTypeScriptTypes and esbuild does not resolve' };
  try {
    nodeModule.stripTypeScriptTypes(String(text), { mode: 'transform' });
    return { ok: true };
  } catch (e) {
    const message = String((e && e.message) || e).split('\n')[0].slice(0, 200);
    return { error: `${file} ${message}`.slice(0, 300), line: null, column: null, message };
  }
}

module.exports = { checkTypeScript, resolveEsbuild, checkerFor, isModuleFormatAmbiguity, summarizeSyntaxError, resolvePython, PY_CHECK_SCRIPT };
