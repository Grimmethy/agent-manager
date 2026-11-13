'use strict';

// review-task.js reads its config at load time (same preamble as review-task.test.js): a temp repo root, executed verification off.
process.env.AGENT_MANAGER_REPO_ROOT = require('node:os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;
process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false';

const test = require('node:test');
const assert = require('node:assert');
require('./task-sources.js');
const lines = require('./lib/poll-avoidance-lines.js');
const { buildPlanPrompt, buildImplementPrompt, groupBJsonInstructions } = require('./prompts.js');
const { buildVerdictPrompt } = require('./review-task.js');

const adhoc = { domain: 'adhoc', source: 'manual', title: 'add a status refresh', promptContext: { rawText: 'refresh the status panel when it changes' } };
const verdictTask = {
  title: 'add a status refresh', domain: 'adhoc', source: 'manual', planResponse: '1. edit panel.js', implementResponse: JSON.stringify([{ mode: 'edit', file: 'panel.js', find: 'a', replace: 'b' }]),
  promptContext: { rawText: 'x' },
};

test('the shared lines name ADR-0024, define a poll, and say how to annotate one: poll-ok with a reason', () => {
  assert.strictEqual(lines.POLL_OK_TOKEN, 'poll-ok:');
  for (const text of [lines.PLAN_LINES, lines.IMPLEMENT_LINES, lines.REVIEW_LINES]) {
    assert.match(text, /ADR-0024/);
    assert.match(text, /poll-ok: /);
    assert.match(text, /one-shot sleep/i);
    assert.doesNotMatch(text, /\n/);
  }
  assert.match(lines.WHAT_A_POLL_IS, /setInterval/);
  assert.match(lines.WHAT_A_POLL_IS, /setTimeout that re-arms itself/);
  assert.match(lines.WHAT_A_POLL_IS, /while-true loop that sleeps/);
  assert.match(lines.WHAT_A_POLL_IS, /cron/);
  assert.match(lines.PLAN_LINES, /plan the EVENT/);
  assert.match(lines.PLAN_LINES, /measured idle cost/);
  assert.match(lines.IMPLEMENT_LINES, /empty reason does not count/);
  assert.match(lines.IMPLEMENT_LINES, /Leave polls that were already in the file alone/);
  assert.match(lines.REVIEW_LINES, /ADDED line/);
  assert.match(lines.REVIEW_LINES, /already in the file are NOT grounds to reject/);
});

test('the three texts are different jobs: plan names the event, implement forbids adding, review rejects added polls only', () => {
  assert.notStrictEqual(lines.PLAN_LINES, lines.IMPLEMENT_LINES);
  assert.notStrictEqual(lines.IMPLEMENT_LINES, lines.REVIEW_LINES);
  assert.doesNotMatch(lines.PLAN_LINES, /vote REJECT/);
  assert.doesNotMatch(lines.IMPLEMENT_LINES, /vote REJECT/);
  assert.match(lines.REVIEW_LINES, /vote REJECT unless/);
  assert.match(lines.IMPLEMENT_LINES, /do not add setInterval/);
});

test('the lines module imports nothing (it can move with the detector)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'lib', 'poll-avoidance-lines.js'), 'utf8');
  assert.doesNotMatch(src, /require\(/);
});

test('the adhoc plan prompt carries the plan lines once, after the PLAN instruction and before the CRITERIA instruction', () => {
  const prompt = buildPlanPrompt(adhoc);
  assert.strictEqual(prompt.split(lines.PLAN_LINES).length - 1, 1);
  assert.ok(prompt.indexOf('Write a numbered, actionable PLAN.') < prompt.indexOf(lines.PLAN_LINES));
  assert.ok(prompt.indexOf(lines.PLAN_LINES) < prompt.indexOf('CRITERIA:'));
});

test('the adhoc implement prompt carries the implement lines once, before the JSON instructions, and the plan text stays first', () => {
  const prompt = buildImplementPrompt(adhoc, 'PLAN-TEXT-MARKER');
  assert.strictEqual(prompt.split(lines.IMPLEMENT_LINES).length - 1, 1);
  assert.ok(prompt.indexOf('PLAN-TEXT-MARKER') < prompt.indexOf(lines.IMPLEMENT_LINES));
  assert.ok(prompt.indexOf(lines.IMPLEMENT_LINES) < prompt.indexOf(groupBJsonInstructions.slice(0, 40)));
  assert.doesNotMatch(prompt, /POLL CHECK/);
});

test('the reviewer verdict prompt carries the review lines once, ahead of the task and the draft', () => {
  const prompt = buildVerdictPrompt(verdictTask, { flags: [] }, '');
  assert.strictEqual(prompt.split(lines.REVIEW_LINES).length - 1, 1);
  assert.ok(prompt.indexOf('treat every concrete claim as UNVERIFIED') < prompt.indexOf(lines.REVIEW_LINES));
  assert.ok(prompt.indexOf(lines.REVIEW_LINES) < prompt.indexOf('--- PLAN ---'));
  assert.ok(prompt.indexOf(lines.REVIEW_LINES) < prompt.indexOf('--- IMPLEMENT draft ---'));
});

test('only the adhoc/manual plan and implement builders carry the poll lines: each constant is used exactly once in prompts.js', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'prompts.js'), 'utf8');
  assert.strictEqual(src.split('POLL_PLAN_LINES').length - 1, 2);        // the require and the one use in adhocPlanPrompt
  assert.strictEqual(src.split('POLL_IMPLEMENT_LINES').length - 1, 2);   // the require and the one use in adhocImplementPrompt
  assert.ok(src.lastIndexOf('POLL_PLAN_LINES,') > src.indexOf('function adhocPlanPrompt') && src.lastIndexOf('POLL_PLAN_LINES,') < src.indexOf('function unusedExportPlanPrompt'));
  assert.ok(src.lastIndexOf('POLL_IMPLEMENT_LINES,') > src.indexOf('function adhocImplementPrompt'));
});
