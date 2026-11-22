'use strict';

// queue_reviewed_task with a `project` argument and the wrong-queue guard (2026-10-25). Run: node --test src/chat-queue-project.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { queueReviewedTaskTool } = require('./local-tool-task-tools.js');
const { listProjects } = require('./chat-projects.js');

// Two projects, each with its own repo, pipeline dir and domains file.
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-queue-project-'));
  const mkProject = (name) => {
    const repo = path.join(root, name), pipe = path.join(root, name + '-pipe');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(pipe, { recursive: true });
    fs.writeFileSync(path.join(pipe, 'task-domains.json'), JSON.stringify({ default: { workDirKind: 'repoRoot' } }));
    return { label: name, repoRoot: repo, pipelineDir: pipe };
  };
  const core = mkProject('core'), plugin = mkProject('plugin');
  const registryPath = path.join(root, 'projects.json');
  fs.writeFileSync(registryPath, JSON.stringify([core, plugin]));
  const projects = listProjects({ registryPath, activeRepoRoot: core.repoRoot });
  const defaultDomainsPath = path.join(core.pipelineDir, 'task-domains.json');
  const queued = (p) => { try { return fs.readdirSync(path.join(p.pipelineDir, 'queue', 'adhoc')); } catch { return []; } };
  return { core, plugin, projects, defaultDomainsPath, queued };
}

test('with project given, the task is queued into THAT project\'s queue and stamped with its label', () => {
  const w = world();
  const r = queueReviewedTaskTool(w.core.pipelineDir, { title: 'Fix the thing', description: `edit ${w.plugin.repoRoot}/a.py`, project: 'plugin' }, w);
  assert.ok(r.queuedTaskId, JSON.stringify(r));
  assert.equal(r.project, 'plugin');
  assert.match(r.message, /in project "plugin"/);
  assert.equal(w.queued(w.plugin).length, 1);
  assert.equal(w.queued(w.core).length, 0);
  const rec = JSON.parse(fs.readFileSync(path.join(w.plugin.pipelineDir, 'queue', 'adhoc', w.queued(w.plugin)[0]), 'utf8'));
  assert.equal(rec.project, 'plugin');
  assert.equal(rec.premiumPriority, true);
});

test('an unknown project is refused with the valid labels and nothing is queued', () => {
  const w = world();
  const r = queueReviewedTaskTool(w.core.pipelineDir, { title: 't', description: 'd', project: 'nope' }, w);
  assert.match(r.error, /unknown project "nope" -- valid projects: core, plugin/);
  assert.equal(w.queued(w.core).length + w.queued(w.plugin).length, 0);
});

test('project omitted and the text is about another project: refused, naming the right project', () => {
  const w = world();
  const r = queueReviewedTaskTool(w.core.pipelineDir, { title: 'Fix', description: `change ${w.plugin.repoRoot}/chat.py and ${w.plugin.repoRoot}/x/y.py` }, w);
  assert.match(r.error, /about the project "plugin"/);
  assert.match(r.error, /project: "plugin"/);
  assert.equal(w.queued(w.core).length + w.queued(w.plugin).length, 0);
});

test('project omitted and the text is about the default project, mentions no paths, or mixes projects: queued as before', () => {
  const w = world();
  assert.ok(queueReviewedTaskTool(w.core.pipelineDir, { title: 'a', description: `edit ${w.core.repoRoot}/f.js` }, w).queuedTaskId);
  assert.ok(queueReviewedTaskTool(w.core.pipelineDir, { title: 'b', description: 'no paths at all' }, w).queuedTaskId);
  assert.ok(queueReviewedTaskTool(w.core.pipelineDir, { title: 'c', description: `${w.core.repoRoot}/f.js and ${w.plugin.repoRoot}/g.py` }, w).queuedTaskId);
  assert.equal(w.queued(w.core).length, 3);
  assert.equal(w.queued(w.plugin).length, 0);
  const rec = JSON.parse(fs.readFileSync(path.join(w.core.pipelineDir, 'queue', 'adhoc', w.queued(w.core)[0]), 'utf8'));
  assert.equal(rec.project, undefined, 'no project stamp when the default queue was used');
});

test('the git-operation refusal still comes first, and empty title or description are still refused', () => {
  const w = world();
  assert.match(queueReviewedTaskTool(w.core.pipelineDir, { title: 'Merge it', description: 'merge branch x into master and push', project: 'plugin' }, w).error, /./);
  assert.match(queueReviewedTaskTool(w.core.pipelineDir, { title: ' ', description: 'd' }, w).error, /title/);
  assert.match(queueReviewedTaskTool(w.core.pipelineDir, { title: 't', description: '' }, w).error, /description/);
  assert.equal(w.queued(w.core).length + w.queued(w.plugin).length, 0);
});

test('the chat tool definition and handler carry the project argument', () => {
  const src = fs.readFileSync(path.join(__dirname, 'local-tool-client.js'), 'utf8');
  assert.match(src, /project: \{ type: 'string', description: 'Label or repo root of the project this task is for \(from list_projects\)/);
  assert.match(src, /queueReviewedTaskTool\(pipelineDir, \{ title: args\.title, description: args\.description, project: args\.project \}\)/);
});
