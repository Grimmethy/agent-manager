const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preflightTarget } = require('./draft-preflight.js');

// Fake fsApi: `entries` maps path -> { type: 'file'|'dir', writable: bool }
// or { error: 'CODE' } to force a stat error.
function fakeFs(entries) {
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    constants: { W_OK: 2 },
    statSync(p) {
      const e = entries[p];
      if (!e) throw err('ENOENT');
      if (e.error) throw err(e.error);
      return { isFile: () => e.type === 'file', isDirectory: () => e.type === 'dir' };
    },
    accessSync(p) {
      const e = entries[p];
      if (!e || e.writable === false) throw err('EACCES');
    },
  };
}

test('existing writable regular file passes', () => {
  const fs = fakeFs({ '/r/a.js': { type: 'file', writable: true } });
  assert.deepEqual(preflightTarget({ target: '/r/a.js' }, fs), { ok: true });
});

test('existing directory as target fails', () => {
  const fs = fakeFs({ '/r/d': { type: 'dir', writable: true } });
  const res = preflightTarget({ target: '/r/d' }, fs);
  assert.equal(res.ok, false);
  assert.ok(res.reason.length > 0);
});

test('existing non-writable file fails', () => {
  const fs = fakeFs({ '/r/ro.js': { type: 'file', writable: false } });
  const res = preflightTarget({ target: '/r/ro.js' }, fs);
  assert.equal(res.ok, false);
  assert.ok(res.reason.length > 0);
});

test('missing target in writable directory passes', () => {
  const fs = fakeFs({ '/r': { type: 'dir', writable: true } });
  assert.deepEqual(preflightTarget({ target: '/r/new.js' }, fs), { ok: true });
});

test('missing target whose parent is missing fails', () => {
  const fs = fakeFs({});
  const res = preflightTarget({ target: '/nope/new.js' }, fs);
  assert.equal(res.ok, false);
  assert.match(res.reason, /parent directory missing/);
});

test('missing target whose parent is not writable fails', () => {
  const fs = fakeFs({ '/r': { type: 'dir', writable: false } });
  const res = preflightTarget({ target: '/r/new.js' }, fs);
  assert.equal(res.ok, false);
  assert.match(res.reason, /not writable/);
});

test('non-ENOENT stat error fails and includes the code', () => {
  const fs = fakeFs({ '/r/x.js': { error: 'EACCES' } });
  const res = preflightTarget({ target: '/r/x.js' }, fs);
  assert.equal(res.ok, false);
  assert.match(res.reason, /EACCES/);
});

test('missing or empty target field fails', () => {
  const fs = fakeFs({});
  assert.equal(preflightTarget({}, fs).ok, false);
  assert.equal(preflightTarget({ target: '' }, fs).ok, false);
  assert.equal(preflightTarget(null, fs).ok, false);
});
