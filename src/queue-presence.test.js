'use strict';

// Queue presence (roadmap P2): the cluster moved out of task-sources.js, behaviour unchanged. Each state a task id can sit in is covered, plus the two
// re-export paths and the absence of a require edge from the leaf back to task-sources.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class Fx {
  static pipeline(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-presence-'));
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, 'queue', rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, 'queue', rel), text || '{}');
    }
    fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
    process.env.AGENT_MANAGER_REPO_ROOT = dir;
    process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
    return dir;
  }
}

const presence = require('./queue-presence.js');

test('an id in each live state, in a claimed lane subfolder and in legacy drafting/ is present', () => {
  Fx.pipeline({
    'pending/a.json': '', 'review/b.json': '', 'approved/c.json': '', 'blocked/d.json': '', 'done/e.json': '',
    'needs-clarification/f.json': '', 'awaiting-confirm/g.json': '', 'coordinating/h.json': '',
    'drafting/worker-1/i.json': '', 'drafting/j.json': '',
  });
  for (const id of 'abcdefghij') assert.equal(presence.taskIdExistsInQueue(id), true, id);
  assert.equal(presence.taskIdExistsInQueue('never-existed'), false);
});

test('an archived id (done/_archived_no_action and a done/_archived/<month> bucket) is present', () => {
  Fx.pipeline({ 'done/_archived_no_action/x.json': '', 'done/_archived/2026-08/y.json': '' });
  assert.equal(presence.taskIdExistsInQueue('x'), true);
  assert.equal(presence.taskIdExistsInQueue('y'), true);
});

test('a hub renamed to its HUB id keeps its former id present', () => {
  Fx.pipeline({ 'coordinating/hub.json': JSON.stringify({ formerIds: ['old-task-id'] }) });
  assert.equal(presence.taskIdExistsInQueue('old-task-id'), true);
  assert.equal(presence.taskIdHeldOnlyByFinishedTask('old-task-id'), false);
});

test('taskIdHeldOnlyByFinishedTask: only a finished record holds the id', () => {
  Fx.pipeline({ 'done/f1.json': '', 'pending/f1.json': '', 'done/f2.json': '', 'done/_archived_no_action/f3.json': '', 'blocked/f4.json': '' });
  assert.equal(presence.taskIdHeldOnlyByFinishedTask('f1'), false);
  assert.equal(presence.taskIdHeldOnlyByFinishedTask('f2'), true);
  assert.equal(presence.taskIdHeldOnlyByFinishedTask('f3'), true);
  assert.equal(presence.taskIdHeldOnlyByFinishedTask('f4'), false);
  assert.equal(presence.taskIdHeldOnlyByFinishedTask('nope'), false);
});

test('task-sources.js still exports the same taskIdExistsInQueue', () => {
  Fx.pipeline({ 'pending/z.json': '' });
  const { clearRegistry } = require('./task-source-registry.js');
  clearRegistry();
  require('./model-profile-registry.js').clearModelProfileRegistry();
  delete require.cache[require.resolve('./task-sources.js')];
  assert.equal(require('./task-sources.js').taskIdExistsInQueue('z'), true);
});

test('neither the leaf nor brain-dump-resolution-check.js requires task-sources.js any more', () => {
  const { buildGraph } = require('../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..'));
  assert.equal(graph.all['src/queue-presence.js'].includes('src/task-sources.js'), false);
  assert.equal(graph.all['src/brain-dump-resolution-check.js'].includes('src/task-sources.js'), false);
});
