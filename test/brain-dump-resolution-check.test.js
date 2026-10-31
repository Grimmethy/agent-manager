'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildEvidencePack } = require('../src/evidence-pack.js');
const { validateResolutionVerdict } = require('../src/validate-resolution.js');
const { next, apply, hasCodeReference, looksLikeResearch, isAlreadyChecked } = require('../src/brain-dump-resolution-check.js');

// Test evidence pack builder
test('buildEvidencePack: includes entry text', () => {
  const entry = { rawText: 'test entry', capturedAt: '2026-10-26T00:00:00Z' };
  const pack = buildEvidencePack(entry, 'abc123', 3000);
  assert.ok(pack.entryText.includes('test entry'));
});

test('buildEvidencePack: includes cited paths', () => {
  const entry = { rawText: 'check `src/foo.js`', capturedAt: '2026-10-26T00:00:00Z' };
  const pack = buildEvidencePack(entry, 'abc123', 3000);
  assert.ok(pack.citedPaths.length > 0);
  assert.strictEqual(pack.citedPaths[0].path, 'src/foo.js');
});

test('buildEvidencePack: includes recent commits', () => {
  const entry = { rawText: 'check `src/foo.js`', capturedAt: '2026-10-26T00:00:00Z' };
  const pack = buildEvidencePack(entry, 'abc123', 3000);
  assert.ok(Array.isArray(pack.recentCommits));
});

test('buildEvidencePack: caps at specified length', () => {
  const entry = { rawText: 'x'.repeat(5000), capturedAt: '2026-10-26T00:00:00Z' };
  const pack = buildEvidencePack(entry, 'abc123', 3000);
  const json = JSON.stringify(pack);
  assert.ok(json.length <= 3000, `Pack too large: ${json.length} chars`);
});

// Test validator
test('validator: accepts yes with grounded evidence (commit hash)', () => {
  const verdict = { resolved: 'yes', evidence: 'commit abc1234567890 fixed it' };
  const pack = { recentCommits: ['abc1234567890 subject'] };
  const result = validateResolutionVerdict(verdict, verdict.evidence, pack);
  assert.strictEqual(result.resolved, 'yes');
  assert.ok(result.evidence.includes('abc1234567890'));
});

test('validator: accepts yes with grounded evidence (file:line)', () => {
  const verdict = { resolved: 'yes', evidence: 'src/foo.js:42' };
  const pack = { citedIdentifiers: [{ identifier: 'foo', hits: ['src/foo.js:42: code'] }] };
  const result = validateResolutionVerdict(verdict, verdict.evidence, pack);
  assert.strictEqual(result.resolved, 'yes');
  assert.ok(result.evidence.includes('src/foo.js:42'));
});

test('validator: accepts yes with grounded evidence (quoted subject)', () => {
  const verdict = { resolved: 'yes', evidence: '"add hold subcommand" in commit' };
  const pack = { recentCommits: ['abc123 "add hold subcommand" to gpu-arbiter'] };
  const result = validateResolutionVerdict(verdict, verdict.evidence, pack);
  assert.strictEqual(result.resolved, 'yes');
  assert.ok(result.evidence.includes('add hold subcommand'));
});

test('validator: downgrades yes without grounded evidence', () => {
  const verdict = { resolved: 'yes', evidence: 'random text not in pack' };
  const pack = { entryText: 'test', citedPaths: [], citedIdentifiers: [], recentCommits: [] };
  const result = validateResolutionVerdict(verdict, verdict.evidence, pack);
  assert.strictEqual(result.resolved, 'unclear');
  assert.strictEqual(result.error, 'evidence not grounded in pack');
});

test('validator: downgrades invalid verdict format', () => {
  const verdict = { resolved: 'maybe' };
  const result = validateResolutionVerdict(verdict, 'evidence', {});
  assert.strictEqual(result.resolved, 'unclear');
  assert.strictEqual(result.error, 'invalid verdict format');
});

test('validator: downgrades missing evidence', () => {
  const verdict = { resolved: 'yes' };
  const result = validateResolutionVerdict(verdict, '', {});
  assert.strictEqual(result.resolved, 'unclear');
  assert.strictEqual(result.error, 'missing evidence');
});

// Test selectEntryToCheck(): the pure choice of the ONE entry to check next (HUB0274-03)
const { selectEntryToCheck } = require('../src/brain-dump-resolution-check.js');
const E = (id, capturedAt, extra = {}) => ({ id, rawText: `check \`src/${id}.js\``, status: 'sorted', capturedAt, ...extra });
const noShas = () => ({});

test('selectEntryToCheck: never-checked entries come first, oldest first', () => {
  const entries = [
    E('b', '2026-10-02'),
    E('checked', '2026-09-01', { resolutionCheck: { at: 'x', masterSha: 'm', verdict: 'no', citedShas: { 'src/checked.js': 'S1' } } }),
    E('a', '2026-10-01'),
  ];
  const picked = selectEntryToCheck(entries, { citedShasFor: () => ({ 'src/checked.js': 'S2' }), taskExists: () => false });
  assert.strictEqual(picked.id, 'a');
});

