'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readFlags, fixableFlags, signatureFor, buildFixEvidence } = require('./drift-fix.js');
const driftScan = require('./drift-scan.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-fix-test-'));
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  return dir;
}

function writeFlags(pipelineDir, flags) {
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'drift-flags.json'), JSON.stringify(flags));
}

test('readFlags returns [] when the file does not exist (never throws)', () => {
  const dir = makePipeline();
  assert.deepEqual(readFlags(dir), []);
});

test('readFlags returns the real written flags', () => {
  const dir = makePipeline();
  const flags = [{ label: 'x', missingFromStatic: ['a'], staleInStatic: [] }];
  writeFlags(dir, flags);
  assert.deepEqual(readFlags(dir), flags);
});

test('fixableFlags excludes error entries and entries with nothing missing/stale', () => {
  const flags = [
    { label: 'a', missingFromStatic: ['x'], staleInStatic: [] },
    { label: 'b', error: 'marker text may have changed' },
    { label: 'c', missingFromStatic: [], staleInStatic: [] },
    { label: 'd', missingFromStatic: [], staleInStatic: ['y'] },
  ];
  const fixable = fixableFlags(flags);
  assert.deepEqual(fixable.map((f) => f.label), ['a', 'd']);
});

test('signatureFor is stable regardless of array order, and distinguishes missing from stale', () => {
  const s1 = signatureFor({ label: 'L', missingFromStatic: ['b', 'a'], staleInStatic: [] });
  const s2 = signatureFor({ label: 'L', missingFromStatic: ['a', 'b'], staleInStatic: [] });
  assert.equal(s1, s2);
  const s3 = signatureFor({ label: 'L', missingFromStatic: [], staleInStatic: ['a', 'b'] });
  assert.notEqual(s1, s3);
});

test('buildFixEvidence re-locates the real block and returns a safe insertion anchor + real stale row text', () => {
  const dir = makePipeline();
  fs.writeFileSync(path.join(dir, 'FAKE_README.md'), [
    '# Title',
    '',
    '| Source | Priority | Reads |',
    '|---|---|---|',
    '| `alpha` | 10 | reads a.json |',
    '| `beta` | 20 | reads b.json |',
    '| `stale_one` | 30 | this one is gone |',
    '',
    '## Building the codebase graph',
    'unrelated section',
  ].join('\n'));

  const fakePair = {
    label: 'FAKE PAIR',
    staticFile: 'FAKE_README.md',
    staticStartMarker: '| Source | Priority | Reads |',
    staticEndMarker: '## Building the codebase graph',
  };
  const origPairs = [...driftScan.PAIRS];
  driftScan.PAIRS.length = 0;
  driftScan.PAIRS.push(fakePair);
  try {
    const evidence = buildFixEvidence(dir, { label: 'FAKE PAIR', missingFromStatic: ['gamma'], staleInStatic: ['stale_one'] });
    assert.ok(evidence);
    assert.equal(evidence.staticFile, 'FAKE_README.md');
    assert.match(evidence.insertAfter, /`beta`/);
    assert.match(evidence.insertAfter, /`stale_one`/);
    assert.equal(evidence.staleRows.length, 1);
    assert.match(evidence.staleRows[0], /`stale_one`.*this one is gone/);
  } finally {
    driftScan.PAIRS.length = 0;
    driftScan.PAIRS.push(...origPairs);
  }
});

test('buildFixEvidence returns null when no PAIRS entry matches the flag\'s label (definition moved on)', () => {
  const dir = makePipeline();
  const evidence = buildFixEvidence(dir, { label: 'a label nothing defines', missingFromStatic: ['x'] });
  assert.equal(evidence, null);
});

test('buildFixEvidence returns null when the real static file cannot be read', () => {
  const dir = makePipeline();
  const fakePair = {
    label: 'MISSING FILE PAIR',
    staticFile: 'does-not-exist.md',
    staticStartMarker: 'x',
    staticEndMarker: 'y',
  };
  const origPairs = [...driftScan.PAIRS];
  driftScan.PAIRS.length = 0;
  driftScan.PAIRS.push(fakePair);
  try {
    const evidence = buildFixEvidence(dir, { label: 'MISSING FILE PAIR', missingFromStatic: ['x'] });
    assert.equal(evidence, null);
  } finally {
    driftScan.PAIRS.length = 0;
    driftScan.PAIRS.push(...origPairs);
  }
});
