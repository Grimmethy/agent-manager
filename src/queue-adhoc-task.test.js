'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { queueAdhocTask, defaultTaskDomain } = require('./queue-adhoc-task.js');

function tmpPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-task-test-'));
  fs.writeFileSync(path.join(dir, 'task-domains.json'), JSON.stringify({ default: {}, other_domain: {} }));
  return dir;
}

test('queueAdhocTask writes the expected record shape and defaults domain to "default"', () => {
  const dir = tmpPipeline();
  const { record, filePath } = queueAdhocTask(
    { title: 'Merge AC-57', promptContext: { rawText: 'merge it', raisedFrom: 'chat' } },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal(record.domain, 'default');
  assert.equal(record.source, 'manual');
  assert.equal(record.title, 'Merge AC-57');
  assert.equal(record.humanQueued, true, 'this is one of the two genuine human-adhoc entry points -- next-claimable-task.js\'s effectivePriority() depends on this to NOT demote it');
  assert.deepEqual(record.promptContext, { rawText: 'merge it', raisedFrom: 'chat' });
  assert.match(record.id, /^adhoc-merge-ac-57-\d+$/);
  assert.ok(fs.existsSync(filePath));
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(onDisk, record);
  assert.equal('premiumPriority' in record, false, 'not a blanket default for every caller -- opt-in only');
});

test('queueAdhocTask sets premiumPriority:true when explicitly requested, omits it otherwise', () => {
  const dir = tmpPipeline();
  const domainsPath = path.join(dir, 'task-domains.json');

  const { record: premium } = queueAdhocTask(
    { title: 'Chat-queued fix', promptContext: { rawText: 'x', raisedFrom: 'chat' }, premiumPriority: true },
    { pipelineDir: dir, domainsPath },
  );
  assert.equal(premium.premiumPriority, true);

  const { record: plain } = queueAdhocTask(
    { title: 'Plain task', promptContext: { rawText: 'y' } },
    { pipelineDir: dir, domainsPath },
  );
  assert.equal('premiumPriority' in plain, false);
});

// Port of app.py's default_task_domain() (2026-09-06): picking the first key with no
// regard for whether it's a sane generic default once queued two real tasks with
// domain='adhoc' into a project whose task-domains.json didn't even list 'adhoc',
// permanently blocking them with "Unknown task domain: adhoc".
test('defaultTaskDomain prefers "default" even when it is not the first key', () => {
  assert.equal(defaultTaskDomain(['zzz_first', 'default', 'adhoc']), 'default');
});

test('defaultTaskDomain falls back to "adhoc" when "default" is absent', () => {
  assert.equal(defaultTaskDomain(['zzz_first', 'adhoc']), 'adhoc');
});

test('defaultTaskDomain falls back to the first key only when neither preferred candidate exists', () => {
  assert.equal(defaultTaskDomain(['deep_dive', 'project_search']), 'deep_dive');
});

test('queueAdhocTask uses defaultTaskDomain, not a bare first-key lookup, when no domain is given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-task-test-'));
  // 'deep_dive' is deliberately first here -- a bare validDomains[0] would wrongly pick
  // it; defaultTaskDomain must still find and prefer 'default'.
  fs.writeFileSync(path.join(dir, 'task-domains.json'), JSON.stringify({ deep_dive: {}, default: {} }));
  const { record } = queueAdhocTask(
    { title: 'X', promptContext: {} },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal(record.domain, 'default');
});

