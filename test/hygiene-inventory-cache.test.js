'use strict';

// Regression: a task that moves from queue/pending to queue/done must be counted under its done disposition on the next
// rebuild, not under a stale pending-era cache entry.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('a task moved from pending/ to done/ is counted under its done disposition after a rebuild', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-cache-'));
  const prevHome = process.env.HOME;
  process.env.HOME = path.join(tmp, 'home'); // keep the cache file out of the real home directory
  try {
    const pipelineDir = path.join(tmp, 'pipeline');
    const pendingDir = path.join(pipelineDir, 'queue', 'pending');
    const doneDir = path.join(pipelineDir, 'queue', 'done');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.mkdirSync(doneDir, { recursive: true });
    const file = 'obs-ac-1.json';
    fs.writeFileSync(path.join(pendingDir, file), JSON.stringify({ source: 'obs-src' }));

    const { buildHygieneInventory } = require('../src/hygiene-inventory.js');
    const source = {
      name: 'obs-src',
      hygieneFamily: { key: 'obs', label: 'Obs', idPrefixes: ['obs-'] },
    };
    const build = () => buildHygieneInventory({
      getRegisteredSource: () => null,
      getRegisteredSources: () => [source],
      getConfig: () => ({ repoRoot: tmp, pipelineDir }),
      isDependencySatisfied: () => true,
    });

    const first = build();
    const fam1 = first.families.find((f) => f.key === 'obs');
    assert.ok(fam1, 'family obs should be present');
    assert.equal(fam1.tasks.byState.pending, 1);

    // Move the task to done/ with a terminal disposition recorded in the file.
    fs.renameSync(path.join(pendingDir, file), path.join(doneDir, file));
    fs.writeFileSync(path.join(doneDir, file), JSON.stringify({ source: 'obs-src', terminalDisposition: 'merged' }));

    const second = build();
    const fam2 = second.families.find((f) => f.key === 'obs');
    assert.equal(fam2.tasks.byState.pending, undefined, 'no pending count may remain for the moved task');
    assert.equal(fam2.tasks.done.merged, 1, 'the moved task must carry its done disposition');
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
