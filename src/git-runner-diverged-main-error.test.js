const test = require('node:test');
const assert = require('node:assert');
const { DivergedMainError } = require('./git-runner');

test('DivergedMainError carries reason, localOnly and remoteOnly', () => {
  const e = new DivergedMainError({
    mainBranch: 'main',
    remote: 'origin/main',
    cause: 'boom',
    reason: 'rescue branch could not be created',
    localOnly: ['aaa'],
    remoteOnly: ['bbb'],
  });
  assert.ok(e instanceof Error);
  assert.strictEqual(e.name, 'DivergedMainError');
  assert.strictEqual(e.reason, 'rescue branch could not be created');
  assert.deepStrictEqual(e.localOnly, ['aaa']);
  assert.deepStrictEqual(e.remoteOnly, ['bbb']);
});

test('DivergedMainError message keeps the existing diverged wording', () => {
  const e = new DivergedMainError({ mainBranch: 'main', remote: 'origin/main', cause: 'boom' });
  assert.match(e.message, /resetToMain: local main and origin\/main have diverged/);
  assert.match(e.message, /needs a human to reconcile, not an automatic reset/);
  assert.match(e.message, /boom$/);
});

test('DivergedMainError defaults localOnly and remoteOnly to empty arrays', () => {
  const e = new DivergedMainError({ mainBranch: 'main', remote: 'origin/main', cause: 'x' });
  assert.deepStrictEqual(e.localOnly, []);
  assert.deepStrictEqual(e.remoteOnly, []);
});
