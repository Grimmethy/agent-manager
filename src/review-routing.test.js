'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeReviewOrder } = require('./review-routing');

const NOW = 1000000000000;
const fresh = (id, extra = {}) => ({ id, enqueuedAt: NOW - 1000, ...extra });
const cloud = (id, extra = {}) => ({ id, cloud: true, free: true, reviews: true, ...extra });
const local = (id, extra = {}) => ({ id, cloud: false, free: true, reviews: true, ...extra });

test('at or below threshold with nothing stale returns input order unchanged', () => {
  const records = [fresh('1'), fresh('2'), fresh('3')];
  const out = routeReviewOrder({ records, lanes: [], threshold: 5, now: NOW });
  assert.equal(out.unchanged, true);
  assert.deepEqual(out.assignments.map(a => a.record.id), ['1', '2', '3']);
});

test('a stale record triggers routing even below threshold', () => {
  const records = [fresh('old', { enqueuedAt: NOW - 1000000 })];
  const out = routeReviewOrder({ records, lanes: [cloud('c1'), local('l1')], threshold: 5, maxWaitS: 900, now: NOW });
  assert.equal(out.unchanged, false);
  assert.equal(out.assignments[0].lane.id, 'c1');
});

test('node drafts take free cloud lanes before local lanes', () => {
  const records = [fresh('plain'), fresh('draft', { fromNode: 'grimm' })];
  const out = routeReviewOrder({ records, lanes: [local('l1'), cloud('c1')], threshold: 1, now: NOW });
  assert.equal(out.assignments[0].record.id, 'draft');
  assert.equal(out.assignments[0].lane.id, 'c1');
});

test('local lane used only when no cloud lane is free', () => {
  const records = [fresh('draft', { fromNode: 'grimm' })];
  const out = routeReviewOrder({ records, lanes: [cloud('c1', { free: false }), local('l1')], threshold: 0, now: NOW });
  assert.equal(out.assignments[0].lane.id, 'l1');
});

test('lanes with reviews false are never selected', () => {
  const records = [fresh('draft', { fromNode: 'grimm' })];
  const out = routeReviewOrder({ records, lanes: [cloud('c1', { reviews: false })], threshold: 0, now: NOW });
  assert.deepEqual(out.assignments, []);
});

test('claimed records are never assigned', () => {
  const records = [fresh('claimed', { leasedTo: 'node-x', fromNode: 'grimm' }), fresh('open')];
  const out = routeReviewOrder({ records, lanes: [cloud('c1')], threshold: 0, now: NOW });
  assert.deepEqual(out.assignments.map(a => a.record.id), ['open']);
});

test('threshold defaults to 5 when the env var is unset', () => {
  delete process.env.AGENT_MANAGER_REVIEW_CLOUD_THRESHOLD;
  const records = Array.from({ length: 5 }, (_, i) => fresh('r' + i));
  assert.equal(routeReviewOrder({ records, lanes: [], now: NOW }).unchanged, true);
});
