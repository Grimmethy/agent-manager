'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { registerTaskSource, clearRegistry, variantParentOf, getVariantsOf, getRegisteredSource } = require('./task-source-registry.js');
const { annotateVariants } = require('./capability-ledger.js');

test('variantOf: stored on the registration, resolved to the root parent (chains, cycles), listed from the parent', () => {
  clearRegistry();
  registerTaskSource('change_review', { priority: 1 });
  registerTaskSource('change_review_hunk', { priority: 2, variantOf: 'change_review' });
  registerTaskSource('change_review_hunk_tiny', { priority: 3, variantOf: 'change_review_hunk' });
  registerTaskSource('plain', { priority: 4 });
  assert.equal(getRegisteredSource('change_review_hunk').variantOf, 'change_review');
  assert.equal(variantParentOf('change_review_hunk'), 'change_review');
  assert.equal(variantParentOf('change_review_hunk_tiny'), 'change_review', 'a variant of a variant resolves to the root');
  assert.equal(variantParentOf('change_review'), null);
  assert.equal(variantParentOf('plain'), null);
  assert.equal(variantParentOf('never_registered'), null);
  assert.deepEqual(getVariantsOf('change_review').sort(), ['change_review_hunk', 'change_review_hunk_tiny']);
  assert.deepEqual(getVariantsOf('plain'), []);
  // a cycle cannot hang the lookup
  registerTaskSource('a', { variantOf: 'b' });
  registerTaskSource('b', { variantOf: 'a' });
  assert.ok(['a', 'b', null].includes(variantParentOf('a')));
  clearRegistry();
});

test('variantOf must name a different source', () => {
  clearRegistry();
  assert.throws(() => registerTaskSource('x', { variantOf: 'x' }), /variantOf must name a different source/);
  assert.throws(() => registerTaskSource('y', { variantOf: '  ' }), /variantOf/);
  assert.throws(() => registerTaskSource('z', { variantOf: 7 }), /variantOf/);
  registerTaskSource('ok', { variantOf: null });
  clearRegistry();
});

test('annotateVariants tags scorecard rows with their parent and leaves the rows otherwise intact', () => {
  const rows = [{ source: 'change_review_hunk', model: 'm', n: 3 }, { source: 'change_review', model: 'm', n: 9 }];
  const out = annotateVariants(rows, (s) => (s === 'change_review_hunk' ? 'change_review' : null));
  assert.deepEqual(out.map((r) => r.variantOf), ['change_review', null]);
  assert.equal(out[0].n, 3);
  assert.deepEqual(annotateVariants(rows, undefined).map((r) => r.variantOf), [null, null]);
});

test('node src/lanes.js --json prints the documented lane surface without launch plumbing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-json-'));
  const reg = path.join(dir, 'lanes.json');
  fs.writeFileSync(reg, JSON.stringify([{ gpu: 'rx580', ollamaUrl: 'http://g:11434', model: 'qwen3-vl:8b-instruct', numCtx: 16384, numBatch: 1024, taskClasses: ['brain_dump_sort'] }]));
  const out = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'lanes.js'), '--json'], { env: { ...process.env, AGENT_MANAGER_LANES_PATH: reg, AGENT_MANAGER_LOCAL_GPU: '3090' }, encoding: 'utf8' }));
  const small = out.find((l) => l.id === 'worker-rx580');
  assert.deepEqual(small, { id: 'worker-rx580', gpu: 'rx580', model: 'qwen3-vl:8b-instruct', tier: 8, numCtx: 16384, numBatch: 1024, slow: false, local: false, preempt: 'never', taskClasses: ['brain_dump_sort'], reserve: 'auto', endpoint: 'http://g:11434' });
  assert.equal(out[0].id, 'worker-3090');
  assert.ok(!('env' in small));
});
