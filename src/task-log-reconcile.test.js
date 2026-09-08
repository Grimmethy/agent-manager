'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reconcile } = require('./task-log-reconcile.js');

function tmpPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlr-'));
  fs.mkdirSync(path.join(dir, 'queue', 'done', '_archived_no_action'), { recursive: true });
  return dir;
}
function writeRec(pipelineDir, sub, id, history, extra = {}) {
  const p = path.join(pipelineDir, 'queue', 'done', sub, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify({ id, history, ...extra }, null, 2));
  return p;
}
const tail = (p) => { const h = JSON.parse(fs.readFileSync(p, 'utf8')).history; return h[h.length - 1]; };

test('reconcile appends a terminal event to an applied record that lacks one, and remembers it', () => {
  const dir = tmpPipeline();
  const f = writeRec(dir, '', 't1', [{ stage: 'created' }, { stage: 'applied', detail: 'no candidates in implement response' }]);

  const s1 = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: [] });
  assert.equal(s1.resolved, 1);
  assert.equal(s1.noop, 1);
  assert.equal(tail(f).stage, 'noop');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).terminalDisposition, 'noop');

  // state file written; a second run does not re-read or re-append.
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'task-log-reconcile-state.json')));
  const s2 = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: [] });
  assert.equal(s2.scanned, 0, 'the resolved record is skipped on the next tick');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).history.filter((e) => e.stage === 'noop').length, 1);
});

test('reconcile leaves a record that already has a terminal event alone but still remembers it', () => {
  const dir = tmpPipeline();
  const f = writeRec(dir, '', 't2', [{ stage: 'applied', detail: 'x' }, { stage: 'merged', detail: 'already closed' }]);
  const s = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: [] });
  assert.equal(s.resolved, 0);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).history.length, 2);
  // remembered -> not re-scanned next tick
  assert.equal(reconcile({ pipelineDir: dir, repoRoot: undefined, argv: [] }).scanned, 0);
});

test('reconcile flags an abandoned record (applied to an agent/ branch, no git context) and reports it', () => {
  const dir = tmpPipeline();
  const f = writeRec(dir, '', 't3', [{ stage: 'applied', detail: 'agent/t3' }]);
  const s = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: ['--report'] });
  assert.equal(s.abandoned, 1);
  assert.equal(tail(f).stage, 'abandoned');
});

test('reconcile does not write anything under --dry-run (state file included)', () => {
  const dir = tmpPipeline();
  const f = writeRec(dir, '', 't4', [{ stage: 'applied', detail: 'no candidates' }]);
  reconcile({ pipelineDir: dir, repoRoot: undefined, argv: ['--dry-run'] });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).history.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'task-log-reconcile-state.json')), false);
});

test('reconcile skips a record with no applied event AND remembers it so later ticks do not re-read it', () => {
  const dir = tmpPipeline();
  const f = writeRec(dir, '', 't5', [{ stage: 'created' }, { stage: 'blocked', detail: 'exhausted' }]);
  const s = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: [] });
  assert.equal(s.resolved, 0);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).history.length, 2);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'task-log-reconcile-state.json'), 'utf8'));
  assert.ok(st.resolvedIds.includes('t5'), 'a never-applied done record is remembered too');
  assert.equal(reconcile({ pipelineDir: dir, repoRoot: undefined, argv: [] }).scanned, 0);
});

test('reconcile handles a malformed JSON record without throwing', () => {
  const dir = tmpPipeline();
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'bad.json'), '{not json');
  const s = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: [] });
  assert.equal(s.errors, 1);
});

test('reconcile: a review with reviewDisposition:"dismissed" closes as dismissed and is counted', () => {
  const dir = tmpPipeline();
  const f = writeRec(dir, '', 'obs-r', [{ stage: 'created' }, { stage: 'applied', detail: 'no candidates in implement response -- nothing to apply' }],
    { source: 'observability_review', reviewDisposition: 'dismissed' });
  const s = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: [] });
  assert.equal(s.dismissed, 1);
  assert.equal(tail(f).stage, 'dismissed');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).terminalDisposition, 'dismissed');
});

