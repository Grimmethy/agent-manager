'use strict';

// HUB0122-02: pins the three verdicts of checkFilesHintPremise with real temp directories
// (no mocks of the module under test). Incident shape: a brain-dump entry named files that
// have nothing to do with its description, and the premise survived 9 drafting attempts.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { checkFilesHintPremise } = require('./files-hint-premise-check.js');

function makeRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-hint-premise-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const DESCRIPTION = 'the observabilityreview scanner silently swallows parse failures';
const ctxFor = (root) => ({ resolveAccessibleRoots: () => [root] });

test('wrong-file: keyword absent in the named file but present in another file under the roots', () => {
  const root = makeRoot({
    'src/named.js': "'use strict';\nmodule.exports = { unrelated: true };\n",
    'plugin/observability-review.js': "'use strict';\n// the observabilityreview scanner lives here\nmodule.exports = {};\n",
  });
  const r = checkFilesHintPremise({ description: DESCRIPTION, filesHint: ['src/named.js'] }, ctxFor(root));
  assert.equal(r.verdict, 'wrong-file');
  assert.ok(Array.isArray(r.suggestedFiles) && r.suggestedFiles.length === 1);
  assert.ok(r.suggestedFiles[0].endsWith(path.join('plugin', 'observability-review.js')));
});

test('ok: a distinctive keyword is present in the named file', () => {
  const root = makeRoot({ 'src/named.js': "// the observabilityreview scanner\nmodule.exports = {};\n" });
  const r = checkFilesHintPremise({ description: DESCRIPTION, filesHint: ['src/named.js'] }, ctxFor(root));
  assert.equal(r.verdict, 'ok');
  assert.equal(r.evidence.keyword, 'observabilityreview');
});

test('not-found: named file missing and the keyword is nowhere under the roots', () => {
  const root = makeRoot({ 'src/other.js': "module.exports = { nothing: 1 };\n" });
  const r = checkFilesHintPremise({ description: DESCRIPTION, filesHint: ['src/missing.js'] }, ctxFor(root));
  assert.equal(r.verdict, 'not-found');
});

test('never throws on a missing entry', () => {
  assert.equal(checkFilesHintPremise(null, ctxFor(makeRoot({}))).verdict, 'not-found');
});
