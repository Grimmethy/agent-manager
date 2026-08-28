'use strict';

// ADR-0022 invariant guard: core production code must not name a plugin-owned task source.
// Every behaviour that used to switch on `task.source === 'arch_review'` (etc.) now reads a
// field off the source's registration (directToMain, reviewGuidance, reportClass,
// harnessSearch, ...) or a purpose-built registry (deterministic-recheck-registry). A new
// literal creeping back in is the exact regression this test exists to catch.
//
// Scope: src/*.js, production only (test files legitimately name sources to build fixtures).
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

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // line comments (not matching http://)
}

test('no core src/*.js production file names a plugin-owned task source', () => {
  const srcDir = __dirname;
  const files = fs.readdirSync(srcDir)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !ALLOWLIST.has(f));

  const offenders = [];
  for (const f of files) {
    const code = stripComments(fs.readFileSync(path.join(srcDir, f), 'utf8'));
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
