'use strict';

// Run: node --test python/dashboard/static/js/touchpoints-card.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { touchpointsChipModel } = require('./touchpoints-card.js');

test('chip shows today and lists what is not countable', () => {
  const m = touchpointsChipModel({ days: [{ date: 'a', requeues: 2 }, { date: 'b', requeues: 5 }], notCountable: [{ action: 'merge', gap: 'gap 1' }] });
  assert.equal(m.text, 'owner requeues today: 5');
  assert.match(m.title, /7 operator requeues in the last 2 days/);
  assert.match(m.title, /merge: gap 1/);
});

test('no data gives no chip', () => {
  assert.equal(touchpointsChipModel(null), null);
  assert.equal(touchpointsChipModel({ days: [] }), null);
});

test('the stream event touchpoints-changed plans a chip refresh and nothing else', () => {
  const { planForEvent, isEmptyPlan, mergePlans } = require('./live-updates.js');
  const plan = planForEvent('touchpoints-changed', 'workers', null, null, null);
  assert.equal(plan.touchpoints, true);
  assert.equal(plan.main || plan.summary || plan.nav || plan.panels, false);
  assert.equal(isEmptyPlan(plan), false);
  assert.equal(mergePlans(planForEvent('workers-changed', 'workers'), plan).touchpoints, true);
});

test('applyLivePlan refreshes the chip when the plan asks for it, and only then', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const src = fs.readFileSync(require('node:path').join(__dirname, 'branches-joblist-hardware-tabs.js'), 'utf8');
  const m = /async function applyLivePlan\(plan\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, 'applyLivePlan found');
  let calls = 0;
  const ctx = vm.createContext({ refreshTouchpointsChip: async () => { calls += 1; } });
  vm.runInContext(m[0] + '; this.applyLivePlan = applyLivePlan;', ctx);
  await ctx.applyLivePlan({ touchpoints: true });
  assert.equal(calls, 1);
  await ctx.applyLivePlan({ touchpoints: false });
  assert.equal(calls, 1);
});
