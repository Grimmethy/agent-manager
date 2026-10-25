'use strict';

// Unit tests for the deterministic brain-dump target check (src/brain-dump-target-check.js). No model, no network; the repo is a stub `exists`.
// Run: node --test src/brain-dump-target-check.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkEntryTargets, citedPaths, defaultExists, isEnabled } = require('./brain-dump-target-check.js');

const none = () => false;
const all = () => true;

test('every cited path missing from the repo -> suspect', () => {
  const r = checkEntryTargets('`drive_links.py` and `src/gone.js:12` do not exist', { exists: none });
  assert.equal(r.verdict, 'suspect');
  assert.match(r.reasons[0], /every cited path is missing/);
  assert.deepEqual(r.cited, ['drive_links.py', 'src/gone.js']);
});

test('one of two cited paths missing -> ok (a file can be new)', () => {
  const r = checkEntryTargets('see `src/a.js` and `src/new-file.js`', { exists: (p) => p === 'src/a.js' });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.reasons, []);
});

test('a path under archive/ -> suspect even when it exists', () => {
  const r = checkEntryTargets('`TaxHarvest/archive/client-deliverables/backend/generate-deliverables.js` hardcodes a path', { exists: all });
  assert.equal(r.verdict, 'suspect');
  assert.match(r.reasons.join(' '), /retired code under archive\//);
});

test('a hub sequencing note (dependency-ordering hazard, absent on the shared branch) -> suspect', () => {
  for (const text of [
    'This is a dependency-ordering hazard, not a code defect.',
    'Prerequisite modules are absent on the shared branch',
  ]) {
    const r = checkEntryTargets(text, { exists: all });
    assert.equal(r.verdict, 'suspect', text);
    assert.match(r.reasons.join(' '), /sequencing note/);
  }
});

test('pending-merge next to a hub id is not a sequencing note: a real fix for a merged piece stays ok', () => {
  const r = checkEntryTargets('the HUB0007 piece is pending-merge; fix the usage fields before building on it', { exists: all });
  assert.equal(r.verdict, 'ok');
  assert.doesNotMatch(r.reasons.join(' '), /sequencing note/);
});

test('no cited paths and ordinary text -> ok; symbols and property names are not paths', () => {
  assert.equal(checkEntryTargets('mapParcel may use undefined use.type; see entry.status and `foo.bar()`', { exists: none }).verdict, 'ok');
  assert.deepEqual(citedPaths('`entry.status` `module.exports` `x.y`'), []);
  assert.deepEqual(citedPaths('`src/a.js:3-9` `src/a.js` `docs/x.md`'), ['src/a.js', 'docs/x.md']);
});

test('defaultExists fails open when the repo cannot be listed', () => {
  assert.equal(defaultExists('/nonexistent/repo/root/for/test')('src/whatever.js'), true);
});

test('kill switch', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(isEnabled({ AGENT_MANAGER_BRAIN_DUMP_TARGET_CHECK: 'false' }), false);
});
