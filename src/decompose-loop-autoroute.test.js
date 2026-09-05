'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweep, targetOversizedFile, rewireCoordinatorParent } = require('./decompose-loop-autoroute.js');

function tmpPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoroute-'));
  for (const s of ['blocked', 'needs-clarification', 'pending', 'adhoc', 'coordinating', 'file-decompose-requests']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'queue', 'file-length-flags.json'), JSON.stringify({
    findings: [
      { file: 'python/dashboard/templates/index.html', lines: 5807 },
      { file: 'python/dashboard/app.py', lines: 6951 },
    ],
  }));
  return dir;
}
const w = (dir, state, t) => fs.writeFileSync(path.join(dir, 'queue', state, `${t.id}.json`), JSON.stringify(t, null, 2));
const r = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('targetOversizedFile: matches the flagged path named in the task text', () => {
  const oversized = new Set(['python/dashboard/templates/index.html', 'src/x.js']);
  const t = { title: 'Combine job types', promptContext: { rawText: 'edit python/dashboard/templates/index.html renderJobListTab()' } };
  assert.equal(targetOversizedFile(t, oversized), 'python/dashboard/templates/index.html');
  assert.equal(targetOversizedFile({ title: 'x', promptContext: { rawText: 'edit src/y.js' } }, oversized), null);
});

test('targetOversizedFile: an oversized file named ONLY in a verification/compile command is not the target', () => {
  const oversized = new Set(['python/dashboard/app.py']);
  const t = {
    title: 'Add test_plugins_update.py with no-change and version-bumped cases',
    promptContext: {
      rawText: 'Create python/dashboard/test_plugins_update.py mirroring test_plugins_marketplace.py. '
        + 'Run: python3 -m py_compile python/dashboard/app.py python/dashboard/test_plugins_update.py and '
        + 'python3 -m unittest python.dashboard.test_plugins_update.',
    },
  };
  assert.equal(targetOversizedFile(t, oversized), null);
});

test('targetOversizedFile: a verification-command mention does not shadow a REAL mention elsewhere', () => {
  const oversized = new Set(['python/dashboard/app.py']);
  const t = {
    title: 'Split app.py',
    promptContext: {
      rawText: 'Split python/dashboard/app.py into smaller modules; it is too large to edit safely. '
        + 'Run: python3 -m py_compile python/dashboard/app.py to verify it still compiles.',
    },
  };
  assert.equal(targetOversizedFile(t, oversized), 'python/dashboard/app.py');
});

const STUCK = (over = true) => ({
  id: 'adhoc-add-job-stage-groups-table-1788382532092-0',
  domain: 'adhoc', source: 'manual', title: 'Add JOB_STAGE_GROUPS table + collapsed rows',
  stalenessFlag: { reason: 'decompose-loop', confidence: 'medium' },
  promptContext: { rawText: `Add a table and render collapsed rows in ${over ? 'python/dashboard/templates/index.html' : 'src/small.js'} -- renderJobListTab().` },
  history: [],
});

