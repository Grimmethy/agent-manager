'use strict';

// Tests for the domain self-heal in getDomainConfig (src/review-grounding.js).
//
// Expected state against the current checkout (subtask 0 not landed here):
//   - cases 1, 4, 5 pass;
//   - case 2 fails (the current code logs 'task-domain-self-heal', with no previousRegistry);
//   - case 3 fails (the current code has no deprecated check and returns the entry).
// Assertions are not weakened to match the current code.
//
// Runner: node:test (repo convention). Note: repo tests live in both test/ and src/*.test.js;
// this file follows the task-specified test/ path.
//
// Event reads go through readPipelineHistory (src/pipeline-history.js), which reads
// <pipelineDir>/instances/pipeline-history.log as NDJSON filtered by `type`.
// Every fixture lives in its own temp dir, removed in afterEach. The real registry is never touched.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDomainConfig } = require('../src/review-grounding.js');
const { readPipelineHistory } = require('../src/pipeline-history.js');
const { isStandardDomain } = require('../src/task-domains-registry.js');

// 'adhoc' is ALWAYS_PRESENT in task-domains-registry.js, so it is a standard domain.
const STANDARD = 'adhoc';
const DEFAULT_ENTRY = { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' };

const created = [];

function makeFixture(registry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-self-heal-'));
  created.push(dir);
  const domainsPath = path.join(dir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify(registry, null, 2) + '\n');
  return { dir, domainsPath, pipelineDir: dir };
}

function healEvents(pipelineDir) {
  return readPipelineHistory(pipelineDir, { type: 'domain-self-heal' });
}

function unknownDomainError(err) {
  return err instanceof Error && err.message.startsWith('Unknown task domain:');
}

afterEach(() => {
  while (created.length) {
    const d = created.pop();
    try { fs.chmodSync(d, 0o755); } catch { /* already removable */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('unknown non-standard domain throws and leaves the registry unmodified', () => {
  const name = `zz-not-standard-${process.pid}-${Date.now()}`;
  assert.equal(isStandardDomain(name), false);
  const { domainsPath, pipelineDir } = makeFixture({ default: DEFAULT_ENTRY });
  const before = fs.readFileSync(domainsPath, 'utf8');
  assert.throws(() => getDomainConfig(domainsPath, name, { pipelineDir }), unknownDomainError);
  assert.equal(fs.readFileSync(domainsPath, 'utf8'), before);
  assert.equal(healEvents(pipelineDir).length, 0);
});

test('standard domain absent from registry heals, gains its entry, and logs one event with previousRegistry', () => {
  const { domainsPath, pipelineDir } = makeFixture({ default: DEFAULT_ENTRY });
  const cfg = getDomainConfig(domainsPath, STANDARD, { pipelineDir });
  assert.ok(cfg, 'expected a registry entry back');
  const onDisk = JSON.parse(fs.readFileSync(domainsPath, 'utf8'));
  assert.ok(onDisk[STANDARD], 'registry should now contain the healed key');
  const events = healEvents(pipelineDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].domain, STANDARD);
  assert.equal(events[0].domainsPath, domainsPath);
  assert.equal(events[0].previousRegistry, null);
  assert.ok(events[0].addedEntry, 'event should carry addedEntry');
});

test('deprecated domain throws, names the domain, and is not re-added', () => {
  const registry = {
    default: DEFAULT_ENTRY,
    [STANDARD]: { ...DEFAULT_ENTRY, deprecated: true },
  };
  const { domainsPath, pipelineDir } = makeFixture(registry);
  const before = fs.readFileSync(domainsPath, 'utf8');
  assert.throws(
    () => getDomainConfig(domainsPath, STANDARD, { pipelineDir }),
    (err) => err instanceof Error && err.message.includes(STANDARD),
  );
  assert.equal(fs.readFileSync(domainsPath, 'utf8'), before);
  assert.equal(healEvents(pipelineDir).length, 0);
});

test('near-miss key (case or whitespace) throws and does not heal', () => {
  const { domainsPath, pipelineDir } = makeFixture({ default: DEFAULT_ENTRY });
  const before = fs.readFileSync(domainsPath, 'utf8');
  for (const variant of [' adhoc ', 'Adhoc']) {
    assert.throws(() => getDomainConfig(domainsPath, variant, { pipelineDir }), unknownDomainError);
  }
  assert.equal(fs.readFileSync(domainsPath, 'utf8'), before);
  assert.equal(healEvents(pipelineDir).length, 0);
});

test('read-only domainsPath does not crash the caller and records no false success', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: chmod does not restrict writes');
    return;
  }
  const { dir, domainsPath, pipelineDir } = makeFixture({ default: DEFAULT_ENTRY });
  const before = fs.readFileSync(domainsPath, 'utf8');
  fs.chmodSync(dir, 0o555);
  let threw = null;
  try {
    getDomainConfig(domainsPath, STANDARD, { pipelineDir });
  } catch (err) {
    threw = err;
  }
  // Either a controlled error or a clean return is acceptable; a silent success is not.
  if (threw) assert.ok(threw instanceof Error, 'failure should be an Error');
  assert.equal(fs.readFileSync(domainsPath, 'utf8'), before);
  assert.equal(healEvents(pipelineDir).length, 0, 'no domain-self-heal event on a failed write');
});
