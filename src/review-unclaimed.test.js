'use strict';

// Run: node --test src/review-unclaimed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isClaimed, unclaimedReviews, hasUnclaimedReview, CLAIM_MAX_AGE_S } = require('./review-unclaimed.js');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-unclaimed-'));
  const review = path.join(root, 'queue', 'review');
  const instances = path.join(root, 'instances');
  fs.mkdirSync(review, { recursive: true });
  fs.mkdirSync(path.join(instances, 'review-claims'), { recursive: true });
  const item = (name, body = '{"id":"x"}', ageS = 0) => {
    const p = path.join(review, name); fs.writeFileSync(p, body);
    if (ageS) { const t = new Date(Date.now() - ageS * 1000); fs.utimesSync(p, t, t); }
    return p;
  };
  const claim = (name, owner, ageS = 0) => {
    const d = path.join(instances, 'review-claims', `${name}.d`); fs.mkdirSync(d);
    if (owner !== null) fs.writeFileSync(path.join(d, 'owner'), owner);
    if (ageS) { const t = new Date(Date.now() - ageS * 1000); fs.utimesSync(d, t, t); }
    return d;
  };
  return { root, review, instances, item, claim };
}

const ALIVE = (pid) => pid === 4242;

test('an item with no claim is unclaimed; a live claim hides it', () => {
  const s = sandbox();
  s.item('a.json'); s.item('b.json');
  s.claim('b.json', '4242 reviewer');
  assert.deepEqual(unclaimedReviews(s.root, s.instances, { alive: ALIVE }), ['a.json']);
  assert.equal(hasUnclaimedReview(s.root, s.instances, { alive: ALIVE }), true);
});

test('when every item is claimed by a live pid nothing is unclaimed', () => {
  const s = sandbox();
  s.item('a.json'); s.claim('a.json', '4242 reviewer');
  assert.equal(hasUnclaimedReview(s.root, s.instances, { alive: ALIVE }), false);
});

test('a claim whose pid is dead, whose owner file is missing or unreadable, or that is 3 hours old is not live', () => {
  const s = sandbox();
  s.item('dead.json'); s.claim('dead.json', '9999 reviewer');
  s.item('noowner.json'); s.claim('noowner.json', null);
  s.item('junk.json'); s.claim('junk.json', 'not a pid');
  s.item('old.json'); s.claim('old.json', '4242 reviewer', CLAIM_MAX_AGE_S + 5);
  assert.deepEqual(unclaimedReviews(s.root, s.instances, { alive: ALIVE }).sort(), ['dead.json', 'junk.json', 'noowner.json', 'old.json']);
  assert.equal(isClaimed(path.join(s.instances, 'review-claims'), 'old.json', Date.now(), ALIVE), false);
  assert.equal(isClaimed(path.join(s.instances, 'review-claims'), 'dead.json', Date.now(), ALIVE), false);
});

test('only non-empty .json files count; the oldest comes first', () => {
  const s = sandbox();
  s.item('new.json', '{}', 0); s.item('old.json', '{}', 600); s.item('empty.json', ''); s.item('notes.txt', 'x'); fs.mkdirSync(path.join(s.review, 'dir.json'));
  assert.deepEqual(unclaimedReviews(s.root, s.instances, { alive: ALIVE }), ['old.json', 'new.json']);
});

test('a missing review/ directory or empty queue means nothing to review (fail closed)', () => {
  const s = sandbox();
  assert.equal(hasUnclaimedReview(s.root, s.instances), false);
  assert.equal(hasUnclaimedReview(path.join(s.root, 'nowhere'), s.instances), false);
});

test('a claim made by this very process counts as live with the real pid check, and a bogus pid does not', () => {
  const s = sandbox();
  s.item('mine.json'); s.claim('mine.json', `${process.pid} reviewer`);
  s.item('ghost.json'); s.claim('ghost.json', '2147483646 reviewer');
  assert.deepEqual(unclaimedReviews(s.root, s.instances), ['ghost.json']);
});

test('checking never creates, changes or removes a claim', () => {
  const s = sandbox();
  s.item('a.json'); const d = s.claim('a.json', '9999 reviewer');
  const before = fs.readdirSync(path.join(s.instances, 'review-claims')).sort();
  hasUnclaimedReview(s.root, s.instances, { alive: ALIVE });
  assert.deepEqual(fs.readdirSync(path.join(s.instances, 'review-claims')).sort(), before);
  assert.equal(fs.readFileSync(path.join(d, 'owner'), 'utf8'), '9999 reviewer');
});

test('CLI: exit 0 with an unclaimed review, 1 without, nothing printed, env defaults honoured', () => {
  const s = sandbox();
  const run = (args, env = {}) => spawnSync('node', [path.join(__dirname, 'review-unclaimed.js'), ...args], { encoding: 'utf8', env: { ...process.env, AGENT_MANAGER_PIPELINE_DIR: '', AGENT_MANAGER_INSTANCES_DIR: '', ...env } });
  assert.equal(run([s.root, s.instances]).status, 1, 'empty review/');
  s.item('a.json');
  const r = run([s.root, s.instances]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(run([], { AGENT_MANAGER_PIPELINE_DIR: s.root, AGENT_MANAGER_INSTANCES_DIR: s.instances }).status, 0, 'env defaults');
  s.claim('a.json', `${process.pid} reviewer`);
  assert.equal(run([s.root, s.instances]).status, 1, 'live claim by a pid that is alive');
  assert.equal(run([]).status, 1, 'no directory at all');
});

test('pid 0 and negative pids are never a live claim (kill 0 would signal the whole process group); pid 1 (init, another user) counts as alive', () => {
  const s = sandbox();
  s.item('zero.json'); s.claim('zero.json', '0 reviewer');
  s.item('neg.json'); s.claim('neg.json', '-1 reviewer');
  s.item('init.json'); s.claim('init.json', '1 reviewer');
  assert.deepEqual(unclaimedReviews(s.root, s.instances).sort(), ['neg.json', 'zero.json']);
});