test('queueAdhocTask respects an explicit domain', () => {
  const dir = tmpPipeline();
  const { record } = queueAdhocTask(
    { title: 'X', promptContext: {}, domain: 'other_domain' },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal(record.domain, 'other_domain');
});

test('queueAdhocTask throws on an invalid domain rather than writing a bad task', () => {
  const dir = tmpPipeline();
  assert.throws(() => queueAdhocTask(
    { title: 'X', promptContext: {}, domain: 'not_a_real_domain' },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  ), /Invalid domain/);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc')), false, 'must not create the adhoc dir/any file on a validation failure');
});

test('queueAdhocTask requires a title and a promptContext', () => {
  const dir = tmpPipeline();
  assert.throws(() => queueAdhocTask(
    { promptContext: {} }, { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  ), /title is required/);
  assert.throws(() => queueAdhocTask(
    { title: 'X' }, { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  ), /promptContext is required/);
});

test('queueAdhocTask passes through a non-empty dependsOn, omits it when empty', () => {
  const dir = tmpPipeline();
  const { record: withDeps } = queueAdhocTask(
    { title: 'A', promptContext: {}, dependsOn: ['adhoc-b-1', 'adhoc-c-2'] },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.deepEqual(withDeps.dependsOn, ['adhoc-b-1', 'adhoc-c-2']);

  const { record: noDeps } = queueAdhocTask(
    { title: 'B', promptContext: {}, dependsOn: [] },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal('dependsOn' in noDeps, false);
});

test('the CLI entrypoint still writes the identical record shape as the extracted function', () => {
  const dir = tmpPipeline();
  const promptContextFile = path.join(dir, 'ctx.json');
  fs.writeFileSync(promptContextFile, JSON.stringify({ rawText: 'do it' }));

  execFileSync('node', [
    path.join(__dirname, 'queue-adhoc-task.js'),
    '--title', 'CLI queued task',
    '--prompt-context-file', promptContextFile,
  ], {
    env: { ...process.env, AGENT_MANAGER_REPO_ROOT: dir, AGENT_MANAGER_PIPELINE_DIR: dir },
  });

  const files = fs.readdirSync(path.join(dir, 'queue', 'adhoc'));
  assert.equal(files.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', files[0]), 'utf8'));
  assert.equal(record.title, 'CLI queued task');
  assert.equal(record.source, 'manual');
  assert.deepEqual(record.promptContext, { rawText: 'do it' });
});

// --- scratch flag tests ---

test('scratch run writes only under the scratch dir, not the live pipeline', () => {
  // The live pipeline must list 'adhoc' as a valid domain -- the scratch path forces
  // domain='adhoc', and validation runs against the (copied) task-domains.json in the
  // scratch dir, which is a copy of the live one.
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-task-test-'));
  fs.writeFileSync(path.join(liveDir, 'task-domains.json'), JSON.stringify({ default: {}, adhoc: {}, other_domain: {} }));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-scratch-'));
  const promptContextFile = path.join(scratchDir, 'ctx.json');
  fs.writeFileSync(promptContextFile, JSON.stringify({ rawText: 'scratch task' }));

  execFileSync('node', [
    path.join(__dirname, 'queue-adhoc-task.js'),
    '--scratch', scratchDir,
    '--repo-root', liveDir,
    '--title', 'Scratch task',
    '--prompt-context-file', promptContextFile,
  ], {
    env: { ...process.env, AGENT_MANAGER_PIPELINE_DIR: liveDir, AGENT_MANAGER_REPO_ROOT: liveDir },
  });

  // The scratch dir has the task and the copied task-domains.json
  assert.ok(fs.existsSync(path.join(scratchDir, 'task-domains.json')), 'task-domains.json copied into scratch dir');
  const scratchAdhocFiles = fs.readdirSync(path.join(scratchDir, 'queue', 'adhoc'));
  assert.equal(scratchAdhocFiles.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(scratchDir, 'queue', 'adhoc', scratchAdhocFiles[0]), 'utf8'));
  assert.equal(record.title, 'Scratch task');
  assert.equal(record.domain, 'adhoc', 'domain forced to adhoc for scratch runs');
  assert.equal(record.generatedForRepoRoot, liveDir, 'generatedForRepoRoot stamped from --repo-root');

  // The live pipeline is untouched -- no new adhoc files. Create the live adhoc dir
  // first (it may not exist since this is a fresh pipeline dir) so we can check it's empty.
  fs.mkdirSync(path.join(liveDir, 'queue', 'adhoc'), { recursive: true });
  const liveAdhocFiles = fs.readdirSync(path.join(liveDir, 'queue', 'adhoc'));
  assert.equal(liveAdhocFiles.length, 0, 'live queue directory is untouched by scratch run');
});

test('scratch run with missing --repo-root exits non-zero and writes nothing', () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-scratch-'));
  const promptContextFile = path.join(scratchDir, 'ctx.json');
  fs.writeFileSync(promptContextFile, JSON.stringify({ rawText: 'no repo' }));

  let exited = false;
  try {
    execFileSync('node', [
      path.join(__dirname, 'queue-adhoc-task.js'),
      '--scratch', scratchDir,
      '--title', 'No repo task',
      '--prompt-context-file', promptContextFile,
    ], {
      env: { ...process.env, AGENT_MANAGER_PIPELINE_DIR: scratchDir, AGENT_MANAGER_REPO_ROOT: scratchDir },
    });
  } catch (e) {
    exited = true;
    assert.ok(e.status !== 0, 'expected non-zero exit');
  }
  assert.ok(exited, 'must exit non-zero when --repo-root is missing with --scratch');

  // Nothing written under the scratch dir (no queue/adhoc/, no task-domains.json)
  assert.equal(fs.existsSync(path.join(scratchDir, 'queue')), false, 'no queue/ dir created');
  assert.equal(fs.existsSync(path.join(scratchDir, 'task-domains.json')), false, 'no task-domains.json copied');
});

test('run without --scratch is unchanged (no generatedForRepoRoot, writes to pipeline dir)', () => {
  const dir = tmpPipeline();
  const promptContextFile = path.join(dir, 'ctx.json');
  fs.writeFileSync(promptContextFile, JSON.stringify({ rawText: 'plain cli' }));

  execFileSync('node', [
    path.join(__dirname, 'queue-adhoc-task.js'),
    '--title', 'Plain CLI task',
    '--prompt-context-file', promptContextFile,
  ], {
    env: { ...process.env, AGENT_MANAGER_PIPELINE_DIR: dir, AGENT_MANAGER_REPO_ROOT: dir },
  });

  const files = fs.readdirSync(path.join(dir, 'queue', 'adhoc'));
  assert.equal(files.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', files[0]), 'utf8'));
  assert.equal(record.title, 'Plain CLI task');
  assert.equal('generatedForRepoRoot' in record, false, 'no generatedForRepoRoot without --scratch');
  assert.equal(record.domain, 'default', 'domain uses defaultTaskDomain, not forced to adhoc');
});

test('scratch run does not overwrite task-domains.json if it already exists', () => {
  // The live pipeline must list 'adhoc' so the forced domain='adhoc' passes validation.
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-task-test-'));
  fs.writeFileSync(path.join(liveDir, 'task-domains.json'), JSON.stringify({ default: {}, adhoc: {}, other_domain: {} }));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-scratch-'));
  // Pre-populate task-domains.json in the scratch dir with different content (still lists 'adhoc'
  // so the forced domain passes validation, but the non-adhoc entries differ from the live copy).
  const customDomains = { custom_domain: {}, adhoc: {}, another: {} };
  fs.writeFileSync(path.join(scratchDir, 'task-domains.json'), JSON.stringify(customDomains));

  const promptContextFile = path.join(scratchDir, 'ctx.json');
  fs.writeFileSync(promptContextFile, JSON.stringify({ rawText: 'idempotent copy' }));

  execFileSync('node', [
    path.join(__dirname, 'queue-adhoc-task.js'),
    '--scratch', scratchDir,
    '--repo-root', liveDir,
    '--title', 'Idempotent',
    '--prompt-context-file', promptContextFile,
  ], {
    env: { ...process.env, AGENT_MANAGER_PIPELINE_DIR: liveDir, AGENT_MANAGER_REPO_ROOT: liveDir },
  });

  // The pre-existing file must NOT have been overwritten
  const onDisk = JSON.parse(fs.readFileSync(path.join(scratchDir, 'task-domains.json'), 'utf8'));
  assert.deepEqual(onDisk, customDomains, 'pre-existing task-domains.json is not clobbered');
});

test('queueAdhocTask stamps generatedForRepoRoot when provided', () => {
  const dir = tmpPipeline();
  const { record } = queueAdhocTask(
    { title: 'Stamped', promptContext: { rawText: 'x' }, generatedForRepoRoot: '/some/repo' },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal(record.generatedForRepoRoot, '/some/repo');
});

test('queueAdhocTask omits generatedForRepoRoot when not provided', () => {
  const dir = tmpPipeline();
  const { record } = queueAdhocTask(
    { title: 'No stamp', promptContext: { rawText: 'x' } },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal('generatedForRepoRoot' in record, false);
});

test('queueAdhocTask records premium provenance only when premium is requested: the given label, "cli" when none is given', () => {
  const dir = tmpPipeline();
  const domainsPath = path.join(dir, 'task-domains.json');
  const mk = (extra) => queueAdhocTask({ title: 'Prov ' + Math.random().toString(36).slice(2, 6), promptContext: { rawText: 'x', raisedFrom: 'chat' }, ...extra }, { pipelineDir: dir, domainsPath }).record;

  const labelled = mk({ premiumPriority: true, premiumSetBy: 'chat-queue' });
  assert.equal(labelled.premiumSetBy, 'chat-queue');
  assert.ok(Number.isFinite(Date.parse(labelled.premiumSetAt)));

  const unlabelled = mk({ premiumPriority: true });
  assert.equal(unlabelled.premiumSetBy, 'cli');

  const plain = mk({});
  assert.equal('premiumSetBy' in plain, false);
  assert.equal('premiumSetAt' in plain, false);
  const labelOnly = mk({ premiumSetBy: 'chat-queue' });
  assert.equal('premiumSetBy' in labelOnly, false, 'a label without premiumPriority must not create provenance');
});

// --- stacked target (2026-11-04, Needs-Work repair loop piece 2): a repair task rides on an existing agent/* branch ---

const { normalizeStacked, stackedFromArgs } = require('./queue-adhoc-task.js');
const { prepareApplyBranch } = require('./apply-branch-prep-route.js');

const HUB_BRANCH = 'agent/decompose-adhoc-some-hub-1793475827469';
function queueWith(extra) {
  const dir = tmpPipeline();
  return queueAdhocTask(
    { title: 'Repair a hub piece', promptContext: { rawText: 'fix it', raisedFrom: 'needs-work worker' }, ...extra },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
}

test('a valid stacked target is written on the record with exactly the three keys apply reads, and on disk', () => {
  const { record, filePath } = queueWith({ stacked: { branch: HUB_BRANCH, seq: 4, total: 6 } });
  assert.deepEqual(record.stacked, { branch: HUB_BRANCH, seq: 4, total: 6 });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).stacked, { branch: HUB_BRANCH, seq: 4, total: 6 });
});

test('no stacked argument (or null) writes no stacked key at all: an ordinary task is unchanged', () => {
  assert.equal('stacked' in queueWith({}).record, false);
  assert.equal('stacked' in queueWith({ stacked: null }).record, false);
  assert.equal('stacked' in queueWith({ stacked: undefined }).record, false);
});

test('a stacked target that is refused throws, names the problem, and writes no file', () => {
  const bad = [
    [{ branch: 'master', seq: 2, total: 2 }, /stacked\.branch/, 'main/master'],
    [{ branch: 'main', seq: 2, total: 2 }, /stacked\.branch/, 'main'],
    [{ branch: 'feat/x', seq: 2, total: 2 }, /stacked\.branch/, 'not an agent branch'],
    [{ branch: '', seq: 2, total: 2 }, /stacked\.branch/, 'empty'],
    [{ branch: 'agent/', seq: 2, total: 2 }, /stacked\.branch/, 'agent/ alone'],
    [{ branch: 'agent/has space', seq: 2, total: 2 }, /stacked\.branch/, 'whitespace'],
    [{ branch: 'agent/a..b', seq: 2, total: 2 }, /stacked\.branch/, 'dot dot'],
    [{ branch: 7, seq: 2, total: 2 }, /stacked\.branch/, 'branch not a string'],
    [{ branch: HUB_BRANCH, seq: 1, total: 1 }, /stacked\.seq/, 'seq 1 recreates the branch'],
    [{ branch: HUB_BRANCH, seq: 0, total: 2 }, /stacked\.seq/, 'seq 0'],
    [{ branch: HUB_BRANCH, seq: 2.5, total: 3 }, /stacked\.seq/, 'seq fractional'],
    [{ branch: HUB_BRANCH, seq: '2', total: 2 }, /stacked\.seq/, 'seq a string'],
    [{ branch: HUB_BRANCH, seq: 3, total: 2 }, /stacked\.total/, 'total below seq'],
    [{ branch: HUB_BRANCH, seq: 2, total: '2' }, /stacked\.total/, 'total a string'],
    [{ branch: HUB_BRANCH, seq: 2, total: 2, extra: 1 }, /unknown key/, 'extra key'],
    [[HUB_BRANCH, 2, 2], /must be an object/, 'array'],
    ['agent/x', /must be an object/, 'a bare string'],
  ];
  for (const [stacked, re, why] of bad) {
    const dir = tmpPipeline();
    assert.throws(() => queueAdhocTask(
      { title: 'Repair', promptContext: { rawText: 'x' }, stacked },
      { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
    ), re, why);
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc')), false, `${why}: nothing is written on a refusal`);
  }
});

test('normalizeStacked returns a fresh object with only the three keys and accepts seq == total', () => {
  const input = { branch: HUB_BRANCH, seq: 2, total: 2 };
  const out = normalizeStacked(input);
  assert.deepEqual(out, input);
  assert.notEqual(out, input);
});

test('stackedFromArgs: only a branch defaults to seq 2 and total = seq; all three flags are used; none gives undefined', () => {
  assert.deepEqual(stackedFromArgs({ '--stacked-branch': HUB_BRANCH }), { branch: HUB_BRANCH, seq: 2, total: 2 });
  assert.deepEqual(stackedFromArgs({ '--stacked-branch': HUB_BRANCH, '--stacked-seq': '5' }), { branch: HUB_BRANCH, seq: 5, total: 5 });
  assert.deepEqual(stackedFromArgs({ '--stacked-branch': HUB_BRANCH, '--stacked-seq': '3', '--stacked-total': '7' }), { branch: HUB_BRANCH, seq: 3, total: 7 });
  assert.equal(stackedFromArgs({}), undefined);
  assert.throws(() => stackedFromArgs({ '--stacked-seq': '3' }), /need --stacked-branch/);
  assert.throws(() => stackedFromArgs({ '--stacked-total': '3' }), /need --stacked-branch/);
});

function runCli(args, dir) {
  const promptContextFile = path.join(dir, 'ctx.json');
  fs.writeFileSync(promptContextFile, JSON.stringify({ rawText: 'repair it' }));
  return require('child_process').spawnSync('node', [
    path.join(__dirname, 'queue-adhoc-task.js'), '--title', 'CLI repair', '--prompt-context-file', promptContextFile, ...args,
  ], { env: { ...process.env, AGENT_MANAGER_REPO_ROOT: dir, AGENT_MANAGER_PIPELINE_DIR: dir }, encoding: 'utf8' });
}
const cliRecord = (dir) => {
  const files = fs.readdirSync(path.join(dir, 'queue', 'adhoc'));
  assert.equal(files.length, 1);
  return JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', files[0]), 'utf8'));
};

test('CLI: --stacked-branch alone writes stacked {branch, 2, 2}; all three flags write what was given', () => {
  const a = tmpPipeline();
  assert.equal(runCli(['--stacked-branch', HUB_BRANCH], a).status, 0);
  assert.deepEqual(cliRecord(a).stacked, { branch: HUB_BRANCH, seq: 2, total: 2 });
  const b = tmpPipeline();
  assert.equal(runCli(['--stacked-branch', HUB_BRANCH, '--stacked-seq', '4', '--stacked-total', '6'], b).status, 0);
  assert.deepEqual(cliRecord(b).stacked, { branch: HUB_BRANCH, seq: 4, total: 6 });
});

test('CLI: without any stacked flag the record has no stacked key', () => {
  const dir = tmpPipeline();
  assert.equal(runCli([], dir).status, 0);
  assert.equal('stacked' in cliRecord(dir), false);
});

test('CLI: --stacked-seq without --stacked-branch exits 1 with a message and writes nothing', () => {
  const dir = tmpPipeline();
  const r = runCli(['--stacked-seq', '3'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /need --stacked-branch/);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc')), false);
});

test('CLI: a refused target (main) exits 1 and writes nothing', () => {
  const dir = tmpPipeline();
  const r = runCli(['--stacked-branch', 'master'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stacked\.branch/);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc')), false);
});

test('CLI --scratch path carries the stacked target too', () => {
  const live = tmpPipeline();
  fs.writeFileSync(path.join(live, 'task-domains.json'), JSON.stringify({ default: {}, adhoc: {} }));   // the scratch path forces domain 'adhoc'
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-scratch-'));
  fs.writeFileSync(path.join(live, 'ctx.json'), JSON.stringify({ rawText: 'x' }));
  const r = require('child_process').spawnSync('node', [
    path.join(__dirname, 'queue-adhoc-task.js'), '--title', 'Scratch repair', '--prompt-context-file', path.join(live, 'ctx.json'),
    '--scratch', scratch, '--repo-root', live, '--stacked-branch', HUB_BRANCH, '--stacked-seq', '3',
  ], { env: { ...process.env, AGENT_MANAGER_REPO_ROOT: live, AGENT_MANAGER_PIPELINE_DIR: live, AGENT_MANAGER_DOMAINS_PATH: path.join(live, 'task-domains.json') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(cliRecord(scratch).stacked, { branch: HUB_BRANCH, seq: 3, total: 3 });
  assert.equal(fs.existsSync(path.join(live, 'queue', 'adhoc')), false, 'the live pipeline dir is untouched');
});

test('contract with apply: a record queued with a stacked target makes prepareApplyBranch ride on that branch (prepareStackedBranch only, never reset, delete or create)', () => {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const gitRunner = {
    resetToMain: rec('resetToMain'), deleteBranch: rec('deleteBranch'), createBranch: rec('createBranch'),
    remoteHasUnmergedWork: () => false, prepareStackedBranch: rec('prepareStackedBranch'),
  };
  const { record } = queueWith({ stacked: { branch: HUB_BRANCH, seq: 2, total: 2 } });
  const out = prepareApplyBranch(record, { gitRunner, commitsDirectlyToMain: false });
  assert.equal(out.branchName, HUB_BRANCH);
  assert.deepEqual(calls, [['prepareStackedBranch', HUB_BRANCH]]);
});

// An empty or missing value after a --stacked-* flag must be REFUSED, never dropped: dropping it files an ordinary task off main (an empty shell variable did exactly that).
test('CLI: --stacked-branch with an empty value exits 1 and writes nothing (not an ordinary task)', () => {
  const dir = tmpPipeline();
  const r = runCli(['--stacked-branch', ''], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stacked\.branch/);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc')), false);
});

test('CLI: --stacked-branch as the last argument (no value at all) exits 1 and writes nothing', () => {
  const dir = tmpPipeline();
  const r = runCli(['--stacked-branch'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stacked\.branch/);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc')), false);
});

test('CLI: an empty --stacked-seq or --stacked-total value is refused, not replaced by the default', () => {
  for (const flags of [['--stacked-seq', ''], ['--stacked-total', '']]) {
    const dir = tmpPipeline();
    const r = runCli(['--stacked-branch', HUB_BRANCH, ...flags], dir);
    assert.equal(r.status, 1, `${flags[0]}: exit status`);
    assert.match(r.stderr, /stacked\.(seq|total)/, `${flags[0]}: message names the field`);
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc')), false, `${flags[0]}: nothing written`);
  }
});

test('stackedFromArgs: an empty branch value is passed on (and so refused), not treated as absent', () => {
  assert.deepEqual(stackedFromArgs({ '--stacked-branch': '' }), { branch: '', seq: 2, total: 2 });
  assert.throws(() => normalizeStacked(stackedFromArgs({ '--stacked-branch': '' })), /stacked\.branch/);
});
