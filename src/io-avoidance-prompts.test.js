'use strict';

// review-task.js reads its config at load time (same preamble as review-task.test.js): a temp repo root, executed verification off.
process.env.AGENT_MANAGER_REPO_ROOT = require('node:os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;
process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false';

const test = require('node:test');
const assert = require('node:assert');
require('./task-sources.js');
const lines = require('./lib/io-avoidance-lines.js');
const { buildPlanPrompt, buildImplementPrompt, groupBJsonInstructions } = require('./prompts.js');
const { buildVerdictPrompt } = require('./review-task.js');

const adhoc = { domain: 'adhoc', source: 'manual', title: 'add a status refresh', promptContext: { rawText: 'refresh the status panel when it changes' } };
const verdictTask = {
  title: 'add a status refresh', domain: 'adhoc', source: 'manual', planResponse: '1. edit panel.js', implementResponse: JSON.stringify([{ mode: 'edit', file: 'panel.js', find: 'a', replace: 'b' }]),
  promptContext: { rawText: 'x' },
};

test('the shared lines say what reloads the model, name src/local-client.js, and how to annotate: io-ok with a reason', () => {
  assert.strictEqual(lines.IO_OK_TOKEN, 'io-ok:');
  for (const text of [lines.PLAN_LINES, lines.IMPLEMENT_LINES, lines.REVIEW_LINES]) {
    assert.match(text, /src\/local-client\.js/);
    assert.doesNotMatch(text, /\n/);
  }
  assert.match(lines.PLAN_LINES, /ONE local model resident/);
  assert.match(lines.PLAN_LINES, /never chooses a context size, a keep-alive or a model/);
  assert.match(lines.IMPLEMENT_LINES, /io-ok: /);
  assert.match(lines.IMPLEMENT_LINES, /empty reason does not count/);
  assert.match(lines.REVIEW_LINES, /io-ok: /);
  assert.match(lines.WHAT_RELOADS_THE_MODEL, /num_ctx/);
  assert.match(lines.WHAT_RELOADS_THE_MODEL, /keep_alive/);
  assert.match(lines.WHAT_RELOADS_THE_MODEL, /\/api\/generate or \/api\/chat/);
});

test('the three texts are different jobs: plan forbids choosing, implement forbids writing, review rejects added lines only', () => {
  assert.notStrictEqual(lines.PLAN_LINES, lines.IMPLEMENT_LINES);
  assert.notStrictEqual(lines.IMPLEMENT_LINES, lines.REVIEW_LINES);
  assert.doesNotMatch(lines.PLAN_LINES, /vote REJECT/);
  assert.doesNotMatch(lines.IMPLEMENT_LINES, /vote REJECT/);
  assert.match(lines.REVIEW_LINES, /vote REJECT unless/);
  assert.match(lines.REVIEW_LINES, /ADDED line/);
  assert.match(lines.REVIEW_LINES, /already in the file are NOT grounds to reject/);
});

test('the lines module imports nothing (it can move with the detector)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'lib', 'io-avoidance-lines.js'), 'utf8');
  assert.doesNotMatch(src, /require\(/);
});

test('the lines use the same token the detector parses', () => {
  const detector = require('./lib/io-churn-detector.js');
  assert.strictEqual(lines.IO_OK_TOKEN, detector.IO_OK_TOKEN);
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
  assert.doesNotMatch(prompt, /MODEL RELOAD CHECK/);
});

test('the reviewer verdict prompt carries the review lines once, ahead of the task and the draft', () => {
  const prompt = buildVerdictPrompt(verdictTask, { flags: [] }, '');
  assert.strictEqual(prompt.split(lines.REVIEW_LINES).length - 1, 1);
  assert.ok(prompt.indexOf('treat every concrete claim as UNVERIFIED') < prompt.indexOf(lines.REVIEW_LINES));
  assert.ok(prompt.indexOf(lines.REVIEW_LINES) < prompt.indexOf('--- PLAN ---'));
  assert.ok(prompt.indexOf(lines.REVIEW_LINES) < prompt.indexOf('--- IMPLEMENT draft ---'));
});

test('each constant is used exactly once in prompts.js and review-task.js', () => {
  const read = (f) => require('node:fs').readFileSync(require('node:path').join(__dirname, f), 'utf8');
  const prompts = read('prompts.js');
  assert.strictEqual(prompts.split('IO_PLAN_LINES').length - 1, 2);        // the require and the one use in adhocPlanPrompt
  assert.strictEqual(prompts.split('IO_IMPLEMENT_LINES').length - 1, 2);   // the require and the one use in adhocImplementPrompt
  assert.ok(prompts.lastIndexOf('IO_PLAN_LINES,') > prompts.indexOf('function adhocPlanPrompt') && prompts.lastIndexOf('IO_PLAN_LINES,') < prompts.indexOf('function unusedExportPlanPrompt'));
  assert.ok(prompts.lastIndexOf('IO_IMPLEMENT_LINES,') > prompts.indexOf('function adhocImplementPrompt'));
  assert.strictEqual(read('review-task.js').split('REVIEW_IO_LINES').length - 1, 2);   // the require and the one push
});

test('the prompt-line module has no unannotated model-reload cause (its one endpoint-naming line carries io-ok)', () => {
  const { scanText } = require('./lib/io-churn-detector.js');
  const text = require('node:fs').readFileSync(require('node:path').join(__dirname, 'lib', 'io-avoidance-lines.js'), 'utf8');
  const findings = scanText({ language: 'js', path: 'src/lib/io-avoidance-lines.js', text });
  assert.ok(findings.length >= 1, 'the module names the endpoints, so the scan must see them');
  assert.deepStrictEqual(findings.filter((f) => !f.annotated), []);
});