test('selectEntryToCheck: a checked entry whose cited files are unchanged is skipped', () => {
  const entries = [E('c', '2026-10-01', { resolutionCheck: { at: 'x', masterSha: 'm1', verdict: 'no', citedShas: { 'src/c.js': 'S1' } } })];
  assert.strictEqual(selectEntryToCheck(entries, { citedShasFor: () => ({ 'src/c.js': 'S1' }), taskExists: () => false }), null);
});

test('selectEntryToCheck: a checked entry whose cited file changed is selected again', () => {
  const entries = [E('c', '2026-10-01', { resolutionCheck: { at: 'x', masterSha: 'm1', verdict: 'no', citedShas: { 'src/c.js': 'S1' } } })];
  const picked = selectEntryToCheck(entries, { citedShasFor: () => ({ 'src/c.js': 'S2' }), taskExists: () => false });
  assert.strictEqual(picked.id, 'c');
});

test('selectEntryToCheck: master unchanged since the last check is a fast path that never computes cited shas', () => {
  const entries = [E('c', '2026-10-01', { resolutionCheck: { at: 'x', masterSha: 'm1', verdict: 'no', citedShas: { 'src/c.js': 'S1' } } })];
  let calls = 0;
  const picked = selectEntryToCheck(entries, { masterShaFor: () => 'm1', citedShasFor: () => { calls++; return { 'src/c.js': 'CHANGED' }; }, taskExists: () => false });
  assert.strictEqual(picked, null);
  assert.strictEqual(calls, 0);
});

test('selectEntryToCheck: suppressed, actioned, research and code-free entries are skipped', () => {
  const entries = [
    E('s', '2026-10-01', { suppressed: true }),
    E('x', '2026-10-01', { status: 'actioned' }),
    { id: 'r', rawText: 'see https://example.com `src/r.js`', status: 'sorted', capturedAt: '2026-10-01' },
    { id: 'n', rawText: 'just an idea', status: 'sorted', capturedAt: '2026-10-01' },
  ];
  assert.strictEqual(selectEntryToCheck(entries, { citedShasFor: noShas, taskExists: () => false }), null);
});

test('selectEntryToCheck: an entry whose task already exists in the queue is skipped, and the task id carries the entry id and short master sha', () => {
  const seen = [];
  const picked = selectEntryToCheck([E('a', '2026-10-01'), E('b', '2026-10-02')], {
    masterShaFor: () => 'abcdef1234567',
    citedShasFor: noShas,
    taskExists: (id) => { seen.push(id); return id.includes('-a-'); },
  });
  assert.strictEqual(picked.id, 'b');
  assert.deepStrictEqual(seen, ['brain-dump-resolution-check-a-abcdef1', 'brain-dump-resolution-check-b-abcdef1']);
});

test('selectEntryToCheck: tolerates a missing entries list', () => {
  assert.strictEqual(selectEntryToCheck(undefined, {}), null);
  assert.strictEqual(selectEntryToCheck([], {}), null);
});

// Test next() (registry signature: no arguments, one task or null) against a temp git repo and a temp brain-dump.json
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function withEnvironment(entries, fn) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'resolution-next-repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'foo.js'), 'function foo() {}\n');
  git('add', '-A'); git('commit', '-q', '-m', 'add foo');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolution-next-pipe-'));
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  const brainDump = path.join(dir, 'brain-dump.json');
  if (entries !== null) fs.writeFileSync(brainDump, typeof entries === 'string' ? entries : JSON.stringify({ entries }));
  const keys = ['AGENT_MANAGER_PIPELINE_DIR', 'AGENT_MANAGER_REPO_ROOT', 'AGENT_MANAGER_BRAIN_DUMP_PATH', 'AGENT_MANAGER_CORE_REPO_ROOT'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { AGENT_MANAGER_PIPELINE_DIR: dir, AGENT_MANAGER_REPO_ROOT: dir, AGENT_MANAGER_BRAIN_DUMP_PATH: brainDump, AGENT_MANAGER_CORE_REPO_ROOT: repo });
  // getConfig() reads the environment on every call, so only this module is reloaded (reloading task-sources.js would re-register every source and throw).
  const reload = () => { delete require.cache[require.resolve('../src/brain-dump-resolution-check.js')]; return require('../src/brain-dump-resolution-check.js'); };
  try {
    return fn({ mod: reload(), repo, head: git('rev-parse', 'HEAD'), git, brainDump });
  } finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    reload();
  }
}

