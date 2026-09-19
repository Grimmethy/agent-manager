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

function run(sources) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-priority-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const pending = mk('queue', 'pending'); mk('queue', 'drafting'); const instances = mk('instances');
  for (const lane of ['worker-a', 'worker-b']) fs.writeFileSync(path.join(instances, `${lane}.json`), JSON.stringify({ instanceId: lane, pid: process.pid }));
  // two already-queued tasks of a mid-priority source (50)
  for (const id of ['mid-1', 'mid-2']) fs.writeFileSync(path.join(pending, `${id}.json`), JSON.stringify({ id, source: 'probe_mid', domain: 'default', title: id }));
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
