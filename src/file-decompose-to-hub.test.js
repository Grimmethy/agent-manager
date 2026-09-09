'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withEnv(repoRoot, extraEnv, fn) {
  const keys = ['AGENT_MANAGER_REPO_ROOT', 'AGENT_MANAGER_PIPELINE_DIR', 'AGENT_MANAGER_DECOMPOSE_STACKED', 'AGENT_MANAGER_FILE_DECOMPOSE_TO_HUB', 'AGENT_MANAGER_DECOMPOSE_DET_WIRING'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  for (const [k, v] of Object.entries(extraEnv || {})) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  delete require.cache[require.resolve('./config.js')];
  delete require.cache[require.resolve('./file-decompose-to-hub.js')];
  const mod = require('./file-decompose-to-hub.js');
  try { return fn(mod); }
  finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    delete require.cache[require.resolve('./config.js')];
    delete require.cache[require.resolve('./file-decompose-to-hub.js')];
  }
}

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-decompose-'));
  fs.mkdirSync(path.join(dir, 'queue', 'file-decompose-requests'), { recursive: true });
  return dir;
}

const PLAN = {
  id: 'decompose-app-py',
  sourceFile: 'python/dashboard/app.py',
  moves: [
    { newFile: 'python/dashboard/routes/plugins.py', kind: 'flask-blueprint', blueprint: 'plugins_bp',
      symbols: ['api_plugins_marketplace', 'api_plugins_install'] },
    { newFile: 'python/dashboard/routes/hardware.py', kind: 'flask-blueprint', blueprint: 'hardware_bp',
      symbols: ['api_hardware'] },
  ],
};

// --- legacy (unstacked) model ----------------------------------------------------------

test('legacy mode: hub + one child per move + a wiring task gated on every move', () => {
  const dir = tmpRepo();
  const reqPath = path.join(dir, 'queue', 'file-decompose-requests', 'p.json');
  fs.writeFileSync(reqPath, JSON.stringify(PLAN));

  withEnv(dir, { AGENT_MANAGER_DECOMPOSE_STACKED: 'false' }, ({ sweep }) => {
    assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1);
  });

  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc')).sort();
  assert.equal(adhoc.length, 3);
  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.equal(hub.mode, undefined);
  assert.equal(hub.subTasks.length, 3);

  const wiring = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', adhoc.find((n) => n.includes('wiring'))), 'utf8'));
  assert.equal(wiring.dependsOn.length, 2, 'legacy wiring waits on both moves');
  assert.equal(wiring.stacked, undefined);
  assert.match(wiring.promptContext.rawText, /register_blueprint\(plugins_bp\)/);

  const move1 = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', adhoc.find((n) => n.includes('-01-'))), 'utf8'));
  assert.equal(move1.dependsOn, undefined);
  assert.equal(move1.atomic, undefined);
  assert.match(move1.promptContext.rawText, /VERBATIM: `api_plugins_marketplace`, `api_plugins_install`/);
  assert.match(move1.promptContext.rawText, /@plugins_bp\.route/);

  // 2026-09-06: decomposedFrom used to be a synthetic `file-decompose:<requestId>` marker
  // -- never a real, navigable task id (the hub's own real id is
  // `file-decompose-hub-<slug>`) -- so a dashboard "jump to the owning hub" link built
  // from a sub-task's decomposedFrom 404'd. Every promptContext.decomposedFrom across the
  // hub and all its children must now equal the hub's own real id.
  assert.equal(move1.promptContext.decomposedFrom, hub.id);
  assert.equal(wiring.promptContext.decomposedFrom, hub.id);
});

// 2026-09-08, Grimmethy: "any time a hub process that is set to premium priority
// generates a new child, that child should be set to premium priority as well. I've had
// to manually set premium on the last 2 children of decompose."
test('premiumPriority on the request propagates to every move child, the wiring child, and the hub itself', () => {
  const dir = tmpRepo();
  const reqPath = path.join(dir, 'queue', 'file-decompose-requests', 'p.json');
  fs.writeFileSync(reqPath, JSON.stringify({ ...PLAN, premiumPriority: true }));

  withEnv(dir, { AGENT_MANAGER_DECOMPOSE_STACKED: 'false' }, ({ sweep }) => {
    assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1);
  });

  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc')).sort();
  for (const name of adhoc) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', name), 'utf8'));
    assert.equal(rec.premiumPriority, true, `${name} should have inherited premiumPriority`);
  }
  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.equal(hub.premiumPriority, true, 'the hub itself should also carry premiumPriority');
});