test('next(): returns exactly one task with the contract fields for a never-checked entry', () => {
  withEnvironment([{ id: 'bd-1', rawText: 'the helper `foo` in `src/foo.js` is wrong', status: 'sorted', capturedAt: '2026-10-01T00:00:00Z' }], ({ mod, head }) => {
    const task = mod.next();
    assert.ok(task && !Array.isArray(task));
    assert.strictEqual(task.id, `brain-dump-resolution-check-bd-1-${head.slice(0, 7)}`);
    assert.strictEqual(task.domain, 'brain_dump_resolution_check');
    assert.strictEqual(task.source, 'brain_dump_resolution_check');
    assert.match(task.title, /^Check whether a brain-dump entry is already fixed: the helper/);
    assert.strictEqual(task.promptContext.brainDumpEntryId, 'bd-1');
    assert.strictEqual(task.promptContext.masterSha, head);
    assert.strictEqual(task.promptContext.evidencePack.citedPaths[0].exists, true);
    assert.deepStrictEqual(Object.keys(task.promptContext.citedShas), ['src/foo.js']);
    assert.match(task.promptContext.citedShas['src/foo.js'], /^[0-9a-f]{40}$/);
  });
});

test('next(): returns null when nothing qualifies, when the file is missing, and when it is unparsable', () => {
  withEnvironment([{ id: 'bd-2', rawText: 'just an idea', status: 'sorted', capturedAt: '2026-10-01' }], ({ mod }) => assert.strictEqual(mod.next(), null));
  withEnvironment(null, ({ mod }) => assert.strictEqual(mod.next(), null));
  withEnvironment('{ not json', ({ mod }) => assert.strictEqual(mod.next(), null));
});

test('next(): a checked entry is not offered again until a cited file changes', () => {
  withEnvironment(null, ({ mod, repo, head, git, brainDump }) => {
    const entry = { id: 'bd-3', rawText: 'see `src/foo.js`', status: 'sorted', capturedAt: '2026-10-01' };
    entry.resolutionCheck = { at: 'x', masterSha: head, verdict: 'no', citedShas: mod.citedShasFor(entry, repo) };
    fs.writeFileSync(brainDump, JSON.stringify({ entries: [entry] }));
    assert.strictEqual(mod.next(), null, 'master unchanged: nothing to re-check');
    fs.writeFileSync(path.join(repo, 'src', 'other.js'), 'x\n'); git('add', '-A'); git('commit', '-q', '-m', 'unrelated');
    assert.strictEqual(mod.next(), null, 'master moved but the cited file did not');
    fs.writeFileSync(path.join(repo, 'src', 'foo.js'), 'function foo() { return 1 }\n'); git('add', '-A'); git('commit', '-q', '-m', 'change foo');
    const task = mod.next();
    assert.ok(task, 'the cited file changed');
    assert.strictEqual(task.promptContext.brainDumpEntryId, 'bd-3');
  });
});

// Test apply()
test('apply(): sets possiblyResolved on validated yes', () => {
  const entry = { rawText: 'check `scripts/foo.js`', status: 'sorted', capturedAt: '2026-10-26' };
  apply({ 
    entry, 
    verdict: { resolved: 'yes', evidence: 'commit abc123' }, 
    evidence: 'commit abc123', 
    masterSha: 'abc123' 
  });
  assert.ok(entry.possiblyResolved);
  assert.strictEqual(entry.possiblyResolved.masterSha, 'abc123');
  assert.ok(entry.possiblyResolved.checkedAt);
});

test('apply(): records check on no/unclear', () => {
  const entry = { rawText: 'check `scripts/foo.js`', status: 'sorted', capturedAt: '2026-10-26' };
  apply({ 
    entry, 
    verdict: { resolved: 'unclear', evidence: '' }, 
    evidence: '', 
    masterSha: 'abc123' 
  });
  assert.ok(entry.resolutionCheck);
  assert.strictEqual(entry.resolutionCheck.masterSha, 'abc123');
  assert.strictEqual(entry.resolutionCheck.verdict, 'unclear');
});

test('apply(): never changes status or rawText', () => {
  const entry = { rawText: 'check `scripts/foo.js`', status: 'sorted', capturedAt: '2026-10-26' };
  const originalStatus = entry.status;
  const originalRawText = entry.rawText;
  
  apply({ 
    entry, 
    verdict: { resolved: 'yes', evidence: 'commit abc123' }, 
    evidence: 'commit abc123', 
    masterSha: 'abc123' 
  });
  
  assert.strictEqual(entry.status, originalStatus);
  assert.strictEqual(entry.rawText, originalRawText);
});

// Test helper functions
test('hasCodeReference: detects backticked paths', () => {
  assert.ok(hasCodeReference('check `scripts/foo.js`'));
  assert.ok(!hasCodeReference('no backticks here'));
});

test('looksLikeResearch: detects URLs and research keywords', () => {
  assert.ok(looksLikeResearch('see https://example.com'));
  assert.ok(looksLikeResearch('research paper on ML'));
  assert.ok(!looksLikeResearch('check `scripts/foo.js`'));
});

test('isAlreadyChecked: true exactly when the entry carries a resolutionCheck', () => {
  assert.ok(isAlreadyChecked({ resolutionCheck: { masterSha: 'abc123' } }));
  assert.ok(!isAlreadyChecked({ rawText: 'x' }));
  assert.ok(!isAlreadyChecked(null));
});
