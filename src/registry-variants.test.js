'use strict';

// `node src/capability-ledger.js --with-variants` annotates scorecard rows with the registry's variantOf parent through a child process
// (registry-variants.js), so capability-ledger.js does not import task-sources.js (roadmap P5). These tests run the real child and the real CLI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ledger = require('./capability-ledger.js');

class Fx {
  static root() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'registry-variants-'));
  }

  static env(root) {
    return { ...process.env, AGENT_MANAGER_REPO_ROOT: root, AGENT_MANAGER_PIPELINE_DIR: root };
  }

  static run(script, args, root, input) {
    return spawnSync(process.execPath, [path.join(__dirname, script), ...args], { env: Fx.env(root), input, encoding: 'utf8' });
  }
}

test('the child adds variantOf (null for a source with no parent) to every row it is given', () => {
  const rows = [{ source: 'adhoc', model: 'm:8b', n: 1 }, { source: 'no_such_source', model: 'm:8b', n: 2 }];
  const out = Fx.run('registry-variants.js', [], Fx.root(), JSON.stringify(rows));
  assert.equal(out.status, 0, out.stderr);
  const got = JSON.parse(out.stdout);
  assert.equal(got.length, 2);
  for (const r of got) assert.ok('variantOf' in r);
  assert.equal(got[1].variantOf, null);
  assert.equal(got[0].n, 1);
});

test('the child exits 1 with the reason on stderr when its input is not JSON', () => {
  const out = Fx.run('registry-variants.js', [], Fx.root(), 'not json');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /JSON/);
});

test('the CLI --with-variants prints rows that carry variantOf; without the flag they do not', () => {
  const root = Fx.root();
  const att = { at: new Date().toISOString(), finishedAt: new Date().toISOString(), outcome: 'succeeded', source: 'adhoc' };
  ledger.recordAttempt(root, att, { source: 'adhoc', taskId: 't1', env: { LOCAL_MODEL: 'm:8b', AGENT_MANAGER_INSTANCE_ID: 'worker-x' } });
  const withFlag = JSON.parse(Fx.run('capability-ledger.js', ['7', '--json', '--with-variants'], root).stdout);
  const without = JSON.parse(Fx.run('capability-ledger.js', ['7', '--json'], root).stdout);
  assert.equal(withFlag.length, 1);
  assert.ok('variantOf' in withFlag[0]);
  assert.equal('variantOf' in without[0], false);
});

test('capability-ledger.js has no import edge to task-sources.js', () => {
  const { buildGraph } = require('../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..'));
  assert.equal(graph.all['src/capability-ledger.js'].includes('src/task-sources.js'), false);
});
