'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseSpecSections } = require('./product-spec-to-hub.js');

function withEnv(repoRoot, fn) {
  const prevRepo = process.env.AGENT_MANAGER_REPO_ROOT;
  const prevPipe = process.env.AGENT_MANAGER_PIPELINE_DIR;
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  delete require.cache[require.resolve('./config.js')];
  delete require.cache[require.resolve('./product-spec-to-hub.js')];
  const mod = require('./product-spec-to-hub.js');
  try { return fn(mod); }
  finally {
    if (prevRepo === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prevRepo;
    if (prevPipe === undefined) delete process.env.AGENT_MANAGER_PIPELINE_DIR; else process.env.AGENT_MANAGER_PIPELINE_DIR = prevPipe;
    delete require.cache[require.resolve('./config.js')];
    delete require.cache[require.resolve('./product-spec-to-hub.js')];
  }
}

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-hub-'));
  fs.mkdirSync(path.join(dir, 'queue', 'product-spec-requests'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Docs'), { recursive: true });
  return dir;
}

const SPEC = (a, b, c) => [
  '# Product Specification', '',
  '<!-- section:AC-1 -->', '## First thing', '', a, '<!-- /section:AC-1 -->', '',
  '<!-- section:AC-2 -->', '## Second thing', '', b, '<!-- /section:AC-2 -->', '',
  '<!-- section:AC-3 -->', '## Third thing', '', c, '<!-- /section:AC-3 -->', '',
].join('\n');

test('parseSpecSections reads id/title/body and the filled flag', () => {
  const secs = parseSpecSections(SPEC('real prose here', '_(pending)_', ''));
  assert.equal(secs.length, 3);
  assert.deepEqual(secs.map((s) => s.id), ['AC-1', 'AC-2', 'AC-3']);
  assert.equal(secs[0].title, 'First thing');
  assert.equal(secs[0].filled, true);
  assert.equal(secs[1].filled, false); // _(pending)_
  assert.equal(secs[2].filled, false); // empty
});

test('sweep waits while any section is still pending', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'Docs', 'PRODUCT_SPEC.md'), SPEC('done', '_(pending)_', 'done'));
  fs.writeFileSync(path.join(dir, 'queue', 'product-spec-requests', 'r1.json'), JSON.stringify({ id: 'r1', buildHub: true, title: 'Feature R1' }));
  withEnv(dir, ({ sweep }) => {
    const s = sweep({ pipelineDir: dir });
    assert.equal(s.filedHubs, 0);
    assert.match(s.waiting[0], /2\/3 sections filled/);
  });
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating')), false);
});

test('sweep files a hub + one child per section once all are filled; request stamped', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'Docs', 'PRODUCT_SPEC.md'), SPEC('build the first', 'build the second', 'build the third'));
  const reqPath = path.join(dir, 'queue', 'product-spec-requests', 'r2.json');
  fs.writeFileSync(reqPath, JSON.stringify({ id: 'r2', buildHub: true, title: 'Feature R2' }));

  withEnv(dir, ({ sweep }) => {
    const s = sweep({ pipelineDir: dir });
    assert.equal(s.filedHubs, 1);
  });

  const children = fs.readdirSync(path.join(dir, 'queue', 'adhoc'));
  assert.equal(children.length, 3);
  const coord = fs.readdirSync(path.join(dir, 'queue', 'coordinating'));
  assert.equal(coord.length, 1);
  const hub = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', coord[0]), 'utf8'));
  assert.equal(hub.status, 'coordinating');
  assert.equal(hub.subTasks.length, 3);
  assert.equal(hub.progress.total, 3);

  const child0 = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'adhoc', children.find((c) => c.includes('ac-1'))), 'utf8'));
  assert.equal(child0.domain, 'adhoc');
  assert.equal(child0.source, 'manual');
  assert.match(child0.promptContext.rawText, /build the first/);
  assert.equal(child0.promptContext.decomposedFrom, 'product-spec:r2');
  assert.equal(child0.dependsOn, undefined); // no rigid chain

  const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  assert.ok(req.hubFiledAt);
  assert.equal(req.hubChildIds.length, 3);
});

test('sweep is idempotent -- a stamped request is skipped', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'Docs', 'PRODUCT_SPEC.md'), SPEC('a', 'b', 'c'));
  fs.writeFileSync(path.join(dir, 'queue', 'product-spec-requests', 'r3.json'), JSON.stringify({ id: 'r3', buildHub: true }));
  withEnv(dir, ({ sweep }) => {
    sweep({ pipelineDir: dir });
    const s2 = sweep({ pipelineDir: dir });
    assert.equal(s2.checked, 0);
  });
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'adhoc')).length, 3); // not doubled
});

test('a request without buildHub is ignored', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'Docs', 'PRODUCT_SPEC.md'), SPEC('a', 'b', 'c'));
  fs.writeFileSync(path.join(dir, 'queue', 'product-spec-requests', 'r4.json'), JSON.stringify({ id: 'r4' }));
  withEnv(dir, ({ sweep }) => {
    assert.equal(sweep({ pipelineDir: dir }).checked, 0);
  });
});

test('--force files a hub from only the filled sections', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'Docs', 'PRODUCT_SPEC.md'), SPEC('ready', '_(pending)_', 'ready'));
  fs.writeFileSync(path.join(dir, 'queue', 'product-spec-requests', 'r5.json'), JSON.stringify({ id: 'r5', buildHub: true }));
  withEnv(dir, ({ sweep }) => {
    const s = sweep({ pipelineDir: dir, force: true });
    assert.equal(s.filedHubs, 1);
  });
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'adhoc')).length, 2); // only the 2 filled
});

test('kill switch', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'Docs', 'PRODUCT_SPEC.md'), SPEC('a', 'b', 'c'));
  fs.writeFileSync(path.join(dir, 'queue', 'product-spec-requests', 'r6.json'), JSON.stringify({ id: 'r6', buildHub: true }));
  process.env.AGENT_MANAGER_PRODUCT_SPEC_TO_HUB = 'false';
  withEnv(dir, ({ sweep }) => {
    assert.equal(sweep({ pipelineDir: dir }).filedHubs, 0);
  });
  delete process.env.AGENT_MANAGER_PRODUCT_SPEC_TO_HUB;
});