test('reconcile --reclassify: flips a historical FALSE-POSITIVE noop record to dismissed; a plain run does not', () => {
  const dir = tmpPipeline();
  const hist = [
    { stage: 'created' },
    { stage: 'applied', detail: 'no candidates in implement response -- nothing to apply' },
    { stage: 'noop', detail: 'no-op apply: no candidates in implement response -- nothing to apply' },
  ];
  const f = writeRec(dir, '', 'obs-hist', hist, {
    source: 'observability_review', terminalDisposition: 'noop',
    implementResponse: 'FALSE POSITIVE. The except binds the exception and the function returns a documented default.',
  });

  // a normal run leaves the closed noop alone
  const s0 = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: [] });
  assert.equal(s0.dismissed, 0);
  assert.equal(tail(f).stage, 'noop');

  // --reclassify re-resolves it
  const s1 = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: ['--reclassify'] });
  assert.equal(s1.dismissed, 1);
  assert.equal(tail(f).stage, 'dismissed');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).terminalDisposition, 'dismissed');

  // idempotent: a second --reclassify finds nothing to move
  const s2 = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: ['--reclassify'] });
  assert.equal(s2.dismissed, 0);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).history.filter((e) => e.stage === 'dismissed').length, 1);
});

test('reconcile --reclassify: an inconclusive noop (no FP verdict) stays noop, no duplicate event', () => {
  const dir = tmpPipeline();
  const hist = [
    { stage: 'created' },
    { stage: 'applied', detail: 'no candidates in implement response -- nothing to apply' },
    { stage: 'noop', detail: 'no-op apply' },
  ];
  const f = writeRec(dir, '', 'obs-incon', hist, {
    source: 'observability_review', terminalDisposition: 'noop',
    implementResponse: 'GENUINE issue but I could not determine a safe fix from the shown code.',
  });
  const s = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: ['--reclassify'] });
  assert.equal(s.dismissed, 0);
  assert.equal(tail(f).stage, 'noop');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).history.filter((e) => e.stage === 'noop').length, 1, 'no duplicate noop event');
});

// 2026-09-08: root-caused a false "abandoned -- branch gone, work lost" verdict on two
// genuinely still-open branches, both traced to this routine tick never fetching from
// origin before checking branch existence -- it only ever saw whatever local ref cache
// happened to already be there. Fetch is now unconditional (not gated behind
// --backfill/--fetch) so the routine path can't silently work from a stale view.
test('reconcile fetches from origin by default when repoRoot is given', () => {
  const dir = tmpPipeline();
  writeRec(dir, '', 't6', [{ stage: 'applied', detail: 'no candidates' }]);
  let calls = 0;
  reconcile({ pipelineDir: dir, repoRoot: '/fake/repo', argv: [], fetchFn: () => { calls += 1; } });
  assert.equal(calls, 1, 'fetch must run on a plain, no-flag invocation now');
});

test('reconcile --no-fetch skips the fetch (explicit opt-out for an offline/sandboxed run)', () => {
  const dir = tmpPipeline();
  writeRec(dir, '', 't7', [{ stage: 'applied', detail: 'no candidates' }]);
  let calls = 0;
  reconcile({ pipelineDir: dir, repoRoot: '/fake/repo', argv: ['--no-fetch'], fetchFn: () => { calls += 1; } });
  assert.equal(calls, 0);
});

test('reconcile does not fetch at all when repoRoot is not given', () => {
  const dir = tmpPipeline();
  writeRec(dir, '', 't8', [{ stage: 'applied', detail: 'no candidates' }]);
  let calls = 0;
  reconcile({ pipelineDir: dir, repoRoot: undefined, argv: [], fetchFn: () => { calls += 1; } });
  assert.equal(calls, 0);
});

test('reconcile --reclassify: allowReopenFrom now includes abandoned (re-confirms it with no git context, since repoRoot is undefined in this test)', () => {
  const dir = tmpPipeline();
  const f = writeRec(dir, '', 't9', [{ stage: 'applied', detail: 'agent/t9' }, { stage: 'abandoned', detail: 'x' }], { terminalDisposition: 'abandoned' });
  // A plain run leaves it alone (abandoned is not auto-reopened every tick).
  const s0 = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: [] });
  assert.equal(s0.resolved, 0);
  // --reclassify re-resolves it; with no git context available it re-confirms the same
  // verdict rather than flipping incorrectly. Same "tailUnchanged" shape as the
  // inconclusive-noop-stays-noop case above -- re-confirming the same stage counts as
  // nothing resolved, not a new abandoned event.
  const s1 = reconcile({ pipelineDir: dir, repoRoot: undefined, argv: ['--reclassify'] });
  assert.equal(s1.resolved, 0, 're-confirming the same stage is not a new resolution');
  assert.equal(tail(f).stage, 'abandoned');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).history.filter((e) => e.stage === 'abandoned').length, 1, 'no duplicate abandoned event');
});