test('no premiumPriority on the request -- no child or hub gets the field at all (not even false)', () => {
  const dir = tmpRepo();
  const reqPath = path.join(dir, 'queue', 'file-decompose-requests', 'p.json');
  fs.writeFileSync(reqPath, JSON.stringify(PLAN));

  withEnv(dir, { AGENT_MANAGER_DECOMPOSE_STACKED: 'false' }, ({ sweep }) => {
    assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1);
  });

  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc')).sort();
  for (const name of adhoc) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', name), 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(rec, 'premiumPriority'), false, `${name} should have no premiumPriority key at all`);
  }
  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(hub, 'premiumPriority'), false);
});

// parentHub (2026-09-08): propagates from the request onto the hub record only (not its
// children -- a plain move/wiring child isn't itself a hub), same pattern as premiumPriority
// above. Set by decompose-loop-autoroute.js when this hub rescues a stuck child of an
// existing hub.
test('parentHub on the request propagates to the hub itself, not its children', () => {
  const dir = tmpRepo();
  const reqPath = path.join(dir, 'queue', 'file-decompose-requests', 'p.json');
  fs.writeFileSync(reqPath, JSON.stringify({ ...PLAN, parentHub: 'hub-original' }));

  withEnv(dir, { AGENT_MANAGER_DECOMPOSE_STACKED: 'false' }, ({ sweep }) => {
    assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1);
  });

  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.equal(hub.parentHub, 'hub-original', 'the hub itself should carry parentHub');

  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc')).sort();
  for (const name of adhoc) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', name), 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(rec, 'parentHub'), false, `${name} (a plain child, not a hub) should have no parentHub key`);
  }
});

test('no parentHub on the request -- the hub gets no field at all (not even false)', () => {
  const dir = tmpRepo();
  const reqPath = path.join(dir, 'queue', 'file-decompose-requests', 'p.json');
  fs.writeFileSync(reqPath, JSON.stringify(PLAN));

  withEnv(dir, { AGENT_MANAGER_DECOMPOSE_STACKED: 'false' }, ({ sweep }) => {
    assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1);
  });

  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(hub, 'parentHub'), false);
});

// --- stacked model -------------------------------------------------------------------

test('stacked mode + LLM wiring child (det-wiring off): one shared branch, sequential dependsOn chain, atomic children', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'p.json'), JSON.stringify(PLAN));
  withEnv(dir, { AGENT_MANAGER_DECOMPOSE_DET_WIRING: 'false' }, ({ sweep }) => {
    const s = sweep({ pipelineDir: dir });
    assert.equal(s.filedHubs, 1);
    assert.equal(s[PLAN.id].branch, 'agent/decompose-decompose-app-py');
  });

  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc')).sort();
  assert.equal(adhoc.length, 3);
  const [m1, m2, wiring] = adhoc.map((n) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', n), 'utf8')));

  assert.equal(m1.stacked.branch, 'agent/decompose-decompose-app-py');
  assert.equal(m1.stacked.seq, 1);
  assert.equal(m1.dependsOn, undefined, 'first move has nothing to wait on');
  assert.equal(m1.atomic, true);
  assert.equal(m1.noDecompose, true);

  assert.equal(m2.stacked.seq, 2);
  assert.deepEqual(m2.dependsOn, [m1.id], 'move 2 waits on move 1');

  assert.equal(wiring.stacked.seq, 3);
  assert.deepEqual(wiring.dependsOn, [m2.id], 'wiring waits only on the last move (sequential chain)');
  assert.equal(wiring.atomic, true);

  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.equal(hub.mode, 'stacked');
  assert.equal(hub.branch, 'agent/decompose-decompose-app-py');
  assert.equal(hub.sourceFile, 'python/dashboard/app.py');
  assert.equal(hub.integrationGate.status, 'pending');

  // 2026-09-06: same real-navigable-id requirement as the legacy-mode test above.
  assert.equal(m1.promptContext.decomposedFrom, hub.id);
  assert.equal(m2.promptContext.decomposedFrom, hub.id);
  assert.equal(wiring.promptContext.decomposedFrom, hub.id);
});

