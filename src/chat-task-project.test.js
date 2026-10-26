'use strict';

// The chat's task tools with a `project` argument (2026-10-25). Run: node --test src/chat-task-project.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Two projects with their own pipeline dirs; `core` is the process default.
function world(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-task-project-'));
  const mk = (name) => {
    const repo = path.join(root, name), pipe = path.join(root, name + '-pipe');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(pipe, { recursive: true });
    return { label: name, repoRoot: repo, pipelineDir: pipe };
  };
  const core = mk('core'), plugin = mk('plugin');
  const registry = path.join(root, 'projects.json');
  fs.writeFileSync(registry, JSON.stringify([core, plugin]));
  const saved = { reg: process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH, repo: process.env.AGENT_MANAGER_REPO_ROOT, pipe: process.env.AGENT_MANAGER_PIPELINE_DIR };
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = registry;
  process.env.AGENT_MANAGER_REPO_ROOT = core.repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = core.pipelineDir;
  delete require.cache[require.resolve('./local-tool-client.js')];
  const mod = require('./local-tool-client.js');
  const restore = () => {
    for (const [k, v] of [['AGENT_MANAGER_PROJECTS_REGISTRY_PATH', saved.reg], ['AGENT_MANAGER_REPO_ROOT', saved.repo], ['AGENT_MANAGER_PIPELINE_DIR', saved.pipe]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  const put = (project, state, id, data) => {
    const dir = path.join(project.pipelineDir, 'queue', state);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, ...data }));
  };
  const exists = (project, state, id) => fs.existsSync(path.join(project.pipelineDir, 'queue', state, `${id}.json`));
  return Promise.resolve(fn({ mod, core, plugin, put, exists })).finally(restore);
}

test('read_task with project reads from that project\'s queue; omitted reads the default; unknown is a clean error', () => world(({ mod, core, plugin, put }) => {
  put(plugin, 'blocked', 'p-1', { title: 'plugin task' });
  put(core, 'blocked', 'c-1', { title: 'core task' });
  const h = mod.buildChatToolHandlers([core.repoRoot], core.pipelineDir, core.repoRoot);
  const base = mod.buildToolHandlers([core.repoRoot], core.pipelineDir);
  assert.equal(base.read_task({ taskId: 'p-1', project: 'plugin' }).title, 'plugin task');
  assert.equal(base.read_task({ taskId: 'c-1' }).title, 'core task');
  assert.ok(base.read_task({ taskId: 'p-1' }).error, 'the plugin task is not in the default queue');
  assert.match(base.read_task({ taskId: 'x', project: 'nope' }).error, /unknown project "nope" -- valid projects: core, plugin/);
  assert.equal(typeof h.list_projects, 'function');
}));

test('search_tasks with project searches that queue, "all" merges every project and tags each hit, and the total is capped', () => world(({ mod, core, plugin, put }) => {
  put(plugin, 'blocked', 'p-needle', { title: 'needle in plugin' });
  put(core, 'blocked', 'c-needle', { title: 'needle in core' });
  const base = mod.buildToolHandlers([core.repoRoot], core.pipelineDir);
  assert.deepEqual(base.search_tasks({ query: 'needle', project: 'plugin' }).results.map((r) => r.id), ['p-needle']);
  assert.deepEqual(base.search_tasks({ query: 'needle' }).results.map((r) => r.id), ['c-needle']);
  const all = base.search_tasks({ query: 'needle', project: 'ALL' }).results;
  assert.deepEqual(all.map((r) => [r.id, r.project]).sort(), [['c-needle', 'core'], ['p-needle', 'plugin']]);
  for (let i = 0; i < 20; i++) put(plugin, 'blocked', `many-${i}`, { title: `many ${i}` });
  for (let i = 0; i < 20; i++) put(core, 'blocked', `many-c-${i}`, { title: `many ${i}` });
  assert.equal(base.search_tasks({ query: 'many', project: 'all' }).results.length, require('./local-tool-task-tools.js').MAX_SEARCH_TASK_RESULTS);
}));

