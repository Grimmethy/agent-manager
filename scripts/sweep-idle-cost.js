#!/usr/bin/env node
'use strict';

// sweep-idle-cost.js -- what does ONE idle pass of each watchdog sweep cost, with the queue-events journal on versus off? (ADR-0024, HUB0330 piece 7)
//
//   node scripts/sweep-idle-cost.js [--count N]       N task files in queue/done (default 500)
//
// Builds a throwaway pipeline directory holding N finished tasks (a mix: pending-merge tasks that name an agent/* branch, merged redos with promptContext.redoOf,
// and plain merged tasks), then for each of redo-supersede-sweep, branch-defect-readmit-sweep and branch-conflict-readmit-sweep runs ONE pass in two modes:
//   off      AGENT_MANAGER_QUEUE_EVENTS=off: the old behaviour, a full listing and parse of queue/done on every pass
//   journal  the same second pass with the journal on: the first run was the catch-up and nothing has happened since, so it should be idle
// Both modes run the identical sequence (a first run, then the measured pass a minute later), so the journal is the only difference between the rows.
// and prints one JSON object { count, sweeps: [{ sweep, mode, readdir, readFile, ms }] }: directory listings, file reads and wall-clock milliseconds, counted through the
// filesystem each sweep accepts as an argument. Git is replaced by a stub that reports every branch as gone, so the numbers are the queue-scanning cost alone, no
// network and no repository. This measures the code paths on a fixture; the LIVE before and after on the running pipeline is scripts/idle-cost-audit.py.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweep: redoSweep } = require('../src/redo-supersede-sweep.js');
const { sweepBranchDefects } = require('../src/branch-defect-readmit-sweep.js');
const { sweepBranchConflicts } = require('../src/branch-conflict-readmit-sweep.js');

function buildFixture(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-idle-cost-'));
  const done = path.join(root, 'queue', 'done');
  fs.mkdirSync(done, { recursive: true });
  const write = (id, extra) => fs.writeFileSync(path.join(done, `${id}.json`), JSON.stringify({ id, domain: 'adhoc', status: 'done', ...extra }));
  for (let i = 0; i < count; i++) {
    const kind = i % 3;
    if (kind === 0) {
      write(`t${i}`, { terminalDisposition: 'pending-merge', promptContext: { rawText: 'fix it' }, history: [{ stage: 'applied', at: 'x', detail: `agent/t${i}` }] });
    } else if (kind === 1) {
      write(`r${i}`, { terminalDisposition: 'merged', mergedAt: '2026-10-31T00:00:00Z', promptContext: { redoOf: `t${i - 1}` } });
    } else {
      write(`d${i}`, { terminalDisposition: 'merged', mergedAt: '2026-10-31T00:00:00Z', promptContext: { rawText: 'done' } });
    }
  }
  return { root, project: { label: 'fixture', repoRoot: root, pipelineDir: root } };
}

// A filesystem wrapper that counts directory listings and file reads.
function countingFs() {
  const c = { readdir: 0, readFile: 0 };
  const impl = {
    ...fs,
    readdirSync: (...a) => { c.readdir += 1; return fs.readdirSync(...a); },
    readFileSync: (...a) => { c.readFile += 1; return fs.readFileSync(...a); },
  };
  return { impl, c };
}

const noGit = () => ({ code: 1, out: '', err: 'branch gone (fixture stub)' });
const noRequest = async () => ({ status: 200, json: [] });
const noRequeue = async () => ({ ok: true });
const quiet = () => {};

// name -> (fsImpl, env, now) -> Promise, each calling the real sweep on the fixture project
function runners(fx) {
  return {
    'redo-supersede': (fsImpl, env, now) => redoSweep({ projects: [fx.project], request: noRequest, env: { AGENT_MANAGER_REDO_SUPERSEDE: 'on', ...env }, fsImpl, log: quiet, now }),
    'branch-defect-readmit': (fsImpl, env, now) => sweepBranchDefects({ pipelineDir: fx.root, repoRoot: fx.root, mainBranch: 'main', now, modeOverride: 'on', git: noGit, requeue: noRequeue, fetch: false, env, fsImpl }),
    'branch-conflict-readmit': (fsImpl, env, now) => sweepBranchConflicts({ pipelineDir: fx.root, repoRoot: fx.root, mainBranch: 'main', now, modeOverride: 'on', git: noGit, requeue: noRequeue, fetch: false, env, fsImpl }),
  };
}

async function measure({ count = 500 } = {}) {
  const rows = [];
  const t0 = Date.now();
  for (const mode of ['off', 'journal']) {
    const fx = buildFixture(count);                          // a fresh pipeline directory per mode, so one mode's state files cannot help the other
    try {
      for (const [name, run] of Object.entries(runners(fx))) {
        const env = mode === 'off' ? { AGENT_MANAGER_QUEUE_EVENTS: 'off' } : {};
        await run(fs, env, t0);                              // the same first run in both modes (with the journal on it is the catch-up full scan); not measured
        const { impl, c } = countingFs();
        const start = process.hrtime.bigint();
        await run(impl, env, t0 + 60 * 1000);                // the measured pass, a minute later, nothing changed
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        rows.push({ sweep: name, mode, readdir: c.readdir, readFile: c.readFile, ms: Math.round(ms * 100) / 100 });
      }
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }
  return { count, sweeps: rows };
}

module.exports = { measure, buildFixture };

if (require.main === module) {
  const i = process.argv.indexOf('--count');
  const count = i > 0 ? Number(process.argv[i + 1]) : 500;
  measure({ count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 500 })
    .then((r) => { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); })
    .catch((e) => { console.error(`[sweep-idle-cost] ${e.message}`); process.exit(1); });
}
