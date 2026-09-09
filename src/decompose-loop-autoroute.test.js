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

// Tier-1 one-pass short-circuits a fully-mechanical HTML plan into a single task (no hub).
// These hub-materialisation / parentHub tests deliberately exercise the HUB path.
async function sweepHubPath(args) {
  const prev = process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS;
  process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS = 'false';
  try { return await sweep(args); }
  finally { if (prev === undefined) delete process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS; else process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS = prev; }
}

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

  const summary = await sweepHubPath({ pipelineDir: dir, repoRoot: dir, call });
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

// 2026-09-08, Grimmethy: "any time a hub process that is set to premium priority
// generates a new child, that child should be set to premium priority as well. I've had
// to manually set premium on the last 2 children of decompose."
test('sweep: premiumPriority on the stuck task carries onto the request AND the rerouted parent', async () => {
  const dir = tmpPipeline();
  w(dir, 'needs-clarification', { ...STUCK(), premiumPriority: true });

  const call = async () => ({
    response: JSON.stringify([
      { newFile: 'python/dashboard/templates/static/js/job-list.js', kind: 'script-extract', symbols: ['renderJobListTab', 'renderJobRow'] },
      { newFile: 'python/dashboard/templates/static/js/job-groups.js', kind: 'script-extract', symbols: ['renderGroupRow', 'toggleGroup'] },
    ]),
  });
  fs.mkdirSync(path.join(dir, 'python/dashboard/templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'python/dashboard/templates/index.html'),
    '<script>\nfunction renderJobListTab(){}\nfunction renderJobRow(){}\nfunction renderGroupRow(){}\nfunction toggleGroup(){}\nfunction extra1(){}\nfunction extra2(){}\n</script>\n');

  await sweep({ pipelineDir: dir, repoRoot: dir, call });

  const reqs = fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests'));
  const req = r(path.join(dir, 'queue', 'file-decompose-requests', reqs[0]));
  assert.equal(req.premiumPriority, true, 'the auto-authored request should carry premiumPriority forward');

  const moved = r(path.join(dir, 'queue', 'pending', `${STUCK().id}.json`));
  assert.equal(moved.premiumPriority, true, 'the rerouted parent task should keep its own premiumPriority too');
});

test('sweep: no premiumPriority on the stuck task -- neither the request nor the rerouted parent gets the field', async () => {
  const dir = tmpPipeline();
  w(dir, 'needs-clarification', STUCK());

  const call = async () => ({
    response: JSON.stringify([
      { newFile: 'python/dashboard/templates/static/js/job-list.js', kind: 'script-extract', symbols: ['renderJobListTab', 'renderJobRow'] },
      { newFile: 'python/dashboard/templates/static/js/job-groups.js', kind: 'script-extract', symbols: ['renderGroupRow', 'toggleGroup'] },
    ]),
  });
  fs.mkdirSync(path.join(dir, 'python/dashboard/templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'python/dashboard/templates/index.html'),
    '<script>\nfunction renderJobListTab(){}\nfunction renderJobRow(){}\nfunction renderGroupRow(){}\nfunction toggleGroup(){}\nfunction extra1(){}\nfunction extra2(){}\n</script>\n');

  await sweep({ pipelineDir: dir, repoRoot: dir, call });

  const reqs = fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests'));
  const req = r(path.join(dir, 'queue', 'file-decompose-requests', reqs[0]));
  assert.equal(Object.prototype.hasOwnProperty.call(req, 'premiumPriority'), false);

  const moved = r(path.join(dir, 'queue', 'pending', `${STUCK().id}.json`));
  assert.equal(Object.prototype.hasOwnProperty.call(moved, 'premiumPriority'), false);
});

// parentHub (2026-09-08): the Hub Tasks tab's real family-tree link, propagated the same
// way premiumPriority already is above.
test('sweep: promptContext.decomposedFrom on the stuck task carries onto the new hub as parentHub', async () => {
  const dir = tmpPipeline();
  const stuck = { ...STUCK(), promptContext: { ...STUCK().promptContext, decomposedFrom: 'hub-original' } };
  w(dir, 'needs-clarification', stuck);

  const call = async () => ({
    response: JSON.stringify([
      { newFile: 'python/dashboard/templates/static/js/job-list.js', kind: 'script-extract', symbols: ['renderJobListTab', 'renderJobRow'] },
      { newFile: 'python/dashboard/templates/static/js/job-groups.js', kind: 'script-extract', symbols: ['renderGroupRow', 'toggleGroup'] },
    ]),
  });
  fs.mkdirSync(path.join(dir, 'python/dashboard/templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'python/dashboard/templates/index.html'),
    '<script>\nfunction renderJobListTab(){}\nfunction renderJobRow(){}\nfunction renderGroupRow(){}\nfunction toggleGroup(){}\nfunction extra1(){}\nfunction extra2(){}\n</script>\n');

  await sweepHubPath({ pipelineDir: dir, repoRoot: dir, call });

  const reqs = fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests'));
  const req = r(path.join(dir, 'queue', 'file-decompose-requests', reqs[0]));
  assert.equal(req.parentHub, 'hub-original', 'the auto-authored request should carry parentHub forward');

  const hubFile = path.join(dir, 'queue', 'coordinating', `file-decompose-hub-${req.id}.json`);
  const hub = r(hubFile);
  assert.equal(hub.parentHub, 'hub-original', 'the newly materialised hub should carry parentHub');
});

// Fallback path: no decomposedFrom on the stuck task, but rewireCoordinatorParent() still
// finds a real coordinating parent by scanning subTasks[] -- the new hub should still get
// stamped, so the family tree is correct either way.
test('sweep: with no decomposedFrom, a real coordinating parent found by scan still stamps parentHub (fallback)', async () => {
  const dir = tmpPipeline();
  const stuck = STUCK();
  w(dir, 'needs-clarification', stuck);
  w(dir, 'coordinating', {
    id: 'hub-original',
    subTasks: [{ id: stuck.id, title: stuck.title, status: 'needs-clarification' }],
    history: [],
  });

  const call = async () => ({
    response: JSON.stringify([
      { newFile: 'python/dashboard/templates/static/js/job-list.js', kind: 'script-extract', symbols: ['renderJobListTab', 'renderJobRow'] },
      { newFile: 'python/dashboard/templates/static/js/job-groups.js', kind: 'script-extract', symbols: ['renderGroupRow', 'toggleGroup'] },
    ]),
  });
  fs.mkdirSync(path.join(dir, 'python/dashboard/templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'python/dashboard/templates/index.html'),
    '<script>\nfunction renderJobListTab(){}\nfunction renderJobRow(){}\nfunction renderGroupRow(){}\nfunction toggleGroup(){}\nfunction extra1(){}\nfunction extra2(){}\n</script>\n');

  const summary = await sweepHubPath({ pipelineDir: dir, repoRoot: dir, call });
  assert.equal(summary.rewiredParents, 1);

  const reqs = fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests'));
  const req = r(path.join(dir, 'queue', 'file-decompose-requests', reqs[0]));
  const hubFile = path.join(dir, 'queue', 'coordinating', `file-decompose-hub-${req.id}.json`);
  const hub = r(hubFile);
  assert.equal(hub.parentHub, 'hub-original', 'fallback should stamp parentHub from the scanned coordinating parent');
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

// --- hot-file exclusion ([[hub-task-integration]], 2026-09-09) -------------------------

const { execFileSync } = require('child_process');

function gitInitWithFile(dir, relPath, content) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.mkdirSync(path.dirname(path.join(dir, relPath)), { recursive: true });
  fs.writeFileSync(path.join(dir, relPath), content);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

test('sweep: a decompose-loop task on an oversized file that was committed to recently is NOT auto-decomposed', async () => {
  const dir = tmpPipeline();
  w(dir, 'needs-clarification', STUCK());
  // real git repo, index.html committed just now -> "hot"
  gitInitWithFile(dir, 'python/dashboard/templates/index.html', '<script>\n' + ['a','b','c','d','e','f','g','h'].map((n) => `function ${n}(){ return 1; }`).join('\n') + '\n</script>\n');
  const call = async () => { throw new Error('plan pass should not run for a hot file'); };

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call });

  assert.equal(summary.routed, 0);
  assert.equal(summary.planFailed, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests')).length, 0, 'no request authored');
  const t = r(path.join(dir, 'queue', 'needs-clarification', `${STUCK().id}.json`));
  assert.ok(t, 'stuck task left in place for a human');
  assert.equal(t.autorouteAttempts.count, 1, 'attempt bumped so it is not re-checked every tick');
  assert.match(t.autorouteAttempts.lastNote, /last 7 days/);
  assert.ok(t.history.some((h) => /actively developed/.test(h.detail || '')));
});

test('sweep: AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS=0 disables the hot-file gate (plan pass runs)', async () => {
  const dir = tmpPipeline();
  w(dir, 'needs-clarification', STUCK());
  gitInitWithFile(dir, 'python/dashboard/templates/index.html', '<script>\n' + ['a','b','c','d','e','f','g','h'].map((n) => `function ${n}(){ return 1; }`).join('\n') + '\n</script>\n');
  let planPassRan = false;
  const call = async () => { planPassRan = true; return { response: '[]' }; }; // proceeds past the hot-file skip

  process.env.AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS = '0';
  try {
    delete require.cache[require.resolve('./decompose-loop-autoroute.js')];
    const { sweep: freshSweep } = require('./decompose-loop-autoroute.js');
    await freshSweep({ pipelineDir: dir, repoRoot: dir, call });
    assert.equal(planPassRan, true, 'gate disabled -> sweep got past the hot-file skip and ran the plan pass');
  } finally {
    delete process.env.AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS;
    delete require.cache[require.resolve('./decompose-loop-autoroute.js')];
  }
});

test('sweep: a hot file whose hub is ALREADY filed is not abandoned', async () => {
  const dir = tmpPipeline();
  w(dir, 'needs-clarification', STUCK());
  gitInitWithFile(dir, 'python/dashboard/templates/index.html', '<script>\nfunction renderJobListTab(){}\n</script>\n');
  // pre-existing request (routed on an earlier, non-hot tick)
  const requestId = `autodecomp-add-job-stage-groups-table-1788382532092-0`.slice(0, 60);
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', `${requestId}.json`),
    JSON.stringify({ id: requestId, sourceFile: 'python/dashboard/templates/index.html', moves: [] }));

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: async () => ({ response: '[]' }) });
  // not skipped-as-hot; it takes the normal already-filed path (re-points the task)
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'file-decompose-requests', `${requestId}.json`)), true, 'existing request untouched');
});

