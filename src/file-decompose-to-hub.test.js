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
