#!/usr/bin/env node
'use strict';

// hub-branch-assumptions: read-only scan that regenerates the evidence block in Docs/PARALLEL_HUB_BRANCHES.md.
//   node scripts/hub-branch-assumptions.js <root dir>
// Rows are `path:line  term  snippet`, sorted by path then line. Only the text between the
// HUB-BRANCH-ASSUMPTIONS markers is replaced (markers are appended if absent). No other file is written.

const realFs = require('fs');
const path = require('path');

const PATTERNS = ['agent/decompose-', 'hubSiblingConflicts', 'readyToMerge', 'hub_for_branch'];
const TOP_DIRS = ['src', 'python', 'scripts'];
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', '.venv',
  'project_cache', '.agent-manager-cache', 'graphify-out',
]);
const MAX_BYTES = 1048576;
const MAX_TEXT = 160;
const DOC_REL = 'Docs/PARALLEL_HUB_BRANCHES.md';
const START = '<!-- HUB-BRANCH-ASSUMPTIONS:START -->';
const END = '<!-- HUB-BRANCH-ASSUMPTIONS:END -->';
const USAGE = 'usage: node scripts/hub-branch-assumptions.js <root dir>';

function walk(fs, dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.venv-broken-')) continue;
      walk(fs, full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function collectRows(root, deps) {
  const fs = (deps && deps.fs) || realFs;
  const files = [];
  for (const top of TOP_DIRS) walk(fs, path.join(root, top), files);
  const rows = [];
  for (const file of files) {
    let buf;
    try {
      if (fs.statSync(file).size > MAX_BYTES) continue;
      buf = fs.readFileSync(file);
    } catch (_) { continue; }
    if (buf.length > MAX_BYTES || buf.includes(0)) continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const term of PATTERNS) {
        if (lines[i].includes(term)) {
          rows.push({ path: rel, line: i + 1, term, text: lines[i].trim().slice(0, MAX_TEXT) });
        }
      }
    }
  }
  rows.sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.term, b.term));
  return rows;
}

function formatRows(rows) {
  return rows.map((r) => r.path + ':' + r.line + '  ' + r.term + '  ' + r.text);
}

function buildBlock(rows) {
  const body = rows.length ? ['```text', ...formatRows(rows), '```'].join('\n') : '(none)';
  return START + '\n' + body + '\n' + END;
}

function count(s, needle) {
  let n = 0;
  let i = s.indexOf(needle);
  while (i !== -1) { n++; i = s.indexOf(needle, i + needle.length); }
  return n;
}

// Returns the new doc text, or throws if the existing markers are malformed.
function spliceBlock(existing, block) {
  if (existing === null || existing === undefined || existing === '') return block + '\n';
  const nStart = count(existing, START);
  const nEnd = count(existing, END);
  if (nStart === 0 && nEnd === 0) {
    return existing.replace(/\n+$/, '') + '\n\n' + block + '\n';
  }
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  if (nStart !== 1 || nEnd !== 1 || e < s) {
    throw new Error('malformed HUB-BRANCH-ASSUMPTIONS markers in ' + DOC_REL + ' (need exactly one START before one END)');
  }
  return existing.slice(0, s) + block + existing.slice(e + END.length);
}

function run(root, deps) {
  const fs = (deps && deps.fs) || realFs;
  const rows = collectRows(root, deps);
  const docPath = path.join(root, DOC_REL);
  let existing = null;
  try { existing = fs.readFileSync(docPath, 'utf8'); } catch (_) { existing = null; }
  const next = spliceBlock(existing, buildBlock(rows));
  if (next !== existing) {
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, next);
  }
  return { rows: rows.length, changed: next !== existing };
}

function main(argv, io) {
  const stderr = (io && io.stderr) || process.stderr;
  let root = null;
  if (argv.length === 1) {
    root = path.resolve(argv[0]);
    try { if (!realFs.statSync(root).isDirectory()) root = null; } catch (_) { root = null; }
  }
  if (!root) { stderr.write(USAGE + '\n'); return 2; }
  try {
    run(root);
  } catch (err) {
    stderr.write(err.message + '\n');
    return 1;
  }
  return 0;
}

module.exports = { collectRows, formatRows, spliceBlock, buildBlock, run, main, START, END, PATTERNS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
