'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lastActivityTs, isStaleByAge, isFabricationRepeat, findStalenessCandidates,
  buildStalenessEvidenceText, buildStalenessAuditTask, DEFAULT_STALENESS_THRESHOLD_DAYS,
} = require('./staleness-audit.js');

const DAY = 24 * 60 * 60 * 1000;

function makeTask(overrides = {}) {
  return {
    id: 't1',
    title: 'test task',
    source: 'manual',
    history: [],
    ...overrides,
  };
}

test('lastActivityTs prefers the last history entry over createdAt', () => {
  const task = makeTask({
    createdAt: '2026-01-01T00:00:00.000Z',
    history: [
      { stage: 'draft-started', at: '2026-01-02T00:00:00.000Z' },
      { stage: 'blocked', at: '2026-01-05T00:00:00.000Z' },
    ],
  });
  assert.equal(lastActivityTs(task), Date.parse('2026-01-05T00:00:00.000Z'));
});

test('lastActivityTs falls back to createdAt when history is empty', () => {
  const task = makeTask({ createdAt: '2026-01-01T00:00:00.000Z', history: [] });
  assert.equal(lastActivityTs(task), Date.parse('2026-01-01T00:00:00.000Z'));
});

test('lastActivityTs returns null when neither history nor createdAt is usable', () => {
  const task = makeTask({ history: [], createdAt: undefined });
  assert.equal(lastActivityTs(task), null);
});

