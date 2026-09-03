'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withEnv(repoRoot, fn) {
  const prevR = process.env.AGENT_MANAGER_REPO_ROOT;
  const prevP = process.env.AGENT_MANAGER_PIPELINE_DIR;
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  delete require.cache[require.resolve('./config.js')];
  delete require.cache[require.resolve('./file-decompose-to-hub.js')];
  const mod = require('./file-decompose-to-hub.js');
  try { return fn(mod); }
  finally {
    if (prevR === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prevR;
    if (prevP === undefined) delete process.env.AGENT_MANAGER_PIPELINE_DIR; else process.env.AGENT_MANAGER_PIPELINE_DIR = prevP;
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

test('sweep files a hub + one child per move + a gated wiring task; request stamped', () => {
  const dir = tmpRepo();
  const reqPath = path.join(dir, 'queue', 'file-decompose-requests', 'p.json');
  fs.writeFileSync(reqPath, JSON.stringify(PLAN));

  withEnv(dir, ({ sweep }) => {
    const s = sweep({ pipelineDir: dir });
    assert.equal(s.filedHubs, 1);
  });

  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc')).sort();
  assert.equal(adhoc.length, 3); // 2 moves + 1 wiring
  const coord = fs.readdirSync(path.join(dir, 'queue', 'coordinating'));
  assert.equal(coord.length, 1);

  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', coord[0]), 'utf8'));
  assert.equal(hub.status, 'coordinating');
  assert.equal(hub.subTasks.length, 3);
  assert.equal(hub.progress.total, 3);

  const wiring = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', adhoc.find((n) => n.includes('wiring'))), 'utf8'));
  assert.equal(wiring.dependsOn.length, 2, 'wiring task waits on both moves');
  assert.match(wiring.promptContext.rawText, /register_blueprint\(plugins_bp\)/);

  const move1 = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', adhoc.find((n) => n.includes('-01-'))), 'utf8'));
  assert.equal(move1.dependsOn, undefined, 'moves are not chained to each other');
  assert.match(move1.promptContext.rawText, /VERBATIM: `api_plugins_marketplace`, `api_plugins_install`/);
  assert.match(move1.promptContext.rawText, /@plugins_bp\.route/);
  assert.match(move1.promptContext.rawText, /py_compile/);
  assert.match(move1.promptContext.rawText, /Do NOT modify, reformat/);

  const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  assert.ok(req.hubFiledAt);
  assert.equal(req.hubChildIds.length, 3);
});

test('sweep is idempotent -- a stamped request is skipped', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'p.json'), JSON.stringify(PLAN));
  withEnv(dir, ({ sweep }) => {
    sweep({ pipelineDir: dir });
    const s2 = sweep({ pipelineDir: dir });
    assert.equal(s2.checked, 0);
    assert.match(s2.skipped[0], /already filed/);
  });
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'adhoc')).length, 3); // not doubled
});

test('script-extract kind gets the browser-script framing + a <script src> wiring line', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'idx.json'), JSON.stringify({
    id: 'decompose-index-html',
    sourceFile: 'python/dashboard/templates/index.html',
    moves: [{ newFile: 'python/dashboard/static/js/tab-joblist.js', kind: 'script-extract', symbols: ['renderJobListTab'] }],
  }));
  withEnv(dir, ({ sweep }) => { sweep({ pipelineDir: dir }); });
  const adhoc = fs.readdirSync(path.join(dir, 'queue', 'adhoc'));
  const move = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', adhoc.find((n) => n.includes('-01-'))), 'utf8'));
  assert.match(move.promptContext.rawText, /plain browser script/);
  assert.match(move.promptContext.rawText, /node --check/);
  const wiring = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', adhoc.find((n) => n.includes('wiring'))), 'utf8'));
  assert.match(wiring.promptContext.rawText, /<script src="\/static\/js\/tab-joblist\.js">/);
});

test('kill switch + a malformed request (no moves array) are both no-ops', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'bad.json'), JSON.stringify({ id: 'x', sourceFile: 'a.js' }));
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'ok.json'), JSON.stringify(PLAN));
  process.env.AGENT_MANAGER_FILE_DECOMPOSE_TO_HUB = 'false';
  withEnv(dir, ({ sweep }) => { assert.equal(sweep({ pipelineDir: dir }).filedHubs, 0); });
  delete process.env.AGENT_MANAGER_FILE_DECOMPOSE_TO_HUB;
  withEnv(dir, ({ sweep }) => {
    const s = sweep({ pipelineDir: dir });
    assert.equal(s.filedHubs, 1); // only ok.json; bad.json filtered by readRequests
  });
});
