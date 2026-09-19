'use strict';

// A machine-raised finding must be routed to the project whose pipeline raised it, not to
// whatever the sorter's own-project bias guesses (2026-09-19: a PF-Client-Portal finding was
// queued in agent-manager's queue/derived/ and two PF notes were filed under agent-manager).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeSideFindingInbox, inboxDir } = require('./side-finding.js');
const { originProjectFor, applyBrainDumpSort } = require('./apply-group-a-brain-dump.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-origin-')); }

test('inbox record is stamped with the raising repo (explicit, else AGENT_MANAGER_REPO_ROOT)', () => {
  const dir = tmp();
  writeSideFindingInbox({ title: 't', body: 'b' }, { source: 's', taskId: 'x', pipelineDir: dir, repoRoot: '/repo/pf' });
  const saved = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_REPO_ROOT = '/repo/env';
  try {
    writeSideFindingInbox({ title: 't2', body: 'b2' }, { source: 's', taskId: 'y', pipelineDir: dir });
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = saved;
  }
  const roots = fs.readdirSync(inboxDir(dir)).map((f) => JSON.parse(fs.readFileSync(path.join(inboxDir(dir), f), 'utf8')).repoRoot).sort();
  assert.deepEqual(roots, ['/repo/env', '/repo/pf']);
});

test('originProjectFor matches registry by real path, tolerates symlinks, returns null when unknown', () => {
  const base = tmp();
  const real = path.join(base, 'pf'); fs.mkdirSync(real);
  const link = path.join(base, 'pf-link'); fs.symlinkSync(real, link);
  const registry = [{ label: 'agent-manager', repoRoot: path.join(base, 'am') }, { label: 'pf-client-portal', repoRoot: link }];
  assert.equal(originProjectFor({ raisedBy: { repoRoot: real } }, registry).label, 'pf-client-portal');
  assert.equal(originProjectFor({ raisedBy: { repoRoot: '/nowhere' } }, registry), null);
  assert.equal(originProjectFor({ raisedBy: {} }, registry), null);
  assert.equal(originProjectFor({}, registry), null);
});

test('applyBrainDumpSort skips an entry suppressed after its sort task was queued', () => {
  const dir = tmp();
  const bd = path.join(dir, 'brain-dump.json');
  fs.writeFileSync(bd, JSON.stringify({ entries: [{ id: 'e1', status: 'captured', rawText: 'x', suppressed: true, raisedBy: { taskId: 't' } }] }));
  const res = applyBrainDumpSort({
    implementResponse: '{}', task: { promptContext: { brainDumpEntryId: 'e1', rawText: 'x' } },
    brainDumpPath: bd, secondBrainDir: dir, pipelineDir: dir,
  });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /suppressed/);
  assert.notEqual(res.recoverable, true);
});

test('applyBrainDumpSort routes a machine finding to the project that raised it, overriding the classifier', () => {
  const dir = tmp();
  const mk = (name) => {
    const repoRoot = path.join(dir, name); const pipelineDir = path.join(dir, `${name}-pipeline`);
    fs.mkdirSync(repoRoot, { recursive: true }); fs.mkdirSync(pipelineDir, { recursive: true });
    const domainsPath = path.join(pipelineDir, 'task-domains.json');
    fs.writeFileSync(domainsPath, JSON.stringify({ adhoc: {}, default: {} }));
    return { repoRoot, pipelineDir, domainsPath, label: name };
  };
  const am = mk('agent-manager'); const pf = mk('pf-client-portal');
  const registryPath = path.join(dir, 'projects.json');
  fs.writeFileSync(registryPath, JSON.stringify([am, pf]));
  const saved = process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH;
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = registryPath;
  try {
    const rawText = 'Health watchdog swallows docker failure\n\nThe catch block is unreachable.';
    const bd = path.join(dir, 'brain-dump.json');
    fs.writeFileSync(bd, JSON.stringify({ entries: [{ id: 'e1', status: 'captured', rawText, raisedBy: { taskId: 'change-review-d07cd56', repoRoot: pf.repoRoot } }] }));
    // The classifier guesses agent-manager (its own-project bias) -- the origin must win.
    const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'Ideas/x.md', actionable: true, belongsToProject: 'agent-manager' });
    const res = applyBrainDumpSort({
      implementResponse, task: { promptContext: { brainDumpEntryId: 'e1', rawText, projectLabels: ['agent-manager', 'pf-client-portal'] } },
      brainDumpPath: bd, secondBrainDir: path.join(dir, 'sb'), pipelineDir: am.pipelineDir,
    });
    assert.ok(res.queuedTaskId, JSON.stringify(res));
    assert.equal(fs.existsSync(path.join(am.pipelineDir, 'queue', 'derived')), false, 'must not land in agent-manager');
    assert.equal(fs.readdirSync(path.join(pf.pipelineDir, 'queue', 'derived')).length, 1);
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH; else process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = saved;
  }
});

test('isInvestigationFinding: hedged-verification phrasing is an investigation, concrete defects are not', () => {
  const { isInvestigationFinding } = require('./brain-dump-sort-classify.js');
  for (const t of [
    'Worth a quick grep of `core.ts` to confirm the option is honoured.',
    'Worth confirming the two processes use disjoint subdirectories.',
    '`auth: false` option is not visible in the shown diff',
    'Confirm whether the enricher is read-only on that path',
    'Verify the migration is idempotent',
  ]) assert.equal(isInvestigationFinding(t), true, t);
  for (const t of [
    'Stale comment in `.env.tower.example` still says five Prices; the file now lists six.',
    'Silent `catch` in a 30 s poll hides a persistent API outage; add console.warn.',
    'Overlapping async calls in `setInterval` can double-request; add an inFlight guard.',
  ]) assert.equal(isInvestigationFinding(t), false, t);
});

test('applyBrainDumpSort files an investigation-shaped machine finding as a note, not a task', () => {
  const dir = tmp();
  const repoRoot = path.join(dir, 'pf'); const pipelineDir = path.join(dir, 'pf-pipeline');
  fs.mkdirSync(repoRoot, { recursive: true }); fs.mkdirSync(pipelineDir, { recursive: true });
  const domainsPath = path.join(pipelineDir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({ adhoc: {}, default: {} }));
  const registryPath = path.join(dir, 'projects.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ label: 'pf-client-portal', repoRoot, pipelineDir, domainsPath }]));
  const saved = process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH;
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = registryPath;
  try {
    const rawText = 'Volume shared by two services\n\nWorth confirming the two processes use disjoint subdirectories.';
    const bd = path.join(dir, 'brain-dump.json');
    fs.writeFileSync(bd, JSON.stringify({ entries: [{ id: 'e1', status: 'captured', rawText, raisedBy: { taskId: 't', repoRoot } }] }));
    const implementResponse = JSON.stringify({ category: 'note', secondBrainPath: 'Ideas/shared-volume.md', actionable: true, belongsToProject: 'pf-client-portal' });
    const res = applyBrainDumpSort({
      implementResponse, task: { promptContext: { brainDumpEntryId: 'e1', rawText, projectLabels: ['pf-client-portal'] } },
      brainDumpPath: bd, secondBrainDir: path.join(dir, 'sb'), pipelineDir,
    });
    assert.equal(res.queuedTaskId, undefined, JSON.stringify(res));
    assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'derived')), false);
    assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'adhoc')), false);
    assert.ok(res.file && fs.existsSync(res.file), 'a SecondBrain note is filed instead');
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH; else process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = saved;
  }
});