test('sweep: a decompose-loop task on an oversized file gets a file-decompose request + is re-pointed at the hub', async () => {
  const dir = tmpPipeline();
  w(dir, 'needs-clarification', STUCK());

  const call = async () => ({
    response: JSON.stringify([
      { newFile: 'python/dashboard/templates/static/js/job-list.js', kind: 'script-extract', symbols: ['renderJobListTab', 'renderJobRow'] },
      { newFile: 'python/dashboard/templates/static/js/job-groups.js', kind: 'script-extract', symbols: ['renderGroupRow', 'toggleGroup'] },
    ]),
  });
  // give the plan pass real symbols to extract
  fs.mkdirSync(path.join(dir, 'python/dashboard/templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'python/dashboard/templates/index.html'),
    '<script>\nfunction renderJobListTab(){}\nfunction renderJobRow(){}\nfunction renderGroupRow(){}\nfunction toggleGroup(){}\nfunction extra1(){}\nfunction extra2(){}\n</script>\n');

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call });
  assert.equal(summary.routed, 1);

  const reqs = fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests'));
  assert.equal(reqs.length, 1);
  const req = r(path.join(dir, 'queue', 'file-decompose-requests', reqs[0]));
  assert.equal(req.sourceFile, 'python/dashboard/templates/index.html');
  assert.equal(req.moves.length, 2);
  assert.equal(req.autoAuthored, true);

  // The hub is materialised IN THIS TICK -- no dangling reference for coordinator-sweep to
  // misclassify as `gone` on the next tick.
  const hubFile = path.join(dir, 'queue', 'coordinating', `file-decompose-hub-${req.id}.json`);
  assert.equal(fs.existsSync(hubFile), true, 'decompose hub exists immediately after routing');
  const hub = r(hubFile);
  assert.equal(hub.mode, 'stacked');
  assert.equal(hub.subTasks.length, 3); // 2 moves + wiring

  // stuck task moved to pending/, now depends on the decompose hub
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'needs-clarification', `${STUCK().id}.json`)), false);
  const moved = r(path.join(dir, 'queue', 'pending', `${STUCK().id}.json`));
  assert.deepEqual(moved.dependsOn, [`file-decompose-hub-${req.id}`]);
  assert.equal(moved.reroutedTo.kind, 'file-decompose');
  assert.equal(moved.status, 'pending');
});

test('sweep: a decompose-loop task NOT about an oversized file is left alone (human keeps the flag)', async () => {
  const dir = tmpPipeline();
  w(dir, 'needs-clarification', STUCK(false));
  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: async () => ({ response: '[]' }) });
  assert.equal(summary.routed, 0);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'needs-clarification', `${STUCK(false).id}.json`)), true);
});

test('sweep: plan pass failure bumps a bounded attempt counter, does not move the task', async () => {
  const dir = tmpPipeline();
  w(dir, 'needs-clarification', STUCK());
  fs.mkdirSync(path.join(dir, 'python/dashboard/templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'python/dashboard/templates/index.html'),
    '<script>\n' + Array.from({ length: 8 }, (_, i) => `function f${i}(){}`).join('\n') + '\n</script>\n');
  const call = async () => ({ response: 'no json here' });
  const s1 = await sweep({ pipelineDir: dir, repoRoot: dir, call });
  assert.equal(s1.planFailed, 1);
  const t = r(path.join(dir, 'queue', 'needs-clarification', `${STUCK().id}.json`));
  assert.equal(t.autorouteAttempts.count, 1);
  // immediate re-run is rate-limited
  const s2 = await sweep({ pipelineDir: dir, repoRoot: dir, call });
  assert.equal(s2.skipped, 1);
  assert.equal(s2.planFailed, 0);
});

test('rewireCoordinatorParent: swaps the child for the hub and rewrites sibling dependsOn', () => {
  const dir = tmpPipeline();
  w(dir, 'coordinating', {
    id: 'hub-1', subTasks: [
      { id: 'child-0', title: 'the big one', status: 'needs-clarification' },
      { id: 'child-1', title: 'wire it', status: 'in-progress' },
    ], history: [],
  });
  w(dir, 'needs-clarification', { id: 'child-1', dependsOn: ['child-0'], history: [] });

  const parentId = rewireCoordinatorParent(dir, 'child-0', 'file-decompose-hub-x');
  assert.equal(parentId, 'hub-1');
  const hub = r(path.join(dir, 'queue', 'coordinating', 'hub-1.json'));
  assert.equal(hub.subTasks[0].id, 'file-decompose-hub-x');
  assert.match(hub.subTasks[0].title, /re-decomposed/);
  const sib = r(path.join(dir, 'queue', 'needs-clarification', 'child-1.json'));
  assert.deepEqual(sib.dependsOn, ['file-decompose-hub-x']);
});
