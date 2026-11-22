'use strict';

// src/chat-projects.js: the project registry as the dashboard chat sees it. Run: node --test src/chat-projects.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listProjects, resolveProject, projectForText } = require('./chat-projects.js');

function fixture(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-projects-'));
  const registryPath = path.join(dir, 'projects.json');
  fs.writeFileSync(registryPath, JSON.stringify(entries));
  return { dir, registryPath };
}
const mk = (dir, name) => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true }); return p; };

test('listProjects: skips entries without a repoRoot, fills defaults, flags pool and the active project', () => {
  const { dir, registryPath } = fixture([]);
  const a = mk(dir, 'alpha'), b = mk(dir, 'beta');
  fs.writeFileSync(registryPath, JSON.stringify([
    { label: 'alpha', repoRoot: a, pipelineDir: path.join(dir, 'alpha-pipe'), domainsPath: '/x/d.json', pool: true },
    { label: 'beta', repoRoot: b },
    { label: 'broken' }, null, 'junk',
  ]));
  const list = listProjects({ registryPath, activeRepoRoot: b });
  assert.deepEqual(list.map((p) => p.label), ['alpha', 'beta']);
  assert.deepEqual(list[0], { label: 'alpha', repoRoot: a, pipelineDir: path.join(dir, 'alpha-pipe'), domainsPath: '/x/d.json', pool: true, active: false });
  assert.equal(list[1].pipelineDir, b);
  assert.equal(list[1].domainsPath, path.join(b, 'task-domains.json'));
  assert.equal(list[1].pool, false);
  assert.equal(list[1].active, true);
});

test('listProjects: one entry per real repo even when the registry lists it under two path aliases; a missing or bad registry gives []', () => {
  const { dir, registryPath } = fixture([]);
  const a = mk(dir, 'alpha');
  const alias = path.join(dir, 'alias');
  fs.symlinkSync(a, alias);
  fs.writeFileSync(registryPath, JSON.stringify([{ label: 'alpha', repoRoot: a }, { label: 'alpha', repoRoot: alias }]));
  assert.equal(listProjects({ registryPath, activeRepoRoot: a }).length, 1);
  assert.deepEqual(listProjects({ registryPath: path.join(dir, 'nope.json') }), []);
  fs.writeFileSync(registryPath, '{not json');
  assert.deepEqual(listProjects({ registryPath }), []);
});

test('resolveProject: by label (any case) or repo root; unknown names list the valid labels', () => {
  const { dir, registryPath } = fixture([]);
  const a = mk(dir, 'alpha'), b = mk(dir, 'beta');
  fs.writeFileSync(registryPath, JSON.stringify([{ label: 'Alpha', repoRoot: a }, { label: 'beta', repoRoot: b }]));
  const list = listProjects({ registryPath, activeRepoRoot: a });
  assert.equal(resolveProject('alpha', list).project.label, 'Alpha');
  assert.equal(resolveProject(' BETA ', list).project.label, 'beta');
  assert.equal(resolveProject(b, list).project.label, 'beta');
  assert.deepEqual(resolveProject('gamma', list), { error: 'unknown project "gamma" -- valid projects: Alpha, beta' });
  assert.match(resolveProject(undefined, list).error, /unknown project ""/);
  assert.match(resolveProject('x', []).error, /\(none registered\)/);
});

test('projectForText: the single project that owns every absolute path in the text', () => {
  const { dir, registryPath } = fixture([]);
  const a = mk(dir, 'foo'), b = mk(dir, 'foobar'), nested = mk(a, 'sub');
  fs.writeFileSync(registryPath, JSON.stringify([{ label: 'foo', repoRoot: a }, { label: 'foobar', repoRoot: b }, { label: 'sub', repoRoot: nested }]));
  const list = listProjects({ registryPath, activeRepoRoot: a });
  assert.equal(projectForText(`edit ${a}/x.py and ${a}/y/z.py`, list).label, 'foo');
  assert.equal(projectForText(`edit ${b}/x.py`, list).label, 'foobar', 'foo is not a prefix match for foobar');
  assert.equal(projectForText(`see ${nested}/m.py`, list).label, 'sub', 'the longest repoRoot wins');
});

test('projectForText: null for no paths, unregistered paths, or paths from more than one project', () => {
  const { dir, registryPath } = fixture([]);
  const a = mk(dir, 'foo'), b = mk(dir, 'bar');
  fs.writeFileSync(registryPath, JSON.stringify([{ label: 'foo', repoRoot: a }, { label: 'bar', repoRoot: b }]));
  const list = listProjects({ registryPath, activeRepoRoot: a });
  assert.equal(projectForText('no paths here', list), null);
  assert.equal(projectForText('look at /tmp/somewhere/else.txt', list), null);
  assert.equal(projectForText(`${a}/x and ${b}/y`, list), null);
  assert.equal(projectForText(undefined, list), null);
  assert.equal(projectForText(`${a}/x`, []), null);
});
