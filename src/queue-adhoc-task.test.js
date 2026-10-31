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

// --- ownership guard tests ---

test('ownership guard: matching project allows the task', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-task-test-'));
  // Create a projects.json array with an entry whose pipelineDir matches and repo matches
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify([{ pipelineDir: dir, repo: 'owner/test-repo' }])
  );
  fs.writeFileSync(path.join(dir, 'task-domains.json'), JSON.stringify({ default: {}, adhoc: {} }));
  // Create a file that the task will reference, under this pipeline dir
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'main.py'), '# code');

  const { record } = queueAdhocTask(
    { title: 'Fix main.py', promptContext: { rawText: 'fix src/main.py in agent-manager' } },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal(record.title, 'Fix main.py');
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'adhoc')));
});

test('ownership guard: mismatching project refuses the task', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-task-test-'));
  // Create two projects: one where the file actually is, one we're queueing for
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-task-other-'));
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify([
      { pipelineDir: otherDir, repo: 'owner/other-repo' },
      { pipelineDir: dir, repo: 'owner/wrong-repo' },
    ])
  );
  fs.writeFileSync(path.join(dir, 'task-domains.json'), JSON.stringify({ default: {}, adhoc: {} }));
  // Create the file under the OTHER project's pipeline dir (so it "belongs" to other-repo)
  fs.mkdirSync(path.join(otherDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'src', 'main.py'), '# code');

  assert.throws(
    () => queueAdhocTask(
      { title: 'Fix main.py', promptContext: { rawText: 'fix src/main.py in agent-manager' } },
      { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
    ),
    /Refusing adhoc task.*does not own/
  );
  // Should NOT have written the task
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc')), false);
});

test('ownership guard: no matching project falls back to AGENT_MANAGER_REPO_ROOT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-task-test-'));
  // Create a projects.json with no entry matching this pipelineDir
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify([{ pipelineDir: '/nonexistent/path', repo: 'owner/some-repo' }])
  );
  fs.writeFileSync(path.join(dir, 'task-domains.json'), JSON.stringify({ default: {}, adhoc: {} }));
  // Create a file that the task will reference
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'main.py'), '# code');

  const env = { ...process.env, AGENT_MANAGER_REPO_ROOT: 'owner/fallback-repo' };
  const { record } = queueAdhocTask(
    { title: 'Fix main.py', promptContext: { rawText: 'fix src/main.py' } },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal(record.title, 'Fix main.py');
  // The task should be written (no error thrown)
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'adhoc')));
});

test('ownership guard: no files referenced skips the guard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-task-test-'));
  // Create a projects.json with a mismatching repo
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify([{ pipelineDir: dir, repo: 'owner/wrong-repo' }])
  );
  fs.writeFileSync(path.join(dir, 'task-domains.json'), JSON.stringify({ default: {}, adhoc: {} }));

  // Task with no file references (just text)
  const { record } = queueAdhocTask(
    { title: 'Generic task', promptContext: { rawText: 'do something without referencing files' } },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal(record.title, 'Generic task');
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'adhoc')));
});
