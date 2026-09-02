#!/usr/bin/env node
'use strict';

// One-time: consolidate the Second Brain vault onto the canonical top-level taxonomy that
// src/brain-dump-sort-classify.js's validateSecondBrainPath now enforces. The vault is NOT
// a git repo, so this logs every move and never overwrites -- a colliding incoming file is
// renamed `<stem>-<sourcefolder>.md`.
//
//   node scripts/migrate-second-brain-taxonomy.js            # dry-run (default) -- writes nothing
//   node scripts/migrate-second-brain-taxonomy.js --apply
//
// Idempotent: --apply drops `.agent-manager-taxonomy-migrated`; a second run (source dirs
// gone) is a no-op. Machine-written trees (Agent Manager Reports/, Model Benchmarks/,
// OrnithDebug/) are deliberately left untouched -- see brain-dump-sort-classify.js.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config.js');

const APPLY = process.argv.includes('--apply');

// Ordered prefix-rewrite rules applied to each note's vault-relative path. First match wins.
// A path whose first segment is already canonical (or a left-alone machine dir) matches nothing.
const RULES = [
  [/^agent_manager\//, 'agent-manager/'],
  [/^Projects\/agent-manager\/(tasks|bugs|issues)\/completed\//, 'agent-manager/archive/'],
  [/^Projects\/agent-manager\//, 'agent-manager/'],
  [/^agent-manager\/journal\//, 'Journal/agent-manager/'],
  [/^journal\//, 'Journal/'],
  [/^Reference\//, 'References/'],
  [/^references\//, 'References/'],
  [/^Hardware\//, 'References/hardware/'],
  [/^ideas\//, 'Ideas/'],
  [/^AdProjects\//, 'Projects/AdProjects/'],
  [/^property-forager\//, 'Projects/property-forager/'],
  [/^OrnithDebug\//, 'References/ornith-debug/'],
];

const LEAVE_ALONE_TOP = new Set(['Agent Manager Reports', 'Model Benchmarks', 'ModelBenchmarks', 'AgentManagerReports']);

function listNotes(root) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!rel && LEAVE_ALONE_TOP.has(e.name)) continue;
        walk(childRel);
      } else {
        out.push(childRel);
      }
    }
  };
  walk('');
  return out;
}

function targetFor(relPath) {
  for (const [re, repl] of RULES) {
    if (re.test(relPath)) return relPath.replace(re, repl);
  }
  // A bare vault-root .md file (no folder) that isn't already handled -> Journal if dated, else Characters.
  if (!relPath.includes('/') && relPath.endsWith('.md')) {
    return (/\b20\d\d[-_]\d\d[-_]\d\d\b/.test(relPath) ? 'Journal/' : 'Characters/') + relPath;
  }
  return null; // already canonical / left alone
}

function main() {
  const { secondBrainDir } = getConfig();
  if (!secondBrainDir || !fs.existsSync(secondBrainDir)) {
    console.error(`SECOND_BRAIN_DIR not found: ${secondBrainDir}`);
    process.exit(1);
  }
  const marker = path.join(secondBrainDir, '.agent-manager-taxonomy-migrated');
  if (fs.existsSync(marker) && !process.argv.includes('--force')) {
    console.log(`already migrated (${marker}); pass --force to run again`);
    return;
  }

  const notes = listNotes(secondBrainDir);
  let moves = 0; let collisions = 0;
  const emptyDirs = new Set();

  for (const rel of notes) {
    const tgt = targetFor(rel);
    if (!tgt || tgt === rel) continue;

    let destRel = tgt;
    const destAbs = () => path.join(secondBrainDir, destRel);
    if (fs.existsSync(destAbs())) {
      const srcFolder = path.dirname(rel).split('/').pop() || 'root';
      const stem = path.basename(destRel, '.md');
      destRel = path.join(path.dirname(destRel), `${stem}-${srcFolder}.md`).replace(/\\/g, '/');
      collisions += 1;
      console.log(`  COLLISION ${rel}  ->  ${destRel}  (target existed)`);
    } else {
      console.log(`  ${APPLY ? 'move' : 'would move'}  ${rel}  ->  ${destRel}`);
    }
    moves += 1;
    emptyDirs.add(path.dirname(rel));

    if (APPLY) {
      fs.mkdirSync(path.dirname(destAbs()), { recursive: true });
      fs.renameSync(path.join(secondBrainDir, rel), destAbs());
    }
  }

  // Remove now-empty legacy dirs (deepest first).
  if (APPLY) {
    for (const d of [...emptyDirs].sort((a, b) => b.length - a.length)) {
      let cur = d;
      while (cur && cur !== '.') {
        const abs = path.join(secondBrainDir, cur);
        try {
          if (fs.readdirSync(abs).length === 0) { fs.rmdirSync(abs); console.log(`  rmdir ${cur}`); }
        } catch { /* not empty or gone */ }
        cur = path.dirname(cur);
      }
    }
    // project-links: rewrite any key whose target moved (expected: none, since Projects/GitHub/ is preserved).
    const linksPath = path.join(secondBrainDir, '.agent-manager-project-links.json');
    try {
      const links = JSON.parse(fs.readFileSync(linksPath, 'utf8'));
      let changed = false;
      for (const k of Object.keys(links)) {
        const t = targetFor(k);
        if (t && t !== k) { links[t] = links[k]; delete links[k]; changed = true; console.log(`  project-link key ${k} -> ${t}`); }
      }
      if (changed) fs.writeFileSync(linksPath, JSON.stringify(links, null, 2));
    } catch { /* no links file */ }

    fs.writeFileSync(marker, new Date().toISOString() + '\n');
  }

  console.log(`\n${APPLY ? 'done' : 'dry-run'}: ${moves} move(s), ${collisions} collision-rename(s), ${notes.length} notes scanned`);
  if (!APPLY) console.log('re-run with --apply to execute');
}

main();
