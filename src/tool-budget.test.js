'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { VERDICT, createToolBudget } = require('./tool-budget.js');
const profiles = require('./tool-budget-profiles.json');

test('ok up to budget, soft at budget+1, over until budget*multiple, hard after', () => {
  const b = createToolBudget({ budget: 4, multiple: 2 });
  const v = [];
  for (let i = 0; i < 9; i++) v.push(b.record().verdict);
  assert.deepEqual(v.slice(0, 4), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(v[4], VERDICT.SOFT);
  assert.deepEqual(v.slice(5, 8), ['over', 'over', 'over']);
  assert.equal(v[8], VERDICT.HARD);
});

test('soft nudge fires exactly once across many calls', () => {
  const b = createToolBudget({ budget: 2, multiple: 50 });
  let soft = 0;
  for (let i = 0; i < 60; i++) if (b.record().verdict === VERDICT.SOFT) soft += 1;
  assert.equal(soft, 1);
});

test('each budget run has its own tracker', () => {
  const a = createToolBudget({ budget: 1, multiple: 2 });
  const c = createToolBudget({ budget: 1, multiple: 2 });
  a.record();
  a.record();
  assert.equal(c.record().verdict, VERDICT.OK);
});

test('invalid profile throws', () => {
  assert.throws(() => createToolBudget({ budget: 'x', multiple: 2 }), TypeError);
  assert.throws(() => createToolBudget(null), TypeError);
});

test('profiles define numeric budget and multiple for reviewer, drafter and apply', () => {
  for (const role of ['reviewer', 'drafter', 'apply']) {
    assert.equal(typeof profiles[role].budget, 'number');
    assert.equal(typeof profiles[role].multiple, 'number');
  }
  assert.match(profiles.measurement, /Sample size: \d+ runs/);
});

test('tool-budget.js has no timers', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tool-budget.js'), 'utf8');
  assert.doesNotMatch(src, /setInterval|setTimeout|schedule\.every|while \(true\)/);
});
