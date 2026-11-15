'use strict';
// A dependsOn edge on a script-handled ('recorded') task is released, like noop. Run: node --test src/script-handler-dependency.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'script-handler-dep-'));
process.env.AGENT_MANAGER_REPO_ROOT = tmp;
process.env.AGENT_MANAGER_PIPELINE_DIR = tmp;
process.env.AGENT_MANAGER_DOMAINS_PATH = path.join(tmp, 'task-domains.json');
fs.writeFileSync(process.env.AGENT_MANAGER_DOMAINS_PATH, '{}');
const { isDependencySatisfied } = require('./task-sources.js');

function done(id, rec) {
  fs.mkdirSync(path.join(tmp, 'queue', 'done'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'queue', 'done', `${id}.json`), JSON.stringify({ id, ...rec }));
}

test("a done task with terminalDisposition 'recorded' releases a dependsOn edge", () => {
  done('dep-recorded', { terminalDisposition: 'recorded' });
  assert.equal(isDependencySatisfied(tmp, 'dep-recorded'), true);
});

test('a done task with no disposition and no merge does not (control: the release is the disposition, not the file being in done/)', () => {
  done('dep-plain', {});
  assert.equal(isDependencySatisfied(tmp, 'dep-plain'), false);
});
