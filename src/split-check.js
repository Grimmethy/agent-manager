'use strict';

// split-check.js -- deterministic check of a split (a parent task divided into child tasks) before the split branch is pushed.
// Spec: { root?, parentFiles: [path], children: [{ id, files: [path], removes?: [symbol], changesSignature?: [symbol], keepsOldSignature?: boolean, dependsOn?: [id] }] }
// Paths are relative to spec.root, which is itself relative to the spec file's directory (default: the spec's directory).
// Rules:
//  nonexistent-file: a child file that does not exist must sit in a directory that already holds files or a sibling listed file.
//  unordered-reference: a child that removes a symbol leaves no other child's file still using it unless that child depends on the remover.
//  signature-change-unmigrated: a child that changes a signature (and does not keep the old one) must be depended on by every other child still using it.
// Uses only fs and path: no timers, no subprocesses.

const fs = require('fs');
const path = require('path');

const IDENT_CHAR = /[A-Za-z0-9_$]/;

function isIdentChar(ch) { return !!ch && IDENT_CHAR.test(ch); }

// Whole-word search without a regex, so a symbol is matched as an identifier (legacyHelper does not match legacyHelperV2).
function hasWord(text, sym) {
  if (!sym) return false;
  let i = text.indexOf(sym);
  while (i !== -1) {
    if (!isIdentChar(text[i - 1]) && !isIdentChar(text[i + sym.length])) return true;
    i = text.indexOf(sym, i + 1);
  }
  return false;
}

function readText(abs) {
  try { return fs.readFileSync(abs, 'utf8'); } catch (_) { return null; }
}

// For each child id: the set of child ids it depends on, directly or transitively.
function dependencyClosure(children) {
  const byId = new Map(children.map((c) => [c.id, c]));
  const out = new Map();
  for (const c of children) {
    const seen = new Set();
    const stack = [...(c.dependsOn || [])];
    while (stack.length > 0) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const d = byId.get(id);
      if (d) stack.push(...(d.dependsOn || []));
    }
    out.set(c.id, seen);
  }
  return out;
}

function checkSpec(spec, rootDir) {
  const children = Array.isArray(spec.children) ? spec.children : [];
  const parentFiles = Array.isArray(spec.parentFiles) ? spec.parentFiles : [];
  const deps = dependencyClosure(children);
  const candidates = [...new Set([...parentFiles, ...children.flatMap((c) => c.files || [])])];
  const violations = [];

  const cache = new Map();
  const contentOf = (rel) => {
    if (!cache.has(rel)) cache.set(rel, readText(path.join(rootDir, rel)));
    return cache.get(rel);
  };

  // Rule 1: every child file exists, or is a new path next to a sibling.
  for (const c of children) {
    for (const f of c.files || []) {
      if (fs.existsSync(path.join(rootDir, f))) continue;
      const dir = path.dirname(f);
      let dirHasFiles = false;
      try { dirHasFiles = fs.readdirSync(path.join(rootDir, dir)).length > 0; } catch (_) { dirHasFiles = false; }
      const listedSibling = candidates.some((o) => o !== f && path.dirname(o) === dir);
      if (!dirHasFiles && !listedSibling) {
        violations.push({ kind: 'nonexistent-file', child: c.id, message: `${f} does not exist and no sibling file lives in ${dir}/` });
      }
    }
  }

  // Rules 2 and 3: a symbol that a child removes or changes is still used by a file owned by a child that does not depend on it.
  const scan = (changer, sym, kind, describe) => {
    for (const rel of candidates) {
      if ((changer.files || []).includes(rel)) continue;
      const body = contentOf(rel);
      if (body === null || !hasWord(body, sym)) continue;
      for (const owner of children) {
        if (owner.id === changer.id || !(owner.files || []).includes(rel)) continue;
        if (deps.get(owner.id).has(changer.id)) continue;
        violations.push({ kind, child: owner.id, message: describe(owner.id, rel, sym, changer.id) });
      }
    }
  };
  for (const c of children) {
    for (const sym of c.removes || []) {
      scan(c, sym, 'unordered-reference', (o, rel, s, r) => `${o} still references '${s}' in ${rel}, but ${r} removes it and ${o} does not depend on ${r}`);
    }
    if (!c.keepsOldSignature) {
      for (const sym of c.changesSignature || []) {
        scan(c, sym, 'signature-change-unmigrated', (o, rel, s, r) => `${o} uses '${s}' in ${rel}, but ${r} changes its signature without keeping the old one and ${o} does not depend on ${r}`);
      }
    }
  }
  return violations;
}

function loadSpec(file) {
  const abs = path.resolve(file);
  const spec = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const rootDir = path.resolve(path.dirname(abs), spec.root || '.');
  return { spec, rootDir };
}

module.exports = { checkSpec, loadSpec };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node src/split-check.js <split-spec.json>');
    process.exit(2);
  }
  const { spec, rootDir } = loadSpec(file);
  const violations = checkSpec(spec, rootDir);
  for (const v of violations) console.log(`${v.kind} [${v.child}] ${v.message}`);
  console.log(violations.length === 0 ? 'split-check: ok' : `split-check: ${violations.length} violation(s)`);
  process.exit(violations.length > 0 ? 1 : 0);
}
