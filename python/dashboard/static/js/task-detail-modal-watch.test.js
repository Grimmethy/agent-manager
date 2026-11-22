'use strict';
// Run: node --test python/dashboard/static/js/task-detail-modal-watch.test.js
// The open task-detail modal WATCHES a live task instead of polling it (refreshTaskDetailModal is called by the page on pipeline events).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'task-detail-modal.js'), 'utf8');
function slice(from, to) { return src.slice(src.indexOf(from), src.indexOf(to)); }
const code = slice('function stopTaskDetailAutoRefresh()', 'function renderDesignDecisionPicker(task)');

function load(over = {}) {
  const calls = { fetch: [], render: [] };
  const backdrop = { classList: { contains: (c) => c === 'open' && over.open !== false } };
  const ctx = {
    taskDetailWatch: null,
    TASK_DETAIL_LIVE_STATES: new Set(['drafting', 'review', 'coordinating']),
    document: { getElementById: (id) => (id === 'modal-backdrop' ? (over.open === 'missing' ? null : backdrop) : null) },
    fetchJson: async (url) => { calls.fetch.push(url); if (over.fail) throw new Error('down'); return over.fresh || { id: 't1', _foundState: 'drafting', history: [1] }; },
    renderTaskDetailModal: (t) => { calls.render.push(t); if (over.rerender) over.rerender(ctx, t); },
    encodeURIComponent,
  };
  require('node:vm').createContext(ctx);
  require('node:vm').runInContext(code + '\nthis.arm = armTaskDetailAutoRefresh; this.stop = stopTaskDetailAutoRefresh; this.refresh = refreshTaskDetailModal;', ctx);
  return { ctx, calls };
}

test('arming a live task starts a watch with its state and history length, and starts no timer', () => {
  const { ctx } = load();
  ctx.arm({ id: 't1', _foundState: 'drafting', history: [1, 2, 3] });
  assert.deepEqual({ ...ctx.taskDetailWatch }, { id: 't1', sig: 'drafting:3' });
  assert.doesNotMatch(src, /setInterval|taskDetailPoll/);
});

test('a task in a terminal state is not watched, and arming again replaces the watch', () => {
  const { ctx } = load();
  ctx.arm({ id: 't1', _foundState: 'done', history: [] });
  assert.equal(ctx.taskDetailWatch, null);
  ctx.arm({ id: 't1', _foundState: 'review', history: [] });
  ctx.arm({ id: 't2', _foundState: 'coordinating', history: [1] });
  assert.equal(ctx.taskDetailWatch.id, 't2');
  ctx.stop();
  assert.equal(ctx.taskDetailWatch, null);
});

test('refresh does nothing and fetches nothing without a watch', async () => {
  const { ctx, calls } = load();
  await ctx.refresh();
  assert.deepEqual(calls.fetch, []);
  assert.deepEqual(calls.render, []);
});

test('refresh re-reads the watched task and re-renders only when its state or history length moved', async () => {
  const { ctx, calls } = load({ fresh: { id: 't1', _foundState: 'drafting', history: [1, 2] } });
  ctx.arm({ id: 't1', _foundState: 'drafting', history: [1, 2] });
  await ctx.refresh();
  assert.deepEqual(calls.fetch, ['/api/task-anywhere/t1']);
  assert.deepEqual(calls.render, []);                                       // same state, same length: nothing to draw
  const more = load({ fresh: { id: 't1', _foundState: 'drafting', history: [1, 2, 3] } });
  more.ctx.arm({ id: 't1', _foundState: 'drafting', history: [1, 2] });
  await more.ctx.refresh();
  assert.equal(more.calls.render.length, 1);
  const moved = load({ fresh: { id: 't1', _foundState: 'review', history: [1, 2] } });
  moved.ctx.arm({ id: 't1', _foundState: 'drafting', history: [1, 2] });
  await moved.ctx.refresh();
  assert.equal(moved.calls.render.length, 1);
});

test('a closed or missing modal stops the watch without a fetch', async () => {
  for (const open of [false, 'missing']) {
    const { ctx, calls } = load({ open });
    ctx.arm({ id: 't1', _foundState: 'drafting', history: [] });
    await ctx.refresh();
    assert.equal(ctx.taskDetailWatch, null, String(open));
    assert.deepEqual(calls.fetch, [], String(open));
  }
});

test('a failed fetch keeps the watch and renders nothing', async () => {
  const { ctx, calls } = load({ fail: true });
  ctx.arm({ id: 't1', _foundState: 'drafting', history: [] });
  await ctx.refresh();
  assert.notEqual(ctx.taskDetailWatch, null);
  assert.deepEqual(calls.render, []);
});

test('a modal that moved to another task or closed while the fetch was in flight is not overwritten', async () => {
  const { ctx, calls } = load({ fresh: { id: 't1', _foundState: 'drafting', history: [1, 2, 3] } });
  ctx.arm({ id: 't1', _foundState: 'drafting', history: [1] });
  const p = ctx.refresh();
  ctx.stop();                                                               // closeDetail() ran before the fetch came back
  await p;
  assert.deepEqual(calls.render, []);
});