test('stacked wiring prompt: bottom-of-file placement when a new module imports back from the source', () => {
  const dir = tmpRepo();
  // A real-ish source so the Python preflight runs and finds the shared dep.
  const srcDir = path.join(dir, 'python', 'dashboard');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'app.py'), [
    'from flask import Flask, jsonify',
    'app = Flask(__name__)',
    'def second_brain_dir():',
    '    return None',
    'def _reports_root():',
    '    return second_brain_dir()',
    '@app.route("/api/reports")',
    'def api_reports():',
    '    return jsonify(_reports_root())',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'r.json'), JSON.stringify({
    id: 'decompose-reports',
    sourceFile: 'python/dashboard/app.py',
    moves: [{ newFile: 'python/dashboard/routes/reports.py', kind: 'flask-blueprint', blueprint: 'reports_bp',
      symbols: ['_reports_root', 'api_reports'] }],
  }));
  withEnv(dir, { AGENT_MANAGER_DECOMPOSE_DET_WIRING: 'false' }, ({ sweep }) => { assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1); });

  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc')).sort();
  const move = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', adhoc.find((n) => n.includes('-01-'))), 'utf8'));
  assert.match(move.promptContext.rawText, /reads these names defined in .* that are NOT being moved: `second_brain_dir`/);
  // must tell the model to import the back-reference LAZILY (a module-top `from app import`
  // is the circular import that crashed the dashboard -- PR #86)
  assert.match(move.promptContext.rawText, /Do NOT add a top-level `from app import/);
  assert.match(move.promptContext.rawText, /import them LAZILY/i);

  const wiring = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', adhoc.find((n) => n.includes('wiring'))), 'utf8'));
  assert.match(wiring.promptContext.rawText, /at the very BOTTOM of/);
  assert.match(wiring.promptContext.rawText, /Do NOT put them right after `app = Flask\(\.\.\.\)`/);
  assert.match(wiring.promptContext.rawText, /python3 -c "import app"/);
});

test('preflight hard-stops a plan whose symbol is not defined -- hub filed blocked, no children', () => {
  const dir = tmpRepo();
  const srcDir = path.join(dir, 'python', 'dashboard');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'app.py'), 'x = 1\n');
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'b.json'), JSON.stringify({
    id: 'decompose-bad',
    sourceFile: 'python/dashboard/app.py',
    moves: [{ newFile: 'python/dashboard/routes/ghost.py', kind: 'flask-blueprint', blueprint: 'ghost_bp',
      symbols: ['api_does_not_exist'] }],
  }));
  withEnv(dir, {}, ({ sweep }) => {
    const s = sweep({ pipelineDir: dir });
    assert.equal(s.blockedHubs, 1);
    assert.equal(s.filedHubs, 0);
  });
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc')) && fs.readdirSync(path.join(dir, 'queue', 'adhoc')).length || 0, 0);
  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.equal(hub.planValidation.ok, false);
  assert.match(hub.blockedReason, /not defined at module scope/);
});

test('preflight hard-stops a plan with a stray external reference to a moved symbol', () => {
  const dir = tmpRepo();
  const srcDir = path.join(dir, 'python', 'dashboard');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'app.py'), [
    'def helper():',
    '    return 1',
    'def other():',
    '    return helper() + 1', // stray call site outside the move set
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 's.json'), JSON.stringify({
    id: 'decompose-stray',
    sourceFile: 'python/dashboard/app.py',
    moves: [{ newFile: 'python/dashboard/routes/h.py', kind: 'other', symbols: ['helper'] }],
  }));
  withEnv(dir, {}, ({ sweep }) => {
    assert.equal(sweep({ pipelineDir: dir }).blockedHubs, 1);
  });
  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.match(hub.blockedReason, /still referenced elsewhere/);
});

test('sweep is idempotent -- a stamped request is skipped', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'p.json'), JSON.stringify(PLAN));
  withEnv(dir, {}, ({ sweep }) => {
    sweep({ pipelineDir: dir });
    const s2 = sweep({ pipelineDir: dir });
    assert.equal(s2.checked, 0);
    assert.match(s2.skipped[0], /already filed/);
  });
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'adhoc')).length, 2);
});

test('kill switch + a malformed request are both no-ops', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'bad.json'), JSON.stringify({ id: 'x', sourceFile: 'a.js' }));
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'ok.json'), JSON.stringify(PLAN));
  withEnv(dir, { AGENT_MANAGER_FILE_DECOMPOSE_TO_HUB: 'false' }, ({ sweep }) => {
    assert.equal(sweep({ pipelineDir: dir }).filedHubs, 0);
  });
  withEnv(dir, {}, ({ sweep }) => {
    assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1);
  });
});

// --- deterministic blueprint wiring (default) -----------------------------------------

test('det-wiring default: all-blueprint plan files NO wiring child, hub carries wiringPending + wiringMoves', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'p.json'), JSON.stringify(PLAN));
  withEnv(dir, {}, ({ sweep }) => { assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1); });

  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc')).sort();
  assert.equal(adhoc.length, 2, 'only the 2 move children, no -99-wiring');
  assert.ok(!adhoc.some((n) => n.includes('wiring')));

  const [m1, m2] = adhoc.map((n) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', n), 'utf8')));
  assert.equal(m1.stacked.total, 2, 'total no longer counts a wiring child');
  assert.deepEqual(m2.dependsOn, [m1.id]);

  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.equal(hub.wiringPending, true);
  assert.deepEqual(hub.wiringMoves, [
    { newFile: 'python/dashboard/routes/plugins.py', blueprint: 'plugins_bp', kind: 'flask-blueprint' },
    { newFile: 'python/dashboard/routes/hardware.py', blueprint: 'hardware_bp', kind: 'flask-blueprint' },
  ]);
  assert.equal(hub.progress.total, 2);
});

test('det-wiring + a mixed plan: LLM wiring child is filed but scoped to the non-blueprint move only', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'm.json'), JSON.stringify({
    id: 'decompose-mixed',
    sourceFile: 'python/dashboard/templates/index.html',
    moves: [
      { newFile: 'python/dashboard/static/js/hardware.js', kind: 'script-extract', symbols: ['renderHardwareTab'] },
      { newFile: 'python/dashboard/routes/hw.py', kind: 'flask-blueprint', blueprint: 'hw_bp', symbols: ['api_hw'] },
    ],
  }));
  withEnv(dir, {}, ({ sweep }) => { assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1); });

  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc')).sort();
  const wiring = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', adhoc.find((n) => n.includes('wiring'))), 'utf8'));
  assert.match(wiring.promptContext.rawText, /static\/js\/hardware\.js/);
  assert.doesNotMatch(wiring.promptContext.rawText, /register_blueprint/, 'blueprint move is handled deterministically, not by the child');

  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.equal(hub.wiringPending, true);
  assert.deepEqual(hub.wiringMoves, [{ newFile: 'python/dashboard/routes/hw.py', blueprint: 'hw_bp', kind: 'flask-blueprint' }]);
});

test('det-wiring kill switch restores the LLM wiring child for every move', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'p.json'), JSON.stringify(PLAN));
  withEnv(dir, { AGENT_MANAGER_DECOMPOSE_DET_WIRING: 'false' }, ({ sweep }) => {
    assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1);
  });
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'adhoc')).length, 3);
  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.equal(hub.wiringPending, undefined);
});

// --- script-extract deterministic-apply validation (2026-09-07, "Ghost in the Machine") -
// Real incident: a script-extract move-child was left to the model even though the move
// is 100% mechanical -- validatePlan() now runs the same real check at plan-validation
// time file-decompose-to-hub.js already does for .py moves, using script-extract.js's
// V8-parser oracle instead of a Python AST check.

function writeHtmlWithScript(dir, relPath, scriptBody) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `<html><body>\n<script>\n${scriptBody}\n</script>\n</body></html>\n`);
}

test('staticCheckScriptExtractMove: every named symbol resolves cleanly -> ok:true', () => {
  const dir = tmpRepo();
  writeHtmlWithScript(dir, 'python/dashboard/templates/index.html', 'function renderHardwareTab() {\n  return 1;\n}\n');
  withEnv(dir, {}, ({ staticCheckScriptExtractMove }) => {
    const result = staticCheckScriptExtractMove(dir, 'python/dashboard/templates/index.html', ['renderHardwareTab']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
  });
});

test('staticCheckScriptExtractMove: an unresolvable symbol -> ok:false with the exact reason', () => {
  const dir = tmpRepo();
  writeHtmlWithScript(dir, 'python/dashboard/templates/index.html', 'function realOne() {}\n');
  withEnv(dir, {}, ({ staticCheckScriptExtractMove }) => {
    const result = staticCheckScriptExtractMove(dir, 'python/dashboard/templates/index.html', ['realOne', 'doesNotExist']);
    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0], /doesNotExist/);
  });
});

test('staticCheckScriptExtractMove: returns null (advisory-only) for an unsupported source type or a missing file', () => {
  const dir = tmpRepo();
  withEnv(dir, {}, ({ staticCheckScriptExtractMove }) => {
    assert.equal(staticCheckScriptExtractMove(dir, 'src/app.py', ['x']), null);
    assert.equal(staticCheckScriptExtractMove(dir, 'python/dashboard/templates/index.html', ['x']), null, 'file does not exist yet');
    assert.equal(staticCheckScriptExtractMove(dir, 'src/does-not-exist.js', ['x']), null, 'a real .js extension but a missing file');
  });
});

// 2026-09-08, Grimmethy: "Yes, please build it" -- root-caused live: a review-task.js
// (plain .js) decompose had every move fall back to move.kind:'module-extract' (no
// deterministic apply path at all) purely because this function was gated on `.html`.
function writeJs(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

test('staticCheckScriptExtractMove: a plain .js source is now checkable too (every symbol resolves cleanly -> ok:true)', () => {
  const dir = tmpRepo();
  writeJs(dir, 'src/review-task.js', "'use strict';\n\nfunction isEmptyApprovalSource() {\n  return true;\n}\n\nfunction isAdvisoryProseSource() {\n  return false;\n}\n");
  withEnv(dir, {}, ({ staticCheckScriptExtractMove }) => {
    const result = staticCheckScriptExtractMove(dir, 'src/review-task.js', ['isEmptyApprovalSource', 'isAdvisoryProseSource']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
  });
});

test('staticCheckScriptExtractMove: a plain .js source with an unresolvable symbol -> ok:false with the exact reason', () => {
  const dir = tmpRepo();
  writeJs(dir, 'src/review-task.js', 'function realOne() {}\n');
  withEnv(dir, {}, ({ staticCheckScriptExtractMove }) => {
    const result = staticCheckScriptExtractMove(dir, 'src/review-task.js', ['realOne', 'doesNotExist']);
    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0], /doesNotExist/);
  });
});

test('staticCheckScriptExtractMove: .mjs and .cjs sources are also checkable', () => {
  const dir = tmpRepo();
  for (const ext of ['.mjs', '.cjs']) {
    writeJs(dir, `src/thing${ext}`, 'function realOne() {}\n');
  }
  withEnv(dir, {}, ({ staticCheckScriptExtractMove }) => {
    for (const ext of ['.mjs', '.cjs']) {
      const result = staticCheckScriptExtractMove(dir, `src/thing${ext}`, ['realOne']);
      assert.equal(result.ok, true, `${ext} should resolve cleanly`);
    }
  });
});

test('validatePlan + fileHub: a script-extract move with every symbol resolvable gets deterministicApply stamped, no LLM instructions in rawText', () => {
  const dir = tmpRepo();
  writeHtmlWithScript(dir, 'python/dashboard/templates/index.html', 'function renderHardwareTab() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'se.json'), JSON.stringify({
    id: 'decompose-se',
    sourceFile: 'python/dashboard/templates/index.html',
    moves: [{ newFile: 'python/dashboard/static/js/hardware.js', kind: 'script-extract', symbols: ['renderHardwareTab'] }],
  }));
  withEnv(dir, {}, ({ sweep }) => { assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1); });

  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc'));
  const moveFile = adhoc.find((n) => n.includes('hardware-js') && !n.includes('wiring'));
  const move = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', moveFile), 'utf8'));
  assert.equal(move.promptContext.deterministicApply, 'script-extract');
  assert.equal(move.promptContext.sourceFile, 'python/dashboard/templates/index.html');
  assert.deepEqual(move.promptContext.symbols, ['renderHardwareTab']);
});

test('validatePlan + fileHub: a plain .js source script-extract move ALSO gets deterministicApply stamped, no LLM instructions in rawText', () => {
  const dir = tmpRepo();
  writeJs(dir, 'src/review-task.js', "'use strict';\n\nfunction isEmptyApprovalSource() {\n  return true;\n}\n");
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'se3.json'), JSON.stringify({
    id: 'decompose-se3',
    sourceFile: 'src/review-task.js',
    moves: [{ newFile: 'src/lib/review-validation.js', kind: 'script-extract', symbols: ['isEmptyApprovalSource'] }],
  }));
  withEnv(dir, {}, ({ sweep }) => { assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1); });

  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc'));
  const moveFile = adhoc.find((n) => n.includes('review-validation-js') && !n.includes('wiring'));
  const move = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', moveFile), 'utf8'));
  assert.equal(move.promptContext.deterministicApply, 'script-extract');
  assert.equal(move.promptContext.sourceFile, 'src/review-task.js');
  assert.deepEqual(move.promptContext.symbols, ['isEmptyApprovalSource']);
});

test('validatePlan + fileHub: an unresolvable symbol in a script-extract move blocks the whole hub (hardProblems), same as the .py path', () => {
  const dir = tmpRepo();
  writeHtmlWithScript(dir, 'python/dashboard/templates/index.html', 'function realOne() {}\n');
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'se2.json'), JSON.stringify({
    id: 'decompose-se2',
    sourceFile: 'python/dashboard/templates/index.html',
    moves: [{ newFile: 'python/dashboard/static/js/hardware.js', kind: 'script-extract', symbols: ['realOne', 'ghostFunction'] }],
  }));
  withEnv(dir, {}, ({ sweep }) => { assert.equal(sweep({ pipelineDir: dir }).blockedHubs, 1); });

  assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc')) ? fs.readdirSync(path.join(dir, 'queue', 'adhoc')).length : 0, 0, 'no children filed for a blocked plan');
  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', fs.readdirSync(path.join(dir, 'queue', 'coordinating'))[0]), 'utf8'));
  assert.equal(hub.planValidation.ok, false);
  assert.match(hub.planValidation.problems.join(' '), /ghostFunction/);
});

test('validatePlan: a script-extract move whose source file does not exist yet stays advisory-only (no deterministicApply, no hardProblems) -- unchanged prior behavior', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'mixed.json'), JSON.stringify({
    id: 'decompose-mixed2',
    sourceFile: 'python/dashboard/templates/index.html',
    moves: [{ newFile: 'python/dashboard/static/js/hardware.js', kind: 'script-extract', symbols: ['renderHardwareTab'] }],
  }));
  withEnv(dir, {}, ({ sweep }) => { assert.equal(sweep({ pipelineDir: dir }).filedHubs, 1); });
  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc'));
  const moveFile = adhoc.find((n) => n.includes('hardware-js') && !n.includes('wiring'));
  assert.ok(moveFile, 'the move child must still be filed -- no source file to check against is advisory-only, plan still proceeds');
  const move = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', moveFile), 'utf8'));
  assert.equal(move.promptContext.deterministicApply, undefined);
});

// --- Tier 1: fully-mechanical HTML plan -> one deterministic one-pass task, no hub -------
// ([[hub-task-integration]] / concept-hub-task-integration-549f09, spec
// Docs/hub-task-independent-merge.md)

test('one-pass: a fully-mechanical HTML plan files ONE deterministic task, no hub, no stacked branch', () => {
  const dir = tmpRepo();
  writeHtmlWithScript(dir, 'python/dashboard/templates/index.html',
    'function alpha(){return 1;}\nfunction beta(){return 2;}\nfunction gamma(){return 3;}\nfunction keep(){return 9;}\n');
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'p.json'), JSON.stringify({
    id: 'decompose-index-html',
    sourceFile: 'python/dashboard/templates/index.html',
    moves: [
      { newFile: 'python/dashboard/static/js/ab.js', kind: 'script-extract', symbols: ['alpha', 'beta'] },
      { newFile: 'python/dashboard/static/js/g.js', kind: 'script-extract', symbols: ['gamma'] },
    ],
  }));

  withEnv(dir, {}, ({ sweep }) => {
    const s = sweep({ pipelineDir: dir });
    assert.equal(s['decompose-index-html'].onePass, true);
    assert.equal(s.filedHubs, 1); // counted as a "filed" outcome (not blocked)
  });

  assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating')) && fs.readdirSync(path.join(dir, 'queue', 'coordinating')).length || 0, 0, 'no hub filed');
  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc'));
  assert.equal(adhoc.length, 1);
  assert.match(adhoc[0], /-onepass\.json$/);
  const task = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', adhoc[0]), 'utf8'));
  assert.equal(task.promptContext.deterministicApply, 'one-pass-decompose');
  assert.equal(task.promptContext.sourceFile, 'python/dashboard/templates/index.html');
  assert.equal(task.promptContext.moves.length, 2);
  assert.deepEqual(task.promptContext.moves[0].symbols, ['alpha', 'beta']);
  assert.equal(task.stacked, undefined);
  assert.equal(task.atomic, true);
  const req = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'p.json'), 'utf8'));
  assert.equal(req.onePassTaskId, task.id);
});

test('one-pass: a mixed plan (a non-script-extract move) still files a hub', () => {
  const dir = tmpRepo();
  writeHtmlWithScript(dir, 'python/dashboard/templates/index.html',
    'function alpha(){return 1;}\nfunction beta(){return 2;}\n');
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'p.json'), JSON.stringify({
    id: 'decompose-mixed',
    sourceFile: 'python/dashboard/templates/index.html',
    moves: [
      { newFile: 'python/dashboard/static/js/a.js', kind: 'script-extract', symbols: ['alpha'] },
      { newFile: 'python/dashboard/static/js/b.js', kind: 'module-extract', symbols: ['beta'] },
    ],
  }));
  withEnv(dir, {}, ({ sweep }) => { sweep({ pipelineDir: dir }); });
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'coordinating')).length, 1, 'hub filed for a mixed plan');
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'adhoc')).some((n) => n.includes('-onepass')), false);
});

test('one-pass: AGENT_MANAGER_DECOMPOSE_ONE_PASS=false keeps the stacked hub', () => {
  const dir = tmpRepo();
  writeHtmlWithScript(dir, 'python/dashboard/templates/index.html',
    'function alpha(){return 1;}\nfunction beta(){return 2;}\n');
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'p.json'), JSON.stringify({
    id: 'decompose-x',
    sourceFile: 'python/dashboard/templates/index.html',
    moves: [
      { newFile: 'python/dashboard/static/js/a.js', kind: 'script-extract', symbols: ['alpha'] },
      { newFile: 'python/dashboard/static/js/b.js', kind: 'script-extract', symbols: ['beta'] },
    ],
  }));
  const prev = process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS;
  process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS = 'false';
  try {
    delete require.cache[require.resolve('./decompose-one-pass.js')];
    withEnv(dir, {}, ({ sweep }) => { sweep({ pipelineDir: dir }); });
    assert.equal(fs.readdirSync(path.join(dir, 'queue', 'coordinating')).length, 1, 'hub filed, one-pass disabled');
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS; else process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS = prev;
    delete require.cache[require.resolve('./decompose-one-pass.js')];
  }
});
