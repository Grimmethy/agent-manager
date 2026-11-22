'use strict';

// End-to-end: the real generation CLI (`node task-sources.js`, run by every worker lane each tick) with two live
// lanes and lower-priority work already queued. 2026-09-19, PF-Client-Portal: pending held two derived tasks
// (priority 41), the log said "pending/ already has work queued, not adding another task" on every tick, and
// arch_discovery (30) never got a task in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(sources, { adhocInFlight = false, hubLive = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-priority-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const pending = mk('queue', 'pending'); mk('queue', 'drafting'); const instances = mk('instances');
  for (const lane of ['worker-a', 'worker-b']) fs.writeFileSync(path.join(instances, `${lane}.json`), JSON.stringify({ instanceId: lane, pid: process.pid }));
  // two already-queued tasks of a mid-priority source (50)
  for (const id of ['mid-1', 'mid-2']) fs.writeFileSync(path.join(pending, `${id}.json`), JSON.stringify({ id, source: 'probe_mid', domain: 'default', title: id }));
  if (adhocInFlight) {
    // Replace the mid-priority pair with two bot-adhoc children of hub-x (bot adhoc = 40; with a LIVE hub-x record they are hub tier = -1000).
    for (const id of ['mid-1', 'mid-2']) fs.writeFileSync(path.join(pending, `${id}.json`), JSON.stringify({ id, source: 'adhoc', domain: 'default', title: id, parentHub: 'hub-x' }));
    if (hubLive) fs.mkdirSync(path.join(root, 'queue', 'coordinating'), { recursive: true });
    if (hubLive) fs.writeFileSync(path.join(root, 'queue', 'coordinating', 'hub-x.json'), JSON.stringify({ id: 'hub-x', status: 'coordinating', createdAt: '2026-09-01T00:00:00Z' }));
  }
  fs.writeFileSync(path.join(root, 'task-domains.json'), JSON.stringify({ default: {} }));

  const registry = path.join(__dirname, 'task-source-registry.js');
  const reg = path.join(root, 'register.js');
  fs.writeFileSync(reg, `const { registerTaskSource } = require(${JSON.stringify(registry)});\n`
    + `registerTaskSource('probe_mid', { priority: 50, next: () => null });\n`
    + sources.map(([name, prio]) => `registerTaskSource('${name}', { priority: ${prio}, next: () => ({ id: '${name}-task', source: '${name}', domain: 'default', title: '${name}' }) });`).join('\n') + '\n');
  const manifest = path.join(root, 'plugins.json');
  fs.writeFileSync(manifest, JSON.stringify([{ name: 'probe', registerPath: reg, enabled: true }]));

  const res = spawnSync('node', [path.join(__dirname, 'task-sources.js')], {
    env: {
      ...process.env, AGENT_MANAGER_REPO_ROOT: root, AGENT_MANAGER_PIPELINE_DIR: root, AGENT_MANAGER_DOMAINS_PATH: path.join(root, 'task-domains.json'),
      AGENT_MANAGER_PLUGINS_MANIFEST: manifest, AGENT_MANAGER_TASK_SOURCES: '', AGENT_MANAGER_BRAIN_DUMP_PATH: path.join(root, 'brain-dump.json'),
    },
    encoding: 'utf8', timeout: 30000,
  });
  return { out: res.stdout + res.stderr, queued: fs.readdirSync(pending).sort() };
}

test('a higher-priority source still generates while lower-priority tasks fill every lane slot', () => {
  const { out, queued } = run([['probe_high', 30]]);
  assert.ok(queued.includes('probe_high-task.json'), `probe_high (30) must be queued despite 2 tasks (50) already in flight:\n${out}`);
  assert.match(out, /queued: .*probe_high-task\.json/);
});

test('a source BEHIND the queued work is still throttled (the throttle is not removed, only made priority-aware)', () => {
  const { out, queued } = run([['probe_low', 90]]);
  assert.ok(!queued.includes('probe_low-task.json'), 'probe_low (90) must not pile onto a full band');
  assert.match(out, /pending\/ already has work queued, not adding another task/);
});

// Hub tier (2026-09-30): in-flight hub work ranks -1000, so it counts against EVERY source at lane capacity -- the same way a premium
// task would -- where the same two tasks ranked as ordinary bot adhoc (40) let a priority-30 source through.
test('two in-flight hub-tier tasks fill every lane slot: a priority-30 source is vetoed, unlike the same tasks without a live hub', () => {
  const withoutHub = run([['probe_high', 30]], { adhocInFlight: true, hubLive: false });
  assert.ok(withoutHub.queued.includes('probe_high-task.json'));
  const { out, queued } = run([['probe_high', 30]], { adhocInFlight: true, hubLive: true });
  assert.ok(!queued.includes('probe_high-task.json'), `hub-tier work (-1000) must count against a priority-30 source:\n${out}`);
  assert.match(out, /pending\/ already has work queued, not adding another task/);
});

// 2026-10-30: production task-selection.js:128 calls source.next() with NO argument for every registered source.
// brain_dump_resolution_check.next() must tolerate this (no options parameter) -- a throw here would crash
// the entire generation walk (no try/catch around source.next() in the normal path).
test('brain_dump_resolution_check.next() accepts zero arguments without throwing', () => {
  const { next } = require('./brain-dump-resolution-check.js');
  // Set required env vars so getConfig() doesn't throw. No brain-dump file exists, so next() should return null.
  const origRepoRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  const origPipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR;
  const origBrainDumpPath = process.env.AGENT_MANAGER_BRAIN_DUMP_PATH;
  process.env.AGENT_MANAGER_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-dump-test-'));
  process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_BRAIN_DUMP_PATH = path.join(process.env.AGENT_MANAGER_REPO_ROOT, 'brain-dump.json');
  try {
    // No brain-dump file exists, so next() should return null (not throw).
    assert.equal(next(), null, 'next() with no brain-dump file must return null, not throw');
  } finally {
    // Restore env vars
    if (origRepoRoot !== undefined) process.env.AGENT_MANAGER_REPO_ROOT = origRepoRoot;
    else delete process.env.AGENT_MANAGER_REPO_ROOT;
    if (origPipelineDir !== undefined) process.env.AGENT_MANAGER_PIPELINE_DIR = origPipelineDir;
    else delete process.env.AGENT_MANAGER_PIPELINE_DIR;
    if (origBrainDumpPath !== undefined) process.env.AGENT_MANAGER_BRAIN_DUMP_PATH = origBrainDumpPath;
    else delete process.env.AGENT_MANAGER_BRAIN_DUMP_PATH;
  }
});