// --- Tier 1: autoroute of a fully-mechanical HTML plan -> single one-pass task, no hub ---

test('sweep: a fully-mechanical HTML decompose-loop task is routed to a one-pass task, not a hub', async () => {
  const dir = tmpPipeline();
  w(dir, 'needs-clarification', STUCK());
  fs.mkdirSync(path.join(dir, 'python/dashboard/templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'python/dashboard/templates/index.html'),
    '<html><body>\n<script>\n' + ['renderJobListTab','renderJobRow','renderGroupRow','toggleGroup','extra1','extra2']
      .map((n) => `function ${n}(){ return 1; }`).join('\n') + '\n</script>\n</body></html>\n');
  const call = async () => ({ response: JSON.stringify([
    { newFile: 'python/dashboard/static/js/job-list.js', kind: 'script-extract', symbols: ['renderJobListTab', 'renderJobRow'] },
    { newFile: 'python/dashboard/static/js/job-groups.js', kind: 'script-extract', symbols: ['renderGroupRow', 'toggleGroup'] },
  ]) });

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call });
  assert.equal(summary.routed, 1);

  // no hub
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'coordinating')).length, 0);
  // one -onepass adhoc task
  const onePass = fs.readdirSync(path.join(dir, 'queue', 'adhoc')).filter((n) => n.includes('-onepass'));
  assert.equal(onePass.length, 1);
  const opTask = r(path.join(dir, 'queue', 'adhoc', onePass[0]));
  assert.equal(opTask.promptContext.deterministicApply, 'one-pass-decompose');

  // stuck task depends on the one-pass task id, not a non-existent hub
  const moved = r(path.join(dir, 'queue', 'pending', `${STUCK().id}.json`));
  assert.deepEqual(moved.dependsOn, [opTask.id]);
  assert.equal(moved.reroutedTo.kind, 'file-decompose-onepass');
  assert.equal(moved.reroutedTo.onePassTaskId, opTask.id);
  assert.equal(moved.reroutedTo.hubId, undefined);
});
