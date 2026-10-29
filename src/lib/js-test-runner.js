'use strict';

// js-test-runner.js -- which runner executes a JS/TS test file: node:test, vitest, or none.
//
// 2026-10-08 (TaxHarvest): review-verify ran EVERY covering JS test with `node --test`, which cannot execute .tsx (ERR_UNKNOWN_FILE_EXTENSION), so a frontend
// test could never be verified; the frontend had no runner at all (121 .tsx/.ts source files, 0 tests) until vitest was added to its package.json. The runner
// is chosen per FILE from the package that owns it (nearest package.json up to the repo root), never guessed:
//   .ts/.tsx/.jsx  vitest when the package declares it; otherwise 'none' (node cannot run them, and a stated reason beats a spurious failure)
//   .js/.mjs/.cjs vitest when the package declares it AND the file imports 'vitest'; otherwise node:test (unchanged behaviour)
// Reads package.json / the test file from `root` (the review worktree, so a diff that adds the runner counts). Never throws.

const fs = require('fs');
const path = require('path');

const TS_LIKE = /\.(?:tsx?|jsx)$/i;
const VITEST_IMPORT = /from\s+['"]vitest['"]|require\(\s*['"]vitest['"]\s*\)/;

const posix = (p) => String(p).replace(/\\/g, '/');

// -> { pkgRel, pkg } for the nearest package.json at or above the file ('' = the repo root), or null.
function nearestPackage(root, relFile) {
  try {
    let dir = posix(path.dirname(relFile));
    for (;;) {
      const p = path.join(root, dir === '.' ? '' : dir, 'package.json');
      if (fs.existsSync(p)) return { pkgRel: dir === '.' ? '' : dir, pkg: JSON.parse(fs.readFileSync(p, 'utf8')) };
      if (dir === '.' || dir === '' || dir === '/') return null;
      dir = posix(path.dirname(dir));
    }
  } catch { return null; }
}

const declares = (pkg, name) => !!pkg && !!((pkg.dependencies && pkg.dependencies[name]) || (pkg.devDependencies && pkg.devDependencies[name]));

/** -> { kind: 'vitest'|'node-test'|'none', pkgRel, reason? } */
function runnerFor(root, relFile) {
  const owner = nearestPackage(root, relFile);
  const pkgRel = owner ? owner.pkgRel : '';
  const hasVitest = owner ? declares(owner.pkg, 'vitest') : false;
  if (TS_LIKE.test(relFile)) {
    return hasVitest ? { kind: 'vitest', pkgRel } : { kind: 'none', pkgRel, reason: `node:test cannot run ${path.extname(relFile)} and ${pkgRel || 'the repo root'} declares no test runner (vitest)` };
  }
  if (hasVitest) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, relFile), 'utf8'); } catch { /* unreadable: treat as node:test */ }
    if (VITEST_IMPORT.test(text)) return { kind: 'vitest', pkgRel };
  }
  return { kind: 'node-test', pkgRel };
}

// Splits test files into { nodeTest: [files], vitest: Map(pkgRel -> files), none: [{file, reason}] }.
function partitionJsTests(root, files) {
  const out = { nodeTest: [], vitest: new Map(), none: [] };
  for (const f of files || []) {
    const r = runnerFor(root, f);
    if (r.kind === 'node-test') out.nodeTest.push(f);
    else if (r.kind === 'vitest') { if (!out.vitest.has(r.pkgRel)) out.vitest.set(r.pkgRel, []); out.vitest.get(r.pkgRel).push(f); }
    else out.none.push({ file: f, reason: r.reason });
  }
  return out;
}

// vitest is started through node on its own entry point (no .bin symlink, no shell); cwd is the package dir, so the paths it gets are package-relative.
const vitestEntry = (pkgRel) => 'node_modules/vitest/vitest.mjs';
function vitestArgs(pkgRel, files) {
  const rel = (f) => posix(path.relative(pkgRel || '.', f));
  return [vitestEntry(pkgRel), 'run', '--reporter=default', ...files.map(rel)];
}

// Names of failing tests from vitest's default reporter: lines like ` FAIL  src/a.test.tsx > Toast > dismisses`. Unique, bounded.
function parseVitestFailures(output) {
  const out = [];
  for (const line of String(output || '').split('\n')) {
    const m = line.match(/^\s*FAIL\s+(\S.*?)\s*$/);
    if (m && !out.includes(m[1])) out.push(m[1].slice(0, 200));
  }
  return out.slice(0, 20);
}

module.exports = { nearestPackage, runnerFor, partitionJsTests, vitestArgs, vitestEntry, parseVitestFailures };
