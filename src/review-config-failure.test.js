'use strict';

// A pipeline whose task-domains.json lacks a task's domain (2026-10-26: questforge, sparforge, lead-call-desk, uxforge were provisioned with
// only "default") used to fail every adhoc review with "Unknown task domain: adhoc (valid: default)". review-runner.sh counted that as a failed
// review, blocked the task after 5-7 tries, and the staleness flag then called it retries-exhausted / capability-ceiling although nothing was
// wrong with the work. These tests pin the message and the runner branch that treats it as a configuration problem instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// review-task.js reads its config at load time (same preamble as src/review-repro.test.js).
process.env.AGENT_MANAGER_REPO_ROOT = os.tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;
process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false';
process.env.AGENT_MANAGER_REVIEW_INERT_CHECK = 'false';
process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE = 'false';
process.env.AGENT_MANAGER_REVIEW_UNDEFINED_CHECK = 'false';

const { getDomainConfig } = require('./review-task.js');

const RUNNER = path.join(__dirname, '..', 'scripts', 'review-runner.sh');
const runnerText = fs.readFileSync(RUNNER, 'utf8');

function tmpFile(name, content) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-failure-'));
  const p = path.join(d, name);
  fs.writeFileSync(p, content);
  return p;
}

// The branch body: from the elif that matches the config failure to the generic else that follows it.
function configBranch() {
  const start = runnerText.indexOf('elif grep -qE "Unknown task domain:"');
  assert.ok(start > 0, 'review-runner.sh has no branch for "Unknown task domain:"');
  const end = runnerText.indexOf('\n    else\n', start);
  assert.ok(end > start, 'the config-failure branch is not followed by the generic else');
  return { start, text: runnerText.slice(start, end) };
}

test('getDomainConfig returns a listed domain', () => {
  const p = tmpFile('task-domains.json', JSON.stringify({ adhoc: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  assert.deepEqual(getDomainConfig(p, 'adhoc'), { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' });
});

test('an unlisted domain names the file and the fix, and keeps the prefix the runner matches on', () => {
  const p = tmpFile('task-domains.json', JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  assert.throws(() => getDomainConfig(p, 'xyzzy-nonexistent-domain'), (e) => {
    assert.ok(e.message.startsWith('Unknown task domain: xyzzy-nonexistent-domain (valid: default)'), e.message);
    assert.ok(e.message.includes(p), 'the message should name the domains file it read');
    assert.ok(e.message.includes('ensure-task-domains.sh'), 'the message should name the fix');
    return true;
  });
});

test('adhoc is a standard domain and self-heals the file instead of throwing', () => {
  const p = tmpFile('task-domains.json', JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  const cfg = getDomainConfig(p, 'adhoc');
  assert.deepEqual(cfg, { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' });
  const reloaded = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(reloaded.adhoc, 'the self-heal should write adhoc back into the file');
  assert.deepEqual(reloaded.adhoc, { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' });
});

test('review-runner.sh still parses', () => {
  const r = spawnSync('bash', ['-n', RUNNER], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('the config-failure branch sits before the generic failure counter and never counts, requeues or blocks', () => {
  const { start, text } = configBranch();
  const counter = runnerText.indexOf('o.reviewFailureCount = (o.reviewFailureCount || 0) + 1');
  assert.ok(counter > start, 'the generic reviewFailureCount increment must come after the config branch');
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // the comments explain the old behaviour and name these fields
  assert.ok(!code.includes('reviewFailureCount'), 'the config branch must not touch reviewFailureCount');
  assert.ok(!code.includes('reviewInfraRequeueCount'), 'the config branch must not start an infra requeue round');
  assert.ok(!/mv -n/.test(code) && !code.includes('/blocked/'), 'the config branch must not move the task to blocked/');
  assert.ok(code.includes('config-error') && code.includes('ensure-task-domains.sh'));
});

test('the history note in the config branch is written once, however many ticks repeat it', () => {
  const { text } = configBranch();
  const m = text.match(/node -e '([\s\S]*?)' "\$file"/);
  assert.ok(m, 'could not find the node snippet in the config branch');
  const task = tmpFile('task.json', JSON.stringify({ id: 't', history: [{ stage: 'draft-attempt', at: 'x', detail: 'y' }] }));
  for (let i = 0; i < 3; i++) {
    const r = spawnSync('node', ['-e', m[1], task], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const after = JSON.parse(fs.readFileSync(task, 'utf8'));
  assert.equal(after.history.filter((h) => h.stage === 'config-error').length, 1);
  assert.equal(after.history.length, 2);
  assert.equal(after.reviewFailureCount, undefined);
});
