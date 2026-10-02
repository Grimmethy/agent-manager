'use strict';

// Regression (2026-10-02, HUB0122 2/4): the brain-dump premise "these Files hint files
// are where the work happens" was never checked against the files' actual content, so a
// hint pointing at an unrelated module survived 9 drafting attempts unnoticed. These
// three cases mirror the incident and pin the three verdicts of
// src/files-hint-premise-check.js: 'wrong-file' (keyword in another repo file ->
// suggestedFiles), 'ok' (keyword in the named file), 'not-found' (keyword nowhere).
// Harness pattern mirrors src/entry-points-register.test.js (node:test, mkdtemp fixture,
// teardown in finally).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { checkFilesHintPremise } = require('./files-hint-premise-check.js');

// Distinctive keyword (>=6 chars, non-stop-word) that a real description would carry.
// It appears only in the stub file this test writes, never in the repo under test.
const TRACE_SPAN_DROP = 'traceSpanDrop';
// A second distinctive keyword that appears in NO fixture file at all.
const GHOST_SYMBOL = 'ghostSymbol';
const STUB_FILE_REL = 'observability-review.js';

// Write a temp dir (mocked plugin-repo root) containing the stub file with the keyword.
function setupFixtureWithStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-hint-premise-'));
  fs.writeFileSync(
    path.join(dir, STUB_FILE_REL),
    `'use strict';\n// span instrumentation\nexport function ${TRACE_SPAN_DROP}(span) {\n  return span;\n}\n`,
    'utf8'
  );
  return dir;
}

function teardown(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// The module's DI seam: ctx.resolveAccessibleRoots() is what it calls to enumerate
// accessible roots, so we stub it to return our fixture dir.
function rootsCtx(dir) {
  return { resolveAccessibleRoots: () => [dir] };
}

test('keyword absent in named file but present in a mocked plugin-repo file -> verdict wrong-file with suggestedFiles', () => {
  const dir = setupFixtureWithStub();
  try {
    const entry = {
      description: `Drop spans via ${TRACE_SPAN_DROP} when the harness tears down.`,
      filesHint: 'other-module.js', // named file does not exist in the fixture
    };
    const result = checkFilesHintPremise(entry, rootsCtx(dir));
    assert.equal(result.verdict, 'wrong-file');
    assert.ok(Array.isArray(result.suggestedFiles), 'suggestedFiles must be an array');
    assert.ok(
      result.suggestedFiles.some((f) => f.includes(STUB_FILE_REL)),
      `suggestedFiles must include the stub ${STUB_FILE_REL}, got: ${JSON.stringify(result.suggestedFiles)}`
    );
  } finally {
    teardown(dir);
  }
});

test('keyword present in the named file -> verdict ok', () => {
  const dir = setupFixtureWithStub();
  try {
    const entry = {
      description: `Drop spans via ${TRACE_SPAN_DROP} when the harness tears down.`,
      filesHint: STUB_FILE_REL, // exists in the fixture and contains the keyword
    };
    const result = checkFilesHintPremise(entry, rootsCtx(dir));
    assert.equal(result.verdict, 'ok');
  } finally {
    teardown(dir);
  }
});

test('file missing and keyword absent everywhere -> verdict not-found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-hint-premise-'));
  fs.writeFileSync(
    path.join(dir, 'unrelated.js'),
    `'use strict';\n// an unrelated stub -- no relevant symbols here\nexport const filler = 1;\n`,
    'utf8'
  );
  try {
    const entry = {
      description: `Wire up ${GHOST_SYMBOL} for span instrumentation.`,
      filesHint: 'ghost-file.js', // missing, and the keyword is in no fixture file
    };
    const result = checkFilesHintPremise(entry, rootsCtx(dir));
    assert.equal(result.verdict, 'not-found');
  } finally {
    teardown(dir);
  }
});
