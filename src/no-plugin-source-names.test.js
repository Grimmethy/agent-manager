'use strict';

// ADR-0022 invariant guard: core production code must not name a plugin-owned task source.
// Every behaviour that used to switch on `task.source === 'arch_review'` (etc.) now reads a
// field off the source's registration (directToMain, reviewGuidance, reportClass,
// harnessSearch, ...) or a purpose-built registry (deterministic-recheck-registry). A new
// literal creeping back in is the exact regression this test exists to catch.
//
// Scope: src/**/*.js and scripts/*.js, production only (test files legitimately name sources to build fixtures).
// Comments are stripped before matching -- prose references are fine, code is not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Sources owned by agent-manager-hygiene (and its legacy task-label alias).
const PLUGIN_SOURCE_NAMES = [
  'observability_review', 'observability_fix',
  'performance_review', 'performance_fix',
  'function_length_review', 'function_length_fix',
  'arch_discovery', 'arch_review', 'arch_import', 'arch_import_review',
  'unused_export', 'deadcode_triage',
];

// arch-discovery-structcheck.js is invoked by hardcoded path from src/local-worker.ps1 (the
// Windows worker) and is arch-specific by nature -- a documented, single-file exception (see
// docs/PLUGIN_API.md "Known warts"). It carries no behaviour the pipeline reaches on the
// Linux path.
const ALLOWLIST = new Set(['arch-discovery-structcheck.js']);

// A real (small) scanner, not regexes: a comment stripper that does not know about strings is wrong in both directions.
// The old two-regex version treated `//  ...queue/*-flags.json...` (a `/*` INSIDE a line comment) as the start of a block
// comment and silently swallowed everything up to the next `*/` -- so a file could name a plugin source in code and never be
// reported (hygiene-inventory.js hid all but two of its names). This walks the source once: comments are dropped, string /
// template / regex-literal bodies are kept verbatim (the check matches quoted names, so strings must survive) and their
// contents never start a comment.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSig = ''; // last significant char emitted -- decides whether a `/` starts a regex literal or is division
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const end = src.indexOf('*/', i + 2); i = end === -1 ? n : end + 2; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; lastSig = c; continue;
    }
    if (c === '/' && (lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig))) { // regex literal
      let j = i + 1; let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false; else if (src[j] === '/' && !inClass) break;
        j++;
      }
      out += src.slice(i, j + 1); i = j + 1; lastSig = '/'; continue;
    }
    out += c; if (!/\s/.test(c)) lastSig = c; i++;
  }
  return out;
}

test('stripComments: drops comments, keeps strings/regexes, and a `/*` inside a line comment or string does not swallow code', () => {
  const src = [
    "const a = 1; // queue/*-flags.json is the file",
    "const b = 'arch_review'; /* block 'arch_import' */ const c = \"unused_export\";",
    "const d = 'queue/*.json'; const e = 'function_length_review';",
    "const re = /['\"]\\/\\*/; const f = 'observability_fix';",
    "const url = 'http://x'; const g = `tpl // not a comment ${1}`; const h = 4 / 2 / 1;",
    "// trailing 'performance_fix'",
  ].join('\n');
  const out = stripComments(src);
  for (const kept of ["'arch_review'", '"unused_export"', "'function_length_review'", "'observability_fix'", "'http://x'", '`tpl // not a comment ${1}`', 'const h = 4 / 2 / 1;']) assert.ok(out.includes(kept), `kept: ${kept}`);
  for (const dropped of ["'arch_import'", "'performance_fix'", 'flags.json is the file']) assert.ok(!out.includes(dropped), `dropped: ${dropped}`);
});

test('no core src/*.js production file names a plugin-owned task source', () => {
  // src/ recursively (src/lib, src/sdk/... used to be invisible to this guard) plus scripts/.
  const root = path.join(__dirname, '..');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name)))
    : [path.join(dir, e.name)]));
  const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'scripts'))]
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !ALLOWLIST.has(path.basename(f)))
    .map((f) => path.relative(path.join(root, 'src'), f));

  const offenders = [];
  for (const f of files) {
    const code = stripComments(fs.readFileSync(path.join(root, 'src', f), 'utf8'));
    for (const name of PLUGIN_SOURCE_NAMES) {
      // The name as a STANDALONE quoted string -- `=== 'arch_review'`, an object key,
      // `.includes('arch_import')`, array membership. A prose mention inside a longer
      // string (a self-audit message citing a past incident) is not the target.
      const re = new RegExp(`(['"\`])${name}\\1`);
      if (re.test(code)) offenders.push(`${f}: ${name}`);
    }
  }

  assert.deepEqual(offenders, [], `core code must not name a plugin source -- move the behaviour onto the registration:\n  ${offenders.join('\n  ')}`);
});
