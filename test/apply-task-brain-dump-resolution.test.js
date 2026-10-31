'use strict';

// HUB0274-05: applyTask for the brain_dump_resolution_check domain records a verdict on ONE brain-dump entry and nothing else (flag only).
// End to end against a real temp brain-dump.json, the same shape as test/apply-task-brain-dump-disposition.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const prevRepoRoot = process.env.AGENT_MANAGER_REPO_ROOT;
process.env.AGENT_MANAGER_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-resolution-env-'));
let applyTask;
try {
  ({ applyTask } = require('../src/apply-task.js'));
} finally {
  if (prevRepoRoot === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT;
  else process.env.AGENT_MANAGER_REPO_ROOT = prevRepoRoot;
}
const { recordResolutionVerdict, parseVerdictResponse } = require('../src/brain-dump-resolution-check.js');

const PACK = { entryText: 'x', citedPaths: [], citedIdentifiers: [], recentCommits: ['4e8054e add "hold" subcommand to gpu-arbiter-cli'] };
const NOW = '2026-10-30T12:00:00.000Z';

const entry = (id, extra = {}) => ({ id, capturedAt: '2026-10-01T00:00:00Z', rawText: `check \`src/${id}.js\``, status: 'sorted', ...extra });

function writeDump(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-resolution-test-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries }, null, 2));
  return brainDumpPath;
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).entries;

function run(brainDumpPath, entryRow, implementResponse, ctxOverrides = {}) {
  const task = {
    id: `brain-dump-resolution-check-${entryRow.id}-abc1234`,
    domain: 'brain_dump_resolution_check',
    source: 'brain_dump_resolution_check',
    implementResponse,
    promptContext: { rawText: entryRow.rawText, brainDumpEntryId: entryRow.id, evidencePack: PACK, masterSha: 'abc1234def', citedShas: { [`src/${entryRow.id}.js`]: 'S1' }, ...ctxOverrides },
  };
  return applyTask(task, { repoRoot: process.cwd(), pipelineDir: os.tmpdir(), brainDumpPath });
}

test('a grounded yes records resolutionCheck and possiblyResolved and leaves status, suppressed and rawText byte-identical', () => {
  const row = entry('bd-1');
  const p = writeDump([row, entry('bd-2')]);
  const r = run(p, row, '{"resolved": "yes", "evidence": "commit 4e8054e added it"}');
  assert.equal(r.succeeded, true, JSON.stringify(r));
  assert.match(r.doneMarker, /resolution check bd-1: yes/);
  const [a, b] = read(p);
  assert.equal(a.resolutionCheck.verdict, 'yes');
  assert.equal(a.resolutionCheck.masterSha, 'abc1234def');
  assert.deepEqual(a.resolutionCheck.citedShas, { 'src/bd-1.js': 'S1' });
  assert.equal(a.possiblyResolved.evidence, 'commit 4e8054e added it');
  assert.equal(a.possiblyResolved.masterSha, 'abc1234def');
  assert.equal(a.status, 'sorted');
  assert.equal(a.rawText, row.rawText);
  assert.equal(a.suppressed, undefined);
  assert.deepEqual(b, entry('bd-2'), 'the other entry is untouched');
});

test('an ungrounded yes records unclear and no possiblyResolved', () => {
  const row = entry('bd-1');
  const p = writeDump([row]);
  run(p, row, '{"resolved": "yes", "evidence": "commit 9a8b7c6d5e fixed it"}');
  const [a] = read(p);
  assert.equal(a.resolutionCheck.verdict, 'unclear');
  assert.equal(a.possiblyResolved, undefined);
});

test('no and unclear record only resolutionCheck', () => {
  for (const verdict of ['no', 'unclear']) {
    const row = entry('bd-1');
    const p = writeDump([row]);
    run(p, row, `{"resolved": "${verdict}", "evidence": "see 4e8054e"}`);
    const [a] = read(p);
    assert.equal(a.resolutionCheck.verdict, verdict);
    assert.equal(a.possiblyResolved, undefined);
  }
});

test('unparsable model output is recorded as unclear', () => {
  const row = entry('bd-1');
  const p = writeDump([row]);
  const r = run(p, row, 'I think it looks fine, no JSON here');
  assert.equal(r.succeeded, true);
  assert.equal(read(p)[0].resolutionCheck.verdict, 'unclear');
});

test('an entry whose text changed since the check was drafted is skipped and the file is unchanged', () => {
  const row = entry('bd-1');
  const p = writeDump([{ ...row, rawText: 'edited by a human since' }]);
  const before = fs.readFileSync(p, 'utf8');
  const r = run(p, row, '{"resolved": "yes", "evidence": "commit 4e8054e"}');
  assert.equal(r.skipped, true);
  assert.match(r.reason, /changed since/);
  assert.equal(fs.readFileSync(p, 'utf8'), before);
});

test('an entry that is gone is skipped and the file is unchanged', () => {
  const p = writeDump([entry('bd-2')]);
  const before = fs.readFileSync(p, 'utf8');
  const r = run(p, entry('bd-1'), '{"resolved": "no", "evidence": "x"}');
  assert.equal(r.skipped, true);
  assert.match(r.reason, /is gone/);
  assert.equal(fs.readFileSync(p, 'utf8'), before);
});

test('recordResolutionVerdict is pure on a missing entry and parseVerdictResponse finds the first JSON object', () => {
  assert.equal(recordResolutionVerdict({ entries: [entry('bd-2')], entryId: 'bd-1', verdict: 'no', evidence: 'x', masterSha: 'm', now: NOW }), null);
  assert.deepEqual(parseVerdictResponse('Sure! {"resolved":"no","evidence":"a } b"} thanks'), { resolved: 'no', evidence: 'a } b' });
  assert.deepEqual(parseVerdictResponse('{bad} then {"resolved":"yes","evidence":"4e8054e"}'), { resolved: 'yes', evidence: '4e8054e' });
  assert.deepEqual(parseVerdictResponse(''), { resolved: 'unclear', evidence: 'unparsable model output' });
});
