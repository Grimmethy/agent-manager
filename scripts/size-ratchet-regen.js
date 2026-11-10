#!/usr/bin/env node
'use strict';

// Size ratchet allowlist. The allowlist freezes the EXISTING offenders: source files over the file limit and functions over the function limit, each with its
// current line count as a cap. A listed entry may only get smaller (a regen lowers its cap or drops it once it is back under the limit); nothing is added
// except by --init. Limits come from src/sdk/size-limits.js (AGENT_MANAGER_MAX_FILE_LINES, AGENT_MANAGER_MAX_FUNCTION_LINES).
//   node scripts/size-ratchet-regen.js --init   write a fresh allowlist from the current offenders
//   node scripts/size-ratchet-regen.js          lower-only regen; exit 1 (and list them) if there is an offender that is not on the allowlist
// Test hooks: AGENT_MANAGER_SIZE_RATCHET_ROOT (the tree to scan) and AGENT_MANAGER_SIZE_RATCHET_ALLOWLIST (the allowlist file).

const fs = require('node:fs');
const path = require('node:path');
const { findLongFiles, findLongFunctions } = require('../src/sdk/size-limits.js');

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py']);
const FILE_LIMIT = () => Number(process.env.AGENT_MANAGER_MAX_FILE_LINES) || 500;
const FUNCTION_LIMIT = () => Number(process.env.AGENT_MANAGER_MAX_FUNCTION_LINES) || 100;
const repoRoot = () => process.env.AGENT_MANAGER_SIZE_RATCHET_ROOT || path.resolve(__dirname, '..');
const allowlistPath = () => process.env.AGENT_MANAGER_SIZE_RATCHET_ALLOWLIST || path.join(__dirname, '..', 'config', 'size-ratchet-allowlist.json');

// -> { files: {path: lines}, functions: {"path::name": lines} } for everything currently over a limit, source files only.
function scanOffenders(root, limits) {
  const maxFileLines = (limits && limits.maxFileLines) || FILE_LIMIT();
  const maxFunctionLines = (limits && limits.maxFunctionLines) || FUNCTION_LIMIT();
  const out = { files: {}, functions: {} };
  for (const f of findLongFiles(root, { maxLines: maxFileLines })) {
    if (SOURCE_EXT.has(path.extname(f.path).toLowerCase())) out.files[f.path] = f.lines;
  }
  for (const rel of listSourceFiles(root)) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    for (const fn of findLongFunctions(text, rel, { maxLines: maxFunctionLines })) {
      const key = `${rel}::${fn.name || '<anonymous>'}`;
      out.functions[key] = Math.max(out.functions[key] || 0, fn.lines);
    }
  }
  return out;
}

const WALK_SKIP = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build', '.next', '.turbo']);
function listSourceFiles(root) {
  const found = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!WALK_SKIP.has(e.name)) walk(full); }
      else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name).toLowerCase())) found.push(path.relative(root, full));
    }
  })(root);
  return found;
}

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// Lower-only merge: keep each listed entry only while it is still an offender, at min(old cap, current lines). Offenders that are not listed are returned in `unlisted`.
function lowerOnly(existing, current) {
  const next = { files: {}, functions: {} };
  const unlisted = [];
  for (const kind of ['files', 'functions']) {
    for (const [key, lines] of Object.entries(current[kind])) {
      const cap = (existing[kind] || {})[key];
      if (cap === undefined) unlisted.push(`${kind === 'files' ? 'file' : 'function'} ${key} (${lines} lines)`);
      else next[kind][key] = Math.min(cap, lines);
    }
  }
  return { next: { files: sortKeys(next.files), functions: sortKeys(next.functions) }, unlisted };
}

function main(argv) {
  const target = allowlistPath();
  const current = scanOffenders(repoRoot());
  if (argv.includes('--init')) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ files: sortKeys(current.files), functions: sortKeys(current.functions) }, null, 2) + '\n');
    console.log(`allowlist written: ${Object.keys(current.files).length} files, ${Object.keys(current.functions).length} functions -> ${target}`);
    return 0;
  }
  const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
  const { next, unlisted } = lowerOnly(existing, current);
  fs.writeFileSync(target, JSON.stringify(next, null, 2) + '\n');
  console.log(`allowlist lowered: ${Object.keys(next.files).length} files, ${Object.keys(next.functions).length} functions`);
  if (unlisted.length) { console.error('offenders not on the allowlist (only --init adds entries):\n  ' + unlisted.join('\n  ')); return 1; }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { scanOffenders, lowerOnly, allowlistPath, repoRoot };