test('the four unstick tools act on the named project\'s queue only', () => world(async ({ mod, core, plugin, put, exists }) => {
  put(plugin, 'needs-clarification', 'a-1', { needsClarification: { reason: 'design-decision' }, promptContext: { rawText: 'ask' } });
  put(plugin, 'needs-clarification', 'r-1', { needsClarification: { reason: 'ambiguous' } });
  put(plugin, 'needs-clarification', 'd-1', {});
  put(plugin, 'blocked', 'b-1', { domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x', blockedReason: 'nope' });
  const h = mod.buildChatToolHandlers([core.repoRoot], core.pipelineDir, core.repoRoot);
  assert.equal((await h.answer_task_clarification({ taskId: 'a-1', answer: 'B', project: 'plugin' })).ok, true);
  assert.equal(exists(plugin, 'adhoc', 'a-1'), true);
  assert.equal((await h.resolve_task_clarification({ taskId: 'r-1', paths: ['x.js'], project: 'plugin' })).ok, true);
  assert.equal(exists(plugin, 'adhoc', 'r-1'), true);
  assert.equal((await h.mark_task_clarification_done({ taskId: 'd-1', project: 'plugin' })).ok, true);
  assert.equal(exists(plugin, 'done', 'd-1'), true);
  assert.equal((await h.requeue_blocked_task({ taskId: 'b-1', state: 'blocked', project: 'plugin' })).ok, true);
  assert.equal(exists(plugin, 'pending', 'b-1'), true);
  for (const state of ['adhoc', 'done', 'pending']) assert.equal(fs.existsSync(path.join(core.pipelineDir, 'queue', state)), false, `nothing was created in the default ${state} queue`);
}));

test('the unstick tools without project still use the default queue, and an unknown project is { ok: false, error }', () => world(async ({ mod, core, put, exists }) => {
  put(core, 'needs-clarification', 'c-9', { needsClarification: { reason: 'design-decision' }, promptContext: { rawText: 'ask' } });
  const h = mod.buildChatToolHandlers([core.repoRoot], core.pipelineDir, core.repoRoot);
  assert.equal((await h.answer_task_clarification({ taskId: 'c-9', answer: 'A' })).ok, true);
  assert.equal(exists(core, 'adhoc', 'c-9'), true);
  const bad = await h.requeue_blocked_task({ taskId: 'x', state: 'blocked', project: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown project "nope"/);
}));

test('every task tool definition offers the project argument', () => world(({ mod }) => {
  const named = (list) => Object.fromEntries(list.map((t) => [t.function.name, t.function.parameters.properties]));
  const chat = named(mod.CHAT_TOOLS), base = named(mod.TOOLS);
  for (const n of ['answer_task_clarification', 'resolve_task_clarification', 'mark_task_clarification_done', 'requeue_blocked_task', 'queue_reviewed_task', 'withdraw_task']) {
    assert.ok(chat[n].project, `${n} has a project argument`);
  }
  assert.ok(base.read_task.project && base.search_tasks.project);
  assert.match(base.search_tasks.project.description, /"all"/);
}));

test('withdraw_task honours the project argument and refuses an unknown project without moving anything', () => world(async ({ mod, core, plugin, put, exists }) => {
  put(plugin, 'pending', 'wp-1', { title: 'in the plugin queue' });
  put(core, 'pending', 'wp-1', { title: 'same id in the default queue' });
  const h = mod.buildChatToolHandlers([core.repoRoot], core.pipelineDir, core.repoRoot);
  const bad = await h.withdraw_task({ taskId: 'wp-1', reason: 'r', project: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown project "nope"/);
  assert.equal(exists(plugin, 'pending', 'wp-1'), true);
  assert.equal(exists(core, 'pending', 'wp-1'), true);
  assert.equal((await h.withdraw_task({ taskId: 'wp-1', reason: 'wrong queue', project: 'plugin' })).ok, true);
  assert.equal(exists(plugin, 'pending', 'wp-1'), false);
  assert.equal(exists(plugin, 'done/_archived_no_action', 'wp-1'), true);
  assert.equal(exists(core, 'pending', 'wp-1'), true, 'the default queue copy is untouched');
}));
