'use strict';

// task-selection.js no longer requires task-sources.js (roadmap P3): the adhoc and derived generators are registered with setPreemptLoaders. This test
// loads ONLY task-selection.js, so the generators are fakes and the registration contract is what is under test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getNextTask, setPreemptLoaders } = require('./task-selection.js');
const { clearRegistry } = require('../task-source-registry.js');

class Fx {
  static pipeline(dir, name, body) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-selection-loaders-'));
    process.env.AGENT_MANAGER_REPO_ROOT = root;
    process.env.AGENT_MANAGER_PIPELINE_DIR = root;
    fs.mkdirSync(path.join(root, 'queue', dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'queue', dir, name), JSON.stringify(body));
    clearRegistry();
    return root;
  }
}

test('a premium adhoc task is generated through the registered nextAdhocTask loader', () => {
  Fx.pipeline('adhoc', 'p.json', { id: 'p', premiumPriority: true });
  setPreemptLoaders({ nextAdhocTask: () => ({ id: 'from-adhoc-loader' }), nextDerivedTask: () => ({ id: 'from-derived-loader' }) });
  assert.equal(getNextTask().id, 'from-adhoc-loader');
});

test('a premium derived task is generated through the registered nextDerivedTask loader', () => {
  Fx.pipeline('derived', 'p.json', { id: 'p', premiumPriority: true });
  setPreemptLoaders({ nextAdhocTask: () => ({ id: 'from-adhoc-loader' }), nextDerivedTask: () => ({ id: 'from-derived-loader' }) });
  assert.equal(getNextTask().id, 'from-derived-loader');
});

test('setPreemptLoaders refuses anything that is not two functions', () => {
  assert.throws(() => setPreemptLoaders(), /nextAdhocTask/);
  assert.throws(() => setPreemptLoaders({ nextAdhocTask: () => null }), /nextDerivedTask/);
  assert.throws(() => setPreemptLoaders({ nextAdhocTask: 'x', nextDerivedTask: () => null }), /nextAdhocTask/);
});

test('lib/task-selection.js does not require task-sources.js', () => {
  const { buildGraph } = require('../../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..', '..'));
  assert.equal(graph.all['src/lib/task-selection.js'].includes('src/task-sources.js'), false);
});

test('task-sources.js registers its real generators when it loads', () => {
  Fx.pipeline('adhoc', 'real.json', { id: 'real', premiumPriority: true, title: 't', promptContext: { rawText: 'x' } });
  clearRegistry();
  require('../model-profile-registry.js').clearModelProfileRegistry();
  delete require.cache[require.resolve('../task-sources.js')];
  const sources = require('../task-sources.js');
  assert.equal(typeof sources.nextAdhocTask, 'function');
  assert.equal(typeof sources.getNextTask, 'function');
});
