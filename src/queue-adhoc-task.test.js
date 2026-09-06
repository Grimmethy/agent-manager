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
  assert.deepEqual(record.promptContext, { rawText: 'merge it', raisedFrom: 'chat' });
  assert.match(record.id, /^adhoc-merge-ac-57-\d+$/);
  assert.ok(fs.existsSync(filePath));
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(onDisk, record);
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
