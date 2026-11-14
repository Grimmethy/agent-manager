#!/usr/bin/env node
'use strict';

// Import-cycle ratchet for the Kernel's own source (roadmap step 1, piece P0).
//   node scripts/import-cycles.js            print the cycles and the problems; exit 0 clean, 1 with problems
//   node scripts/import-cycles.js --init     write config/import-cycles-allowlist.json from the current graph
//   node scripts/import-cycles.js --shrink   rewrite the allowlist to the current cycles; refuses (exit 1) when a current cycle is not inside an allowlisted one
// Nodes are the non-test .js files in src/, src/lib/ and src/sdk/. An edge is a require('<relative literal>'): STATIC at brace depth 0 (loaded when the file loads),
// LAZY inside any block or function body. Comments and strings are skipped by the repo's own tokenizer. The allowlist can only get smaller.

const fs = require('node:fs');
const path = require('node:path');
const { tokenizeJs } = require('../src/sdk/size-limits.js');

const SOURCE_DIRS = ['src', 'src/lib', 'src/sdk'];
const ALLOWLIST_REL = 'config/import-cycles-allowlist.json';

function repoRoot() {
  return process.env.AGENT_MANAGER_IMPORT_CYCLES_ROOT || path.resolve(__dirname, '..');
}

function allowlistPath(root = repoRoot()) {
  return process.env.AGENT_MANAGER_IMPORT_CYCLES_ALLOWLIST || path.join(root, ALLOWLIST_REL);
}

function listSourceFiles(root) {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).sort()) {
      const rel = `${dir}/${name}`;
      if (/\.js$/.test(name) && !/\.test\.js$/.test(name) && fs.statSync(path.join(root, rel)).isFile()) files.push(rel);
    }
  }
  return files;
}

function resolveSpec(from, spec, known) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const candidate of [base, `${base}.js`, `${base}/index.js`]) if (known.has(candidate)) return candidate;
  return null;
}

// -> the require('<literal>') calls of one file as [{ spec, depth }]; depth 0 is a static edge.
function requireCalls(text) {
  const tokens = tokenizeJs(text);
  const calls = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'symbol' && t.value === '{') depth++;
    else if (t.type === 'symbol' && t.value === '}') depth = Math.max(0, depth - 1);
    else if (t.type === 'identifier' && t.value === 'require' && tokens[i + 1] && tokens[i + 1].value === '(' &&
      tokens[i + 2] && tokens[i + 2].type === 'string' && tokens[i + 3] && tokens[i + 3].value === ')') {
      calls.push({ spec: tokens[i + 2].value.slice(1, -1), depth });
    }
  }
  return calls;
}

// -> { files, static: { file: [file] }, all: { file: [file] } } (all = static plus lazy).
function buildGraph(root = repoRoot()) {
  const files = listSourceFiles(root);
  const known = new Set(files);
  const stat = {};
  const all = {};
  for (const file of files) {
    stat[file] = new Set();
    all[file] = new Set();
    for (const call of requireCalls(fs.readFileSync(path.join(root, file), 'utf8'))) {
      const target = resolveSpec(file, call.spec, known);
      if (!target || target === file) continue;
      all[file].add(target);
      if (call.depth === 0) stat[file].add(target);
    }
  }
  const plain = (g) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, [...v].sort()]));
  return { files, static: plain(stat), all: plain(all) };
}

// Tarjan: strongly connected components of size > 1, members sorted, largest first (ties by first member).
function findCycles(adjacency) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const order = {};
  const low = {};
  const out = [];
  const visit = (v) => {
    order[v] = low[v] = index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency[v] || []) {
      if (order[w] === undefined) { visit(w); low[v] = Math.min(low[v], low[w]); }
      else if (onStack.has(w)) low[v] = Math.min(low[v], order[w]);
    }
    if (low[v] !== order[v]) return;
    const comp = [];
    let w;
    do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1) out.push(comp.sort());
  };
  for (const v of Object.keys(adjacency)) if (order[v] === undefined) visit(v);
  return out.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
}

const isSubset = (small, big) => small.every((x) => big.includes(x));
const sameSet = (a, b) => a.length === b.length && isSubset(a, b);
const label = (cycle) => `${cycle.length} files (${cycle.slice(0, 3).join(', ')}${cycle.length > 3 ? ', ...' : ''})`;

// -> readable problems. current = { static: [cycle], all: [cycle] } from findCycles; allowlist = { cycles: [cycle] }.
function checkCycles(current, allowlist) {
  const listed = (allowlist && allowlist.cycles) || [];
  const problems = [];
  for (const cycle of current.static) problems.push(`static import cycle (loaded when the files load): ${label(cycle)}; a static cycle is never allowed`);
  for (const cycle of current.all) {
    if (!listed.some((entry) => isSubset(cycle, entry))) problems.push(`import cycle is new or grew beyond the allowlist: ${label(cycle)}`);
  }
  for (const entry of listed) {
    if (!current.all.some((cycle) => sameSet(cycle, entry))) problems.push(`allowlisted cycle is stale (it shrank or is gone), run node scripts/import-cycles.js --shrink: ${label(entry)}`);
  }
  return problems;
}

function currentCycles(root = repoRoot()) {
  const graph = buildGraph(root);
  return { static: findCycles(graph.static), all: findCycles(graph.all) };
}

function readAllowlist(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { cycles: [] };
}

function writeAllowlist(file, cycles) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ cycles }, null, 2)}\n`);
}

function main(argv) {
  const root = repoRoot();
  const file = allowlistPath(root);
  const current = currentCycles(root);
  if (argv.includes('--init')) {
    writeAllowlist(file, current.all);
    console.log(`wrote ${current.all.length} cycle(s) to ${path.relative(root, file)}`);
    return 0;
  }
  if (argv.includes('--shrink')) {
    const listed = readAllowlist(file).cycles || [];
    const grown = current.all.filter((cycle) => !listed.some((entry) => isSubset(cycle, entry)));
    if (grown.length) { console.error(`refusing to shrink: ${grown.map(label).join('; ')} is not inside an allowlisted cycle`); return 1; }
    writeAllowlist(file, current.all);
    console.log(`allowlist now lists ${current.all.length} cycle(s)`);
    return 0;
  }
  const problems = checkCycles(current, readAllowlist(file));
  for (const cycle of current.all) console.log(`cycle: ${label(cycle)}`);
  for (const problem of problems) console.error(problem);
  return problems.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { buildGraph, findCycles, checkCycles, currentCycles, requireCalls, allowlistPath, repoRoot };
