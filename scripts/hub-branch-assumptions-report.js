#!/usr/bin/env node
'use strict';

// hub-branch-assumptions-report: generates the evidence table for the separate-branches hub investigation (FF-4).
// One `path:line -- text` row for EVERY occurrence of each literal pattern under <root>/src, <root>/python, <root>/scripts.
//   node scripts/hub-branch-assumptions-report.js [--root <repo dir>] [--out <file>]

const realFs = require('fs');
const path = require('path');

const PATTERNS = ['agent/decompose-', 'hubSiblingConflicts', 'readyToMerge', 'hub_for_branch'];
const TOP_DIRS = ['src', 'python', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git']);
const MAX_BYTES = 1048576;
const MAX_TEXT = 160;
const USAGE = 'usage: node scripts/hub-branch-assumptions-report.js [--root <repo dir>] [--out <file>]';

function walk(fs, dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(fs, full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
}

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
      for (const pattern of PATTERNS) {
        if (lines[i].includes(pattern)) {
          rows.push({ pattern, path: rel, line: i + 1, text: lines[i].trim().slice(0, MAX_TEXT) });
        }
      }
    }
  }
  return rows;
}

function buildReport(root, deps) {
  const rows = collectRows(root, deps);
  const out = ['# Hub branch assumptions (generated)', ''];
  let grand = 0;
  for (const pattern of PATTERNS) {
    const mine = rows.filter((r) => r.pattern === pattern);
    mine.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
    out.push('## ' + pattern, '');
    for (const r of mine) out.push('- ' + r.path + ':' + r.line + ' -- ' + r.text);
    if (mine.length) out.push('');
    out.push('Total: ' + mine.length + ' rows', '');
    grand += mine.length;
  }
  out.push('Grand total: ' + grand);
  return out.join('\n') + '\n';
}

function parseArgs(argv) {
  const opts = { root: path.resolve(__dirname, '..'), out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '--out') {
      const v = argv[i + 1];
      if (v === undefined) return null;
      opts[a.slice(2)] = v;
      i++;
    } else {
      return null;
    }
  }
  return opts;
}

function main(argv, io) {
  const stdout = (io && io.stdout) || process.stdout;
  const stderr = (io && io.stderr) || process.stderr;
  const opts = parseArgs(argv);
  let ok = !!opts;
  if (ok) {
    try { ok = realFs.statSync(opts.root).isDirectory(); } catch (_) { ok = false; }
  }
  if (!ok) { stderr.write(USAGE + '\n'); return 2; }
  const report = buildReport(opts.root);
  if (opts.out) {
    realFs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    realFs.writeFileSync(opts.out, report);
  } else {
    stdout.write(report);
  }
  return 0;
}

module.exports = { buildReport, main, PATTERNS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
