'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { queueAdhocTask, defaultTaskDomain, isProjectRegistered } = require('./queue-adhoc-task.js');

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

// (2026-10-27, HUB0213-0: Grimmethy: "the queue should not drop a task into a project
// that does not exist in projects.json; instead hold it so sweepHeldForProject() can route
// it later when the project is registered").
test('isProjectRegistered: returns true for a project in projects.json, false otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-adhoc-task-test-'));
  const registryPath = path.join(dir, 'projects.json');
  const alphaDir = fs.mkdtempSync(path.join(dir, 'alpha-'));
  const betaDir = fs.mkdtempSync(path.join(dir, 'beta-'));
  fs.writeFileSync(registryPath, JSON.stringify([
    { label: 'Alpha', repoRoot: alphaDir },
    { label: 'Beta', repoRoot: betaDir },
  ]));

  // isProjectRegistered() reads the registry via listProjects() which honours
  // AGENT_MANAGER_PROJECTS_REGISTRY_PATH; point it at our fixture.
  const origEnv = process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH;
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = registryPath;
  try {
    assert.equal(isProjectRegistered('Alpha', alphaDir), true);
    assert.equal(isProjectRegistered('alpha', alphaDir), true, 'case-insensitive label match');
    assert.equal(isProjectRegistered('Gamma', '/nope'), false, 'unknown project');
    assert.equal(isProjectRegistered('Alpha', '/nope'), false, 'mismatched repoRoot');
    assert.equal(isProjectRegistered('', alphaDir), false, 'empty name');
    assert.equal(isProjectRegistered('Alpha', ''), false, 'empty repoRoot');
    assert.equal(isProjectRegistered('Alpha', null), false, 'null repoRoot');
  } finally {
    if (origEnv === undefined) delete process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH;
    else process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = origEnv;
  }
});

test('queueAdhocTask: holds task to held-for-project when targetProject is unregistered', () => {
  const dir = tmpPipeline();
  const { record, filePath } = queueAdhocTask(
    {
      title: 'Merge AC-57',
      promptContext: { rawText: 'merge it' },
      targetProject: { name: 'Gamma', repoRoot: '/nope' },
    },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal(record.heldForProject, true, 'must be stamped heldForProject:true');
  assert.equal(record.targetProject.name, 'Gamma');
  assert.ok(filePath.startsWith(path.join(dir, 'queue', 'held-for-project', 'gamma')), `expected held path, got ${filePath}`);
  assert.ok(fs.existsSync(filePath));
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(onDisk, record);
});

test('queueAdhocTask: holds task to held-for-project when targetProject is missing name or repoRoot', () => {
  const dir = tmpPipeline();
  const { record: noName, filePath: noNamePath } = queueAdhocTask(
    { title: 'X', promptContext: {}, targetProject: { repoRoot: '/x' } },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal(noName.heldForProject, true);
  assert.ok(noNamePath.startsWith(path.join(dir, 'queue', 'held-for-project')));

  const { record: noRoot, filePath: noRootPath } = queueAdhocTask(
    { title: 'Y', promptContext: {}, targetProject: { name: 'Alpha' } },
    { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
  );
  assert.equal(noRoot.heldForProject, true);
  assert.ok(noRootPath.startsWith(path.join(dir, 'queue', 'held-for-project')));
});

test('queueAdhocTask: writes to normal adhoc queue when targetProject is registered', () => {
  const dir = tmpPipeline();
  const projectsDir = fs.mkdtempSync(path.join(dir, 'projects-'));
  const alphaDir = fs.mkdtempSync(path.join(projectsDir, 'alpha-'));
  const registryPath = path.join(projectsDir, 'projects.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ label: 'Alpha', repoRoot: alphaDir }]));

  // Temporarily override the registry path so isProjectRegistered finds it.
  const origEnv = process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH;
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = registryPath;
  try {
    const { record, filePath } = queueAdhocTask(
      { title: 'X', promptContext: {}, targetProject: { name: 'Alpha', repoRoot: alphaDir } },
      { pipelineDir: dir, domainsPath: path.join(dir, 'task-domains.json') },
    );
    assert.equal(record.heldForProject, undefined, 'must NOT be stamped heldForProject when registered');
    assert.equal(record.targetProject.name, 'Alpha');
    assert.ok(filePath.startsWith(path.join(dir, 'queue', 'adhoc')), `expected adhoc path, got ${filePath}`);
  } finally {
    if (origEnv === undefined) delete process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH;
    else process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = origEnv;
  }
});
