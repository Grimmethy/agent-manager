'use strict';

// edit-set-syntax.js -- does every file a Group B edit set creates or edits STILL PARSE?
//
// 2026-10-08 (TaxHarvest AC-271): an arch-review fix split an import (`from cadastral_utils import` / `from constants import X (`). The module could not
// be imported; the local reviewers approved it and it reached pending-merge. review-verify.js already has a changed-file syntax gate, but review-task.js
// runs it only for adhoc tasks that carry a rawDiff -- every source that submits a JSON edit set (arch_review, function_length_fix, observability_fix,
// change_review_fix, ...) got task.executedVerification = null, i.e. no syntax check at all. Measured on the 12 unmerged TaxHarvest branches: 5 files
// that can be parsed, 1 failing (AC-271's), plus 12 .ts/.tsx files nothing checked.
//
// Replays the set in apply order (lib/find-recheck.js simulateEditsDetailed) and parses the RESULTING text of each file with the language's own parser:
// python -> compile(); .js/.mjs/.cjs -> node --check; .json -> JSON.parse; .ts/.tsx -> lib/syntax-check.js checkTypeScript (esbuild or Node's own parser).
// Nothing is applied to the repo: every check runs on a temp copy. A failure counts only if the file parsed BEFORE the edit (the same base-vs-change
// rule as review-verify's gate); a file the set creates cannot be "already broken". No checker, no interpreter, a timeout or a module-format ambiguity
// is a SKIP with a reason, never a failure. Never throws.
//
// AGENT_MANAGER_EDIT_SYNTAX_GATE=block|advisory|off (default block).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { simulateEditsDetailed } = require('./find-recheck.js');
const { checkerFor, isModuleFormatAmbiguity, summarizeSyntaxError, resolvePython, checkTypeScript } = require('./syntax-check.js');

const CHECK_TIMEOUT_MS = 20000;
const EXCERPT_RADIUS = 3;
const EXCERPT_MAX_CHARS = 700;

function syntaxGateMode(env = process.env) {
  const v = String(env.AGENT_MANAGER_EDIT_SYNTAX_GATE || '').trim().toLowerCase();
  return v === 'advisory' || v === 'off' ? v : 'block';
}

// "type" of the nearest package.json at or above the file (inside repoRoot), so a temp copy of a .js file is classified CommonJS/ESM the way it is in place.
function nearestPackageType(repoRoot, file) {
  try {
    const root = path.resolve(repoRoot);
    let d = path.dirname(path.resolve(root, file));
    while (d.startsWith(root)) {
      const p = path.join(d, 'package.json');
      if (fs.existsSync(p)) { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return j && j.type === 'module' ? 'module' : 'commonjs'; }
      if (d === root) break;
      d = path.dirname(d);
    }
  } catch { /* default below */ }
  return 'commonjs';
}

// Parse one file's text. -> { ok: true } | { error, line, message } | { skip: reason }
function parseText(file, text, { repoRoot, env, py }) {
  const checker = checkerFor(file);
  if (!checker) return { skip: 'no syntax checker for this file type' };
  if (checker.kind === 'json') {
    try { JSON.parse(text); return { ok: true }; } catch (e) { return { error: `${file} ${String((e && e.message) || e).slice(0, 200)}`, line: null, message: String((e && e.message) || e).slice(0, 200) }; }
  }
  if (checker.kind === 'ts') {
    const r = checkTypeScript(file, text, { repoRoot, env });
    return r.ok ? { ok: true } : r;
  }
  if (checker.kind === 'python' && !py) return { skip: 'no python interpreter available' };
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-set-syntax-'));
    const target = path.join(tmp, path.basename(file));
    fs.writeFileSync(target, text);
    if (checker.kind === 'node') fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: nearestPackageType(repoRoot, file) }));
    const bin = checker.kind === 'python' ? py : process.execPath;
    const args = checker.kind === 'python' ? checker.args.slice(0, -1).concat(target) : ['--check', target];
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], cwd: tmp });
    if (r.error && r.error.code === 'ETIMEDOUT') return { skip: 'syntax check timed out' };
    if (r.error) return { skip: `checker could not run: ${String(r.error.message).slice(0, 100)}` };
    if (r.status === 0) return { ok: true };
    const output = `${r.stdout || ''}${r.stderr || ''}`.split(target).join(file);
    if (checker.kind === 'node' && isModuleFormatAmbiguity(output)) return { skip: 'module-format ambiguity (not a syntax error)' };
    const error = summarizeSyntaxError(output, file);
    const line = (error.match(/:(\d+)\s/) || [])[1];
    return { error, line: line ? parseInt(line, 10) : null, message: error };
  } catch (e) {
    return { skip: `checker could not run: ${String((e && e.message) || e).slice(0, 100)}` };
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

function excerptAround(text, line) {
  if (!line) return null;
  const lines = String(text).split('\n');
  const from = Math.max(0, line - 1 - EXCERPT_RADIUS);
  const to = Math.min(lines.length, line + EXCERPT_RADIUS);
  return lines.slice(from, to).map((l, i) => `${from + i + 1}| ${l}`).join('\n').slice(0, EXCERPT_MAX_CHARS);
}

/**
 * @param {Array<object>} items  parsed Group B change set
 * @param {string} repoRoot
 * @param {{ env?: object, py?: string|null, detailed?: object }} [o]  `detailed` = an already-computed simulateEditsDetailed result (same items)
 * @returns {{ checked: string[], skipped: Array<{file: string, reason: string}>, failed: Array<{file: string, error: string, line: (number|null), excerpt: (string|null)}>, preexisting: string[] }}
 */
function checkEditSetSyntax(items, repoRoot, { env = process.env, py, detailed } = {}) {
  const out = { checked: [], skipped: [], failed: [], preexisting: [] };
  try {
    const sim = detailed || simulateEditsDetailed(items, repoRoot);
    const pyBin = py === undefined ? resolvePython({ repoRoot }) : py;
    for (const f of sim.files) {
      if (f.text === null || f.text === undefined) continue; // deleted: nothing to parse
      const res = parseText(f.file, f.text, { repoRoot, env, py: pyBin });
      if (res.ok) { out.checked.push(f.file); continue; }
      if (res.skip) { out.skipped.push({ file: f.file, reason: res.skip }); continue; }
      // Parsed before the edit? A file that was already broken is not this edit set's failure; a created file cannot have been.
      if (f.base !== null && f.base !== undefined) {
        const onBase = parseText(f.file, f.base, { repoRoot, env, py: pyBin });
        if (onBase.error) { out.preexisting.push(f.file); continue; }
      }
      out.failed.push({ file: f.file, error: res.error, line: res.line || null, excerpt: excerptAround(f.text, res.line) });
    }
  } catch { return { checked: [], skipped: [], failed: [], preexisting: [] }; }
  return out;
}

// The text a fix call / redraft sees: the parser error and the lines of the RESULTING file around it.
function syntaxFeedbackFor(failed) {
  return failed.map((f) => {
    const ex = f.excerpt ? ` The file as this edit set would leave it reads, around line ${f.line}:\n${f.excerpt}\nChange the edit so the result parses (keep every untouched line exactly as it is).` : ' Change the edit so the result parses.';
    return `Applying this edit set leaves ${f.file} with a syntax error: ${f.error}.${ex}`;
  }).join('\n\n');
}

const syntaxSignature = (failed) => failed.map((f) => `${f.file}:${f.line || 0}`).sort().join('|');

module.exports = { checkEditSetSyntax, syntaxFeedbackFor, syntaxSignature, syntaxGateMode, parseText, nearestPackageType };
