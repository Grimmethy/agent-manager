'use strict';

// Unit tests for cited-code-liveness-check.js -- the deterministic pre-check that
// verifies a candidate's cited file (and optional symbol) still exists in the repo.
//
// Run: node --test src/cited-code-liveness-check.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { checkCitedCodeLiveness } = require('./cited-code-liveness-check.js');

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cited-code-liveness-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('reports dead with reason "cited file no longer exists" when the cited file is missing', () => {
  const repoRoot = makeRepo({ 'src/other.js': 'function other() {}\n' });
  try {
    const result = checkCitedCodeLiveness(repoRoot, 'src/gone.js', 'someSymbol');
    assert.equal(result.alive, false);
    assert.equal(result.reason, 'cited file no longer exists');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('reports dead when the cited file is present but the cited symbol is absent', () => {
  const repoRoot = makeRepo({ 'src/real.js': 'function presentThing() {}\n' });
  try {
    const result = checkCitedCodeLiveness(repoRoot, 'src/real.js', 'missingSymbol');
    assert.equal(result.alive, false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('reports alive when the cited file is present and the cited symbol is found', () => {
  const repoRoot = makeRepo({ 'src/real.js': 'function presentThing() {}\n' });
  try {
    const result = checkCitedCodeLiveness(repoRoot, 'src/real.js', 'presentThing');
    assert.equal(result.alive, true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('reports alive when the cited file is present and no symbol is given', () => {
  const repoRoot = makeRepo({ 'src/real.js': 'function presentThing() {}\n' });
  try {
    const result = checkCitedCodeLiveness(repoRoot, 'src/real.js');
    assert.equal(result.alive, true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('flags a cited path that escapes the repo root as an operational error', () => {
  const repoRoot = makeRepo({ 'src/real.js': 'function presentThing() {}\n' });
  try {
    const result = checkCitedCodeLiveness(repoRoot, '../evil.js');
    assert.equal(result.error, true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
