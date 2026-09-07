'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { backfillDeterministicApply, isEligible } = require('./decompose-move-determinism-backfill.js');

function mkPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-backfill-test-'));
  for (const d of ['pending', 'needs-clarification', 'blocked', 'file-decompose-requests']) {
    fs.mkdirSync(path.join(dir, 'queue', d), { recursive: true });
  }
  return dir;
}

function mkRepo(pipelineDir, sourceRel, html) {
  const abs = path.join(pipelineDir, sourceRel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, html);
  return pipelineDir; // repoRoot === pipelineDir for these tests -- keeps fixtures self-contained
}

const SAMPLE_HTML = `<html><body><script>
function alpha() {
  return 1;
}

function beta() {
  return 2;
}
</script></body></html>
`;

function writeRequest(pipelineDir, id, sourceFile, moves) {
  fs.writeFileSync(
    path.join(pipelineDir, 'queue', 'file-decompose-requests', `${id}.json`),
    JSON.stringify({ id, sourceFile, moves }, null, 2),
  );
}

function writeTask(pipelineDir, state, task) {
  fs.writeFileSync(path.join(pipelineDir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
}

function readTask(pipelineDir, state, id) {
  return JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', state, `${id}.json`), 'utf8'));
}

test('isEligible: requires decomposedFrom prefix, integer moveIndex, newFile, and no existing flag', () => {
  assert.equal(isEligible({ promptContext: { decomposedFrom: 'file-decompose-hub-x', moveIndex: 0, newFile: 'a.js' } }), true);
  assert.equal(isEligible({ promptContext: { decomposedFrom: 'file-decompose-hub-x', moveIndex: 0, newFile: 'a.js', deterministicApply: 'script-extract' } }), false, 'already stamped -- idempotent skip');
  assert.equal(isEligible({ promptContext: { decomposedFrom: 'file-decompose-hub-x', newFile: 'a.js' } }), false, 'wiring task shape has no moveIndex');
  assert.equal(isEligible({ promptContext: { rawText: 'unrelated adhoc task' } }), false);
  assert.equal(isEligible({}), false);
});

test('stamps a task whose move symbols all resolve cleanly against the real source', () => {
  const pipelineDir = mkPipeline();
  mkRepo(pipelineDir, 'app/index.html', SAMPLE_HTML);
  writeRequest(pipelineDir, 'plan-1', 'app/index.html', [
    { newFile: 'app/static/mod.js', kind: 'script-extract', symbols: ['alpha', 'beta'] },
  ]);
  writeTask(pipelineDir, 'needs-clarification', {
    id: 'adhoc-decompose-plan-1-01-mod-js',
    title: 'move alpha/beta',
    promptContext: { rawText: 'move stuff', decomposedFrom: 'file-decompose-hub-plan-1', moveIndex: 0, newFile: 'app/static/mod.js' },
    history: [],
  });

  const summary = backfillDeterministicApply({ pipelineDir, repoRoot: pipelineDir });
  assert.equal(summary.checked, 1);
  assert.equal(summary.stamped, 1);
  assert.equal(summary.errors, 0);

  const stamped = readTask(pipelineDir, 'needs-clarification', 'adhoc-decompose-plan-1-01-mod-js');
  assert.equal(stamped.promptContext.deterministicApply, 'script-extract');
  assert.equal(stamped.promptContext.sourceFile, 'app/index.html');
  assert.deepEqual(stamped.promptContext.symbols, ['alpha', 'beta']);
  assert.equal(stamped.history.at(-1).stage, 'advisory');
  assert.match(stamped.history.at(-1).detail, /stamped deterministicApply/);
});

test('leaves a task alone (does not stamp) when its move symbols do not all resolve', () => {
  const pipelineDir = mkPipeline();
  mkRepo(pipelineDir, 'app/index.html', SAMPLE_HTML); // only defines alpha/beta
  writeRequest(pipelineDir, 'plan-2', 'app/index.html', [
    { newFile: 'app/static/mod.js', kind: 'script-extract', symbols: ['alpha', 'nonexistentFn'] },
  ]);
  writeTask(pipelineDir, 'pending', {
    id: 'adhoc-decompose-plan-2-01-mod-js',
    title: 'move alpha/nonexistentFn',
    promptContext: { rawText: 'move stuff', decomposedFrom: 'file-decompose-hub-plan-2', moveIndex: 0, newFile: 'app/static/mod.js' },
    history: [],
  });

  const summary = backfillDeterministicApply({ pipelineDir, repoRoot: pipelineDir });
  assert.equal(summary.checked, 1);
  assert.equal(summary.stamped, 0);
  assert.equal(summary.notEligibleYet, 1);

  const untouched = readTask(pipelineDir, 'pending', 'adhoc-decompose-plan-2-01-mod-js');
  assert.equal(untouched.promptContext.deterministicApply, undefined);
  assert.deepEqual(untouched.history, [], 'no history event written for a task that was not modified');
});

test('is idempotent: a second run over an already-stamped task changes nothing and is not even counted', () => {
  const pipelineDir = mkPipeline();
  mkRepo(pipelineDir, 'app/index.html', SAMPLE_HTML);
  writeRequest(pipelineDir, 'plan-3', 'app/index.html', [
    { newFile: 'app/static/mod.js', kind: 'script-extract', symbols: ['alpha', 'beta'] },
  ]);
  writeTask(pipelineDir, 'blocked', {
    id: 'adhoc-decompose-plan-3-01-mod-js',
    promptContext: { rawText: 'x', decomposedFrom: 'file-decompose-hub-plan-3', moveIndex: 0, newFile: 'app/static/mod.js' },
    history: [],
  });

  backfillDeterministicApply({ pipelineDir, repoRoot: pipelineDir });
  const firstPass = readTask(pipelineDir, 'blocked', 'adhoc-decompose-plan-3-01-mod-js');
  assert.equal(firstPass.history.length, 1);

  const summary2 = backfillDeterministicApply({ pipelineDir, repoRoot: pipelineDir });
  assert.equal(summary2.checked, 0, 'already-stamped task is skipped by isEligible before any check runs');
  const secondPass = readTask(pipelineDir, 'blocked', 'adhoc-decompose-plan-3-01-mod-js');
  assert.deepEqual(secondPass, firstPass, 'nothing changed on the idempotent re-run');
});

test('skips (does not throw) when the matching file-decompose-request cannot be found', () => {
  const pipelineDir = mkPipeline();
  mkRepo(pipelineDir, 'app/index.html', SAMPLE_HTML);
  writeTask(pipelineDir, 'pending', {
    id: 'adhoc-decompose-ghost-01-mod-js',
    promptContext: { rawText: 'x', decomposedFrom: 'file-decompose-hub-ghost-plan', moveIndex: 0, newFile: 'app/static/mod.js' },
    history: [],
  });

  const summary = backfillDeterministicApply({ pipelineDir, repoRoot: pipelineDir });
  assert.equal(summary.checked, 1);
  assert.equal(summary.stamped, 0);
  assert.equal(summary.errors, 0);
  assert.match(summary.skipped[0], /no matching file-decompose-request found/);
});

test('does not touch a flask-blueprint (non-script-extract) move -- only .html/script-extract moves are deterministic-eligible', () => {
  const pipelineDir = mkPipeline();
  mkRepo(pipelineDir, 'app.py', 'def alpha():\n    return 1\n');
  writeRequest(pipelineDir, 'plan-4', 'app.py', [
    { newFile: 'routes/mod.py', kind: 'flask-blueprint', symbols: ['alpha'] },
  ]);
  writeTask(pipelineDir, 'pending', {
    id: 'adhoc-decompose-plan-4-01-mod-py',
    promptContext: { rawText: 'x', decomposedFrom: 'file-decompose-hub-plan-4', moveIndex: 0, newFile: 'routes/mod.py' },
    history: [],
  });

  const summary = backfillDeterministicApply({ pipelineDir, repoRoot: pipelineDir });
  assert.equal(summary.stamped, 0);
  assert.match(summary.skipped[0], /not an eligible script-extract move/);
});