test('isStaleByAge is true once now is past the threshold since last activity', () => {
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const task = makeTask({ history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  assert.equal(isStaleByAge(task, now, 14 * DAY), true);
});

test('isStaleByAge is false when last activity is within the threshold', () => {
  const now = Date.parse('2026-01-05T00:00:00.000Z');
  const task = makeTask({ history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  assert.equal(isStaleByAge(task, now, 14 * DAY), false);
});

test('isStaleByAge is false (not a guess) when there is no usable timestamp at all', () => {
  const task = makeTask({ history: [], createdAt: undefined });
  assert.equal(isStaleByAge(task, Date.now(), 14 * DAY), false);
});

test('isFabricationRepeat requires ornithRejectCount>=2 AND a fabrication keyword match', () => {
  assert.equal(isFabricationRepeat(makeTask({ ornithRejectCount: 2, blockedReason: 'this draft fabricates a nonexistent file' })), true);
  assert.equal(isFabricationRepeat(makeTask({ ornithRejectCount: 1, blockedReason: 'fabricated nonsense' })), false, 'only rejected once -- not yet "repeatedly"');
  assert.equal(isFabricationRepeat(makeTask({ ornithRejectCount: 3, blockedReason: 'the draft was simply empty' })), false, 'rejected repeatedly but not for fabrication');
});

test('isFabricationRepeat also checks priorRejectionFeedback (string or array)', () => {
  assert.equal(isFabricationRepeat(makeTask({ ornithRejectCount: 2, blockedReason: 'no code', priorRejectionFeedback: 'cited an unverified claim about a config file' })), true);
  assert.equal(isFabricationRepeat(makeTask({ ornithRejectCount: 2, blockedReason: 'no code', priorRejectionFeedback: ['fine', 'this one hallucinates a whole module'] })), true);
});

test('findStalenessCandidates flags age-stale and fabrication-repeat tasks, skips neither-condition tasks', () => {
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const stale = makeTask({ id: 'stale-1', history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  const fabricator = makeTask({ id: 'fab-1', history: [{ stage: 'blocked', at: '2026-01-30T00:00:00.000Z' }], ornithRejectCount: 2, blockedReason: 'fabricated a fake module' });
  const fine = makeTask({ id: 'fine-1', history: [{ stage: 'blocked', at: '2026-01-30T00:00:00.000Z' }] });

  const candidates = findStalenessCandidates([stale, fabricator, fine], {}, now);
  const ids = candidates.map((c) => c.task.id);
  assert.ok(ids.includes('stale-1'));
  assert.ok(ids.includes('fab-1'));
  assert.ok(!ids.includes('fine-1'));
});

test('findStalenessCandidates orders the longest-neglected task first', () => {
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const older = makeTask({ id: 'older', history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  const newer = makeTask({ id: 'newer', history: [{ stage: 'blocked', at: '2026-01-10T00:00:00.000Z' }] });
  const candidates = findStalenessCandidates([newer, older], {}, now);
  assert.deepEqual(candidates.map((c) => c.task.id), ['older', 'newer']);
});

test('findStalenessCandidates skips a task within its cooldown window since last reported', () => {
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const stale = makeTask({ id: 'stale-1', history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  const coverage = { 'stale-1': { reportedAt: '2026-01-31T00:00:00.000Z' } }; // 1 day ago -- well inside the default 21-day cooldown
  assert.deepEqual(findStalenessCandidates([stale], coverage, now), []);
});

test('findStalenessCandidates re-surfaces a task once its cooldown has fully elapsed', () => {
  const now = Date.parse('2026-03-01T00:00:00.000Z');
  const stale = makeTask({ id: 'stale-1', history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  const coverage = { 'stale-1': { reportedAt: '2026-01-05T00:00:00.000Z' } }; // well past the default 21-day cooldown by 2026-03-01
  const candidates = findStalenessCandidates([stale], coverage, now);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].task.id, 'stale-1');
});

test('buildStalenessEvidenceText includes the original task id, reasons, and rawText', () => {
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const task = makeTask({
    id: 'stale-1',
    title: 'Investigate the widget bug',
    history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }],
    blockedReason: 'draft empty',
    promptContext: { rawText: 'why is the widget broken' },
  });
  const text = buildStalenessEvidenceText({ task, reasons: ['stale-age'], lastActivityTs: Date.parse('2026-01-01T00:00:00.000Z') }, now);
  assert.match(text, /stale-1/);
  assert.match(text, /stale-age/);
  assert.match(text, /why is the widget broken/);
  assert.match(text, /Last forward progress: 2026-01-01T00:00:00\.000Z \(31 day\(s\) ago\)/);
});

test('buildStalenessAuditTask produces a task on the given domain with the evidence embedded', () => {
  const task = makeTask({ id: 'stale-1', title: 'Investigate the widget bug' });
  const candidate = { task, reasons: ['stale-age'], lastActivityTs: Date.now() };
  const result = buildStalenessAuditTask(candidate, 'default');
  assert.equal(result.domain, 'default');
  assert.equal(result.source, 'staleness_audit');
  assert.match(result.title, /stale-1|Investigate the widget bug/);
  assert.equal(result.promptContext.originalTaskId, 'stale-1');
  assert.deepEqual(result.promptContext.reasons, ['stale-age']);
  assert.ok(result.promptContext.evidenceText.length > 0);
});

// Regression, 2026-08-22: caught live -- the dashboard task detail page had no way to
// show WHEN the original flagged task was actually created or last touched, since that
// information only ever lived inside evidenceText's prose (fed to the model, never
// rendered in the UI). These structured fields let the dashboard show it directly.
test('buildStalenessAuditTask exposes the original task\'s dates as structured, dashboard-renderable fields', () => {
  const lastActivityTs = Date.parse('2026-01-05T00:00:00.000Z');
  const task = makeTask({ id: 'stale-1', title: 'Investigate the widget bug', createdAt: '2025-12-01T00:00:00.000Z' });
  const candidate = { task, reasons: ['stale-age'], lastActivityTs };
  const result = buildStalenessAuditTask(candidate, 'default');
  assert.equal(result.promptContext.originalTitle, 'Investigate the widget bug');
  assert.equal(result.promptContext.originalCreatedAt, '2025-12-01T00:00:00.000Z');
  assert.equal(result.promptContext.originalLastActivityAt, '2026-01-05T00:00:00.000Z');
});

test('DEFAULT_STALENESS_THRESHOLD_DAYS is a sane positive default', () => {
  assert.ok(DEFAULT_STALENESS_THRESHOLD_DAYS >= 1);
});
