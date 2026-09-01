'use strict';

// Unit tests for src/work-log.js -- the per-task tool transcript sidecar that makes an
// agentic draft's work auditable before its output is approved/merged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AGENT_MANAGER_REPO_ROOT = path.join(os.tmpdir(), 'work-log-test');
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;

const { appendTierWorkLog, readWorkLog, pruneWorkLogs, worklogPath } = require('./work-log.js');

const PIPELINE_DIR = process.env.AGENT_MANAGER_PIPELINE_DIR;

test.beforeEach(() => {
  fs.rmSync(PIPELINE_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(PIPELINE_DIR, 'queue'), { recursive: true });
});
test.after(() => fs.rmSync(PIPELINE_DIR, { recursive: true, force: true }));

const log = [
  { tool: 'grep_codebase', args: { query: 'renderTaskDetailModal', dir: 'python' }, result: { matches: 3 } },
  { tool: 'read_file', args: { path: 'python/dashboard/templates/index.html' }, result: 'x'.repeat(9000) },
  { tool: 'run_bash', args: { cmd: 'npm test' }, result: { error: 'exit 1' } },
];

test('appendTierWorkLog writes a per-tier transcript keeping arg VALUES (not just keys)', () => {
  appendTierWorkLog({ id: 'wl-1' }, { tier: 'local-agentic', turnsUsed: 8, toolCallLog: log }, PIPELINE_DIR);

  const doc = readWorkLog('wl-1', PIPELINE_DIR);
  assert.equal(doc.taskId, 'wl-1');
  assert.equal(doc.tiers.length, 1);
  const t = doc.tiers[0];
  assert.equal(t.tier, 'local-agentic');
  assert.equal(t.turnsUsed, 8);
  assert.equal(t.calls.length, 3);
  assert.equal(t.calls[0].args.query, 'renderTaskDetailModal', 'the actual grep query is kept, not just the key');
  assert.equal(t.calls[2].tool, 'run_bash');
  assert.equal(t.calls[2].args.cmd, 'npm test');
  assert.equal(t.calls[2].error, true);
});

test('appendTierWorkLog caps a large result into a bounded preview', () => {
  appendTierWorkLog({ id: 'wl-2' }, { tier: 'local-agentic-write', toolCallLog: log }, PIPELINE_DIR);
  const c = readWorkLog('wl-2', PIPELINE_DIR).tiers[0].calls[1];
  assert.ok(c.resultBytes >= 9000, 'the true size is still recorded');
  assert.ok(c.resultPreview.length < 3000, 'the preview is capped');
  assert.match(c.resultPreview, /more chars/);
});

test('appendTierWorkLog appends a second tier to the same file', () => {
  appendTierWorkLog({ id: 'wl-3' }, { tier: 'local-agentic', toolCallLog: log }, PIPELINE_DIR);
  appendTierWorkLog({ id: 'wl-3' }, { tier: 'local-agentic-write', toolCallLog: log }, PIPELINE_DIR);
  const doc = readWorkLog('wl-3', PIPELINE_DIR);
  assert.deepEqual(doc.tiers.map((t) => t.tier), ['local-agentic', 'local-agentic-write']);
});

test('appendTierWorkLog stores the tier final message when given', () => {
  appendTierWorkLog({ id: 'wl-fm' }, { tier: 'local-agentic-write', turnsUsed: 12, toolCallLog: log, finalMessage: 'RESOLUTION: implemented\nadded the route' }, PIPELINE_DIR);
  const doc = readWorkLog('wl-fm', PIPELINE_DIR);
  assert.match(doc.tiers[0].finalMessage, /RESOLUTION: implemented/);
});

test('a requeued adhoc task keeps its worklog (queue/adhoc/ counts as live)', () => {
  appendTierWorkLog({ id: 'adhoc-x' }, { tier: 'local-agentic-write', toolCallLog: log }, PIPELINE_DIR);
  fs.mkdirSync(path.join(PIPELINE_DIR, 'queue', 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(PIPELINE_DIR, 'queue', 'adhoc', 'adhoc-x.json'), '{}');
  const { pruned } = pruneWorkLogs(PIPELINE_DIR);
  assert.equal(pruned, 0);
  assert.ok(readWorkLog('adhoc-x', PIPELINE_DIR));
});

test('appendTierWorkLog is a no-op for an empty / missing tool log and never throws', () => {
  appendTierWorkLog({ id: 'wl-4' }, { tier: 'x', toolCallLog: [] }, PIPELINE_DIR);
  appendTierWorkLog({ id: 'wl-4' }, { tier: 'x' }, PIPELINE_DIR);
  appendTierWorkLog(null, { tier: 'x', toolCallLog: log }, PIPELINE_DIR);
  assert.equal(readWorkLog('wl-4', PIPELINE_DIR), null);
  assert.equal(fs.existsSync(worklogPath('wl-4', PIPELINE_DIR)), false);
});

test('pruneWorkLogs keeps logs for live + done/ tasks, deletes gone + archived ones', () => {
  for (const id of ['live-pending', 'live-approved', 'gone', 'done-task', 'archived-task', 'no-action-task']) {
    appendTierWorkLog({ id }, { tier: 't', toolCallLog: log }, PIPELINE_DIR);
  }
  fs.mkdirSync(path.join(PIPELINE_DIR, 'queue', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(PIPELINE_DIR, 'queue', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(PIPELINE_DIR, 'queue', 'done', '_archived', '2026-09'), { recursive: true });
  fs.mkdirSync(path.join(PIPELINE_DIR, 'queue', 'done', '_archived_no_action'), { recursive: true });
  fs.writeFileSync(path.join(PIPELINE_DIR, 'queue', 'pending', 'live-pending.json'), '{}');
  fs.writeFileSync(path.join(PIPELINE_DIR, 'queue', 'approved', 'live-approved.json'), '{}');
  fs.writeFileSync(path.join(PIPELINE_DIR, 'queue', 'done', 'done-task.json'), '{}');
  fs.writeFileSync(path.join(PIPELINE_DIR, 'queue', 'done', '_archived', '2026-09', 'archived-task.json'), '{}');
  fs.writeFileSync(path.join(PIPELINE_DIR, 'queue', 'done', '_archived_no_action', 'no-action-task.json'), '{}');

  const { pruned } = pruneWorkLogs(PIPELINE_DIR);

  assert.equal(pruned, 3, 'gone, archived-task (rotated to _archived/<month>/), and no-action-task are pruned');
  assert.ok(readWorkLog('live-pending', PIPELINE_DIR));
  assert.ok(readWorkLog('live-approved', PIPELINE_DIR));
  assert.ok(readWorkLog('done-task', PIPELINE_DIR), 'a task still in queue/done/ top-level keeps its worklog');
  assert.equal(readWorkLog('gone', PIPELINE_DIR), null);
  assert.equal(readWorkLog('archived-task', PIPELINE_DIR), null);
  assert.equal(readWorkLog('no-action-task', PIPELINE_DIR), null);
});
