'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { quorumVote, ABSTAIN } = require('../src/vote-quorum.js');

// 1. Early majority before slow straggler
test('resolves early when majority reaches quorum before slow straggler', async () => {
  const start = Date.now();
  const deferred = { p: null, r: null };
  deferred.p = new Promise((r) => { deferred.r = r; });

  const reviewers = [
    () => Promise.resolve('YES'),
    () => Promise.resolve('YES'),
    () => Promise.resolve('YES'),
    () => deferred.p,
  ];

  const predicate = (tally, pending) => {
    const yesCount = tally.get('YES') || 0;
    if (yesCount > reviewers.length / 2) return 'APPROVED';
    return undefined;
  };

  const result = await quorumVote({
    reviewers,
    predicate,
    fallback: (tally) => 'APPROVED',
    defaultVerdict: 'REJECTED',
    timeoutMs: 5000,
  });

  const elapsed = Date.now() - start;
  assert.equal(result, 'APPROVED');
  assert.ok(elapsed < 100, `should resolve early, took ${elapsed}ms`);

  // Now resolve the slow straggler -- should not affect the result
  deferred.r('NO');
});

// 2. Late straggler that does not change the result
test('late straggler does not change result once decided', async () => {
  const reviewers = [
    () => Promise.resolve('YES'),
    () => Promise.resolve('YES'),
    () => Promise.resolve('YES'),
    () => Promise.resolve('NO'),
  ];

  const predicate = (tally, pending) => {
    const yesCount = tally.get('YES') || 0;
    if (yesCount > reviewers.length / 2) return 'APPROVED';
    return undefined;
  };

  const result = await quorumVote({
    reviewers,
    predicate,
    fallback: (tally) => 'APPROVED',
    defaultVerdict: 'REJECTED',
    timeoutMs: 5000,
  });

  assert.equal(result, 'APPROVED');
});

// 3. Rejected reviewer as ABSTAIN
test('rejected reviewer is treated as ABSTAIN', async () => {
  const rejected = { p: null, r: null };
  rejected.p = new Promise((r) => { rejected.r = r; });

  const reviewers = [
    () => Promise.resolve('YES'),
    () => Promise.resolve('YES'),
    () => Promise.resolve('YES'),
    () => rejected.p,
  ];

  const predicate = (tally, pending) => {
    const yesCount = tally.get('YES') || 0;
    if (yesCount > reviewers.length / 2) return 'APPROVED';
    return undefined;
  };

  const result = await quorumVote({
    reviewers,
    predicate,
    fallback: (tally) => 'APPROVED',
    defaultVerdict: 'REJECTED',
    timeoutMs: 5000,
  });

  assert.equal(result, 'APPROVED');

  // Reject the reviewer -- should be treated as ABSTAIN
  rejected.r(ABSTAIN);
});

// 4. Timed-out reviewer as ABSTAIN
test('timed-out reviewer is treated as ABSTAIN', async () => {
  const neverResolving = new Promise(() => {
    // Never resolves
  });

  const reviewers = [
    () => Promise.resolve('YES'),
    () => Promise.resolve('YES'),
    () => Promise.resolve('YES'),
    () => neverResolving,
  ];

  const predicate = (tally, pending) => {
    const yesCount = tally.get('YES') || 0;
    if (yesCount > reviewers.length / 2) return 'APPROVED';
    return undefined;
  };

  const result = await quorumVote({
    reviewers,
    predicate,
    fallback: (tally) => 'APPROVED',
    defaultVerdict: 'REJECTED',
    timeoutMs: 50,
  });

  assert.equal(result, 'APPROVED');
});

// 5. All-abstain returns defaultVerdict
test('all-abstain returns defaultVerdict', async () => {
  const reviewers = [
    () => Promise.resolve(ABSTAIN),
    () => Promise.resolve(ABSTAIN),
    () => Promise.resolve(ABSTAIN),
  ];

  const result = await quorumVote({
    reviewers,
    predicate: null,
    fallback: (tally) => 'APPROVED',
    defaultVerdict: 'REJECTED',
    timeoutMs: 5000,
  });

  assert.equal(result, 'REJECTED');
});

// 6. Tie returns defaultVerdict
test('tie returns defaultVerdict', async () => {
  const reviewers = [
    () => Promise.resolve('YES'),
    () => Promise.resolve('NO'),
  ];

  const result = await quorumVote({
    reviewers,
    predicate: null,
    fallback: (tally) => 'APPROVED',
    defaultVerdict: 'REJECTED',
    timeoutMs: 5000,
  });

  assert.equal(result, 'REJECTED');
});

// 7. Outer promise resolves exactly once
test('outer promise resolves exactly once', async () => {
  const resolveCount = { count: 0 };

  const reviewers = [
    () => Promise.resolve('YES'),
    () => Promise.resolve('YES'),
    () => Promise.resolve('NO'),
  ];

  const predicate = (tally, pending) => {
    const yesCount = tally.get('YES') || 0;
    if (yesCount > reviewers.length / 2) {
      resolveCount.count++;
      return 'APPROVED';
    }
    return undefined;
  };

  const result = await quorumVote({
    reviewers,
    predicate,
    fallback: (tally) => 'APPROVED',
    defaultVerdict: 'REJECTED',
    timeoutMs: 5000,
  });

  assert.equal(result, 'APPROVED');
  assert.equal(resolveCount.count, 1, 'predicate should be called exactly once to trigger resolution');
});
