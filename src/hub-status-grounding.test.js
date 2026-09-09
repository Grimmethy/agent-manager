'use strict';

// Unit tests for hub-status-grounding.js -- see its own header for the real incident this
// closes (file-decompose-hub-autodecomp-adhoc-add-job-stage-groups-table-and-render-colla's
// wiring child wrongly concluded 2 real, already-committed sibling files "do not exist").

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { buildHubStatusGrounding } = require('./hub-status-grounding.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-status-grounding-test-'));
  const bareDir = path.join(dir, 'origin.git');
  const repoRoot = path.join(dir, 'repo');
  const pipelineDir = repoRoot;
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, repoRoot]);
  git(['config', 'user.email', 'test@example.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'test');
  git(['add', 'README.md'], repoRoot);
  git(['commit', '-q', '-m', 'initial'], repoRoot);
  git(['push', 'origin', 'main'], repoRoot);

  git(['checkout', '-b', 'agent/decompose-fixture'], repoRoot);
  fs.mkdirSync(path.join(repoRoot, 'static', 'js'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'static', 'js', 'core-ui.js'), 'function renderCore() {}\n');
  git(['add', 'static/js/core-ui.js'], repoRoot);
  git(['commit', '-q', '-m', 'sibling move 1 landed'], repoRoot);
  git(['push', 'origin', 'agent/decompose-fixture'], repoRoot);
  git(['checkout', 'main'], repoRoot);

  fs.mkdirSync(path.join(pipelineDir, 'queue', 'coordinating'), { recursive: true });
  return { repoRoot, pipelineDir };
}

function writeHub(pipelineDir, hubId, subTasks) {
  fs.writeFileSync(
    path.join(pipelineDir, 'queue', 'coordinating', `${hubId}.json`),
    JSON.stringify({ id: hubId, mode: 'stacked', subTasks }),
  );
}

test('buildHubStatusGrounding returns null when the task is not a decomposed hub child', () => {
  const { repoRoot, pipelineDir } = makeFixture();
  const task = { id: 't1', promptContext: {} };
  assert.equal(buildHubStatusGrounding(task, { repoRoot, pipelineDir }), null);
});

test('buildHubStatusGrounding returns null when the hub record cannot be read', () => {
  const { repoRoot, pipelineDir } = makeFixture();
  const task = { id: 't1', promptContext: { decomposedFrom: 'file-decompose-hub-does-not-exist' } };
  assert.equal(buildHubStatusGrounding(task, { repoRoot, pipelineDir }), null);
});

test('buildHubStatusGrounding reports a genuinely-existing sibling file as CONFIRMED, verified against the real stacked branch', () => {
  const { repoRoot, pipelineDir } = makeFixture();
  writeHub(pipelineDir, 'file-decompose-hub-fixture', [
    { id: 'move-1', title: 'Decompose index.html → static/js/core-ui.js', status: 'merged' },
    { id: 'wiring-1', title: 'wire up 1 new file(s)', status: 'needs-clarification' },
  ]);
  const task = {
    id: 'wiring-1',
    stacked: { branch: 'agent/decompose-fixture', seq: 2, total: 2 },
    promptContext: { decomposedFrom: 'file-decompose-hub-fixture' },
  };
  const grounding = buildHubStatusGrounding(task, { repoRoot, pipelineDir });
  assert.ok(grounding);
  assert.match(grounding, /CONFIRMED exists at static\/js\/core-ui\.js/);
  assert.match(grounding, /hub status: merged/);
  assert.doesNotMatch(grounding, /wire up 1 new file/, 'the task\'s own hub entry must be excluded from the rendered list');
});

test('buildHubStatusGrounding reports a sibling whose title-parsed path is wrong/missing as NOT FOUND, not a throw', () => {
  const { repoRoot, pipelineDir } = makeFixture();
  // Mirrors the real incident: the hub's own title text recorded the WRONG path for a
  // sibling (".../templates/static/js/core-ui.js" vs where it actually landed).
  writeHub(pipelineDir, 'file-decompose-hub-fixture', [
    { id: 'move-1', title: 'Decompose index.html → static/js/wrong-path.js', status: 'merged' },
    { id: 'wiring-1', title: 'wire up 1 new file(s)', status: 'needs-clarification' },
  ]);
  const task = {
    id: 'wiring-1',
    stacked: { branch: 'agent/decompose-fixture', seq: 2, total: 2 },
    promptContext: { decomposedFrom: 'file-decompose-hub-fixture' },
  };
  const grounding = buildHubStatusGrounding(task, { repoRoot, pipelineDir });
  assert.ok(grounding);
  assert.match(grounding, /NOT FOUND at static\/js\/wrong-path\.js/);
});

test('buildHubStatusGrounding tells the model to trust the VERIFIED line over its own exploration', () => {
  const { repoRoot, pipelineDir } = makeFixture();
  writeHub(pipelineDir, 'file-decompose-hub-fixture', [
    { id: 'move-1', title: 'Decompose index.html → static/js/core-ui.js', status: 'merged' },
    { id: 'wiring-1', title: 'wire up 1 new file(s)', status: 'needs-clarification' },
  ]);
  const task = {
    id: 'wiring-1',
    stacked: { branch: 'agent/decompose-fixture', seq: 2, total: 2 },
    promptContext: { decomposedFrom: 'file-decompose-hub-fixture' },
  };
  const grounding = buildHubStatusGrounding(task, { repoRoot, pipelineDir });
  assert.match(grounding, /TRUST THE VERIFIED LINE/);
});

test('buildHubStatusGrounding returns null when the hub has no subTasks', () => {
  const { repoRoot, pipelineDir } = makeFixture();
  writeHub(pipelineDir, 'file-decompose-hub-empty', []);
  const task = { id: 't1', promptContext: { decomposedFrom: 'file-decompose-hub-empty' } };
  assert.equal(buildHubStatusGrounding(task, { repoRoot, pipelineDir }), null);
});
