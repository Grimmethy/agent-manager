'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveUngroundedImport, gatherGroundingEvidence } = require('./ungrounded-import-resolution');
const { formatFabricatedReason } = require('./candidate-path-grounding');

const tempDirs = [];
const savedEnv = {};
const ENV_KEYS = ['HOME', 'AGENT_MANAGER_STATE_DIR', 'AGENT_MANAGER_CANDIDATE_GROUNDING_MAIN_REF'];

function mkTemp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function mkRepo(files) {
  const repo = mkTemp('uir-repo-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return repo;
}

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.HOME = mkTemp('uir-home-');
  process.env.AGENT_MANAGER_STATE_DIR = mkTemp('uir-state-');
  process.env.AGENT_MANAGER_CANDIDATE_GROUNDING_MAIN_REF = 'false';
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

const FABRICATED = 'fabricated file path(s): src/x.js -- not present anywhere in the target repo. redraft cannot fix';

test('protected case: src/arch.js absent, src/architecture.js matches terms → redraft, not archive', () => {
  const repo = mkRepo({ 'src/architecture.js': 'module.exports = {};\n' });
  const task = { title: 'Refactor arch module', rawText: 'Refactor arch module\nFiles: src/arch.js' };
  const g = gatherGroundingEvidence(task, repo, []);
  assert.deepEqual(g.existingPaths, []);
  assert.ok(g.missingPaths.includes('src/arch.js'));
  assert.ok(g.hitCount > 0);
  assert.ok(g.evidenceFiles.includes('src/architecture.js'));
  const r = resolveUngroundedImport({
    citedPaths: g.missingPaths,
    existingPaths: g.existingPaths,
    evidenceFiles: g.evidenceFiles,
    hitCount: g.hitCount,
  });
  assert.equal(r.action, 'redraft');
  assert.notEqual(r.action, 'archive');
  assert.ok(r.evidence.includes('src/architecture.js'));
});

test('proceeds when a cited path exists', () => {
  const r = resolveUngroundedImport({ citedPaths: ['src/a.js'], existingPaths: ['src/a.js'], evidenceFiles: [], hitCount: 0 });
  assert.equal(r.action, 'proceed');
});

test('redrafts with evidence when cited paths are missing but hits exist', () => {
  const r = resolveUngroundedImport({
    citedPaths: ['src/x.js'], existingPaths: [], evidenceFiles: ['src/xy.js'], hitCount: 1,
  });
  assert.equal(r.action, 'redraft');
  assert.deepEqual(r.evidence, ['src/xy.js']);
  assert.equal(typeof r.fingerprint, 'string');
  assert.ok(r.fingerprint.length > 0);
  assert.equal(r.record.event, 'ungrounded-import-redraft');
});

test('archives on zero hits and states a reason', () => {
  const r = resolveUngroundedImport({ citedPaths: ['src/x.js'], existingPaths: [], evidenceFiles: [], hitCount: 0 });
  assert.equal(r.action, 'archive');
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
  assert.equal(r.reason, formatFabricatedReason([{ claimedPath: 'src/x.js' }]));
  assert.equal(r.record.event, 'ungrounded-import-archive');
  assert.deepEqual(r.record, {
    event: 'ungrounded-import-archive',
    citedPaths: ['src/x.js'],
    hitCount: 0,
    evidenceCount: 0,
    fingerprint: r.fingerprint,
    reason: r.reason,
  });
});

test('holds unchanged when the fabricated-path failure and fingerprint match', () => {
  const input = { citedPaths: ['src/x.js'], existingPaths: [], evidenceFiles: ['src/xy.js'], hitCount: 1 };
  const first = resolveUngroundedImport(input);
  const second = resolveUngroundedImport({ ...input, priorFailure: FABRICATED, priorFingerprint: first.fingerprint });
  assert.equal(second.action, 'hold-unchanged');
  assert.equal(second.record.event, 'ungrounded-import-hold-unchanged');
});

test('redrafts when the fingerprint changed', () => {
  const input = { citedPaths: ['src/x.js'], existingPaths: [], evidenceFiles: ['src/xy.js'], hitCount: 1 };
  const first = resolveUngroundedImport(input);
  const second = resolveUngroundedImport({
    ...input, evidenceFiles: ['src/xy.js', 'src/xz.js'], hitCount: 2,
    priorFailure: FABRICATED, priorFingerprint: first.fingerprint,
  });
  assert.equal(second.action, 'redraft');
  assert.notEqual(second.fingerprint, first.fingerprint);
  const third = resolveUngroundedImport({ ...input, priorFailure: FABRICATED, priorFingerprint: 'different' });
  assert.equal(third.action, 'redraft');
});

test('ordering: existing cited path wins even with zero hits', () => {
  const r = resolveUngroundedImport({
    citedPaths: ['src/a.js', 'src/x.js'], existingPaths: ['src/a.js'], evidenceFiles: [], hitCount: 0,
  });
  assert.equal(r.action, 'proceed');
  assert.notEqual(r.action, 'archive');
});

test('per-task isolation: many zero-hit archives for task A do not archive task B', () => {
  for (let i = 0; i < 50; i++) {
    const a = resolveUngroundedImport({ citedPaths: ['src/a-missing.js'], existingPaths: [], evidenceFiles: [], hitCount: 0 });
    assert.equal(a.action, 'archive');
  }
  const b = resolveUngroundedImport({
    citedPaths: ['src/b-missing.js'], existingPaths: [], evidenceFiles: ['src/b-missing-ish.js'], hitCount: 1,
  });
  assert.equal(b.action, 'redraft');
  assert.ok(!b.record.citedPaths.includes('src/a-missing.js'));
});

test('gatherGroundingEvidence is bounded', () => {
  const files = {};
  for (let i = 0; i < 200; i++) files[`src/widget-${i}.js`] = '';
  const repo = mkRepo(files);
  const task = { title: 'Widget work', rawText: 'Widget work\nFiles: src/widget.js' };
  const g = gatherGroundingEvidence(task, repo, []);
  assert.ok(g.missingPaths.includes('src/widget.js'));
  assert.ok(g.evidenceFiles.length > 0);
  assert.ok(g.evidenceFiles.length < 200);
  assert.ok(g.hitCount >= g.evidenceFiles.length);
  assert.equal(new Set(g.evidenceFiles).size, g.evidenceFiles.length);
});
