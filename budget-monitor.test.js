'use strict';

// Unit tests for budget-monitor.js's estimate logic (Brain Dump #89, 2026-08-18): a real
// "(used/total ##%)" figure needs a real total, and Claude Code under a subscription
// never exposes one -- estimateBudgetCeiling()/estimateTimeToCap() instead learn an
// account-specific ceiling from real past rate-limit hits (every hit is a genuine data
// point: "this many tokens WAS enough to hit the cap"), never inventing a number. These
// tests exercise that logic directly against synthetic entry arrays -- no real transcript
// files or PROJECTS_DIR needed, same isolation reasoning as the rest of this module's
// (thin) surface already gets from its exported pure functions.
//
// Run: node --test budget-monitor.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { estimateBudgetCeiling, estimateTimeToCap, currentWindowStartMs, parseResetTime } = require('./budget-monitor.js');

function usageEntry(ts, tokens) {
  return { _ts: ts, type: 'assistant', message: { usage: { input_tokens: tokens, output_tokens: 0 } } };
}

function rateLimitEntry(ts) {
  return { _ts: ts, error: 'rate_limit', message: { content: [{ text: 'hit' }] } };
}

const HOUR = 60 * 60 * 1000;

test('estimateBudgetCeiling returns null/0 samples when no rate-limit hits are present', () => {
  const entries = [usageEntry(1000, 500), usageEntry(2000, 500)];
  const result = estimateBudgetCeiling(entries);
  assert.deepEqual(result, { ceilingTokens: null, sampleCount: 0, samples: [] });
});

test('estimateBudgetCeiling sums usage strictly within the 5h window ending at a hit, excluding tokens outside it', () => {
  const hitTs = 10 * HOUR;
  const entries = [
    usageEntry(hitTs - 6 * HOUR, 999), // outside the 5h window -- must not count
    usageEntry(hitTs - 4 * HOUR, 100),
    usageEntry(hitTs - 1 * HOUR, 200),
    usageEntry(hitTs + 1 * HOUR, 999), // after the hit -- must not count
    rateLimitEntry(hitTs),
  ];
  const result = estimateBudgetCeiling(entries);
  assert.equal(result.sampleCount, 1);
  assert.equal(result.ceilingTokens, 300);
});

test('estimateBudgetCeiling uses the MAX across multiple real hits, not an average -- each hit is a real upper bound actually reached', () => {
  const entries = [
    usageEntry(1 * HOUR, 100),
    rateLimitEntry(1 * HOUR + 1),
    usageEntry(10 * HOUR, 900),
    rateLimitEntry(10 * HOUR + 1),
  ];
  const result = estimateBudgetCeiling(entries);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.ceilingTokens, 900);
});

test('estimateBudgetCeiling also matches apiErrorStatus 429, the same alternate signal isBudgetHealthy() itself checks', () => {
  const entries = [usageEntry(1 * HOUR, 500), { _ts: 1 * HOUR + 1, apiErrorStatus: 429, message: {} }];
  const result = estimateBudgetCeiling(entries);
  assert.equal(result.ceilingTokens, 500);
});

test('estimateTimeToCap returns null when already at or over the estimated ceiling (no future cap to project)', () => {
  const now = 10 * HOUR;
  const entries = [usageEntry(now - 30 * 60 * 1000, 100)];
  assert.equal(estimateTimeToCap(entries, /* ceiling */ 500, /* used */ 500, now), null);
  assert.equal(estimateTimeToCap(entries, 500, 600, now), null);
});

test('estimateTimeToCap returns null when there is no usage in the last hour -- no rate to project from', () => {
  const now = 10 * HOUR;
  const entries = [usageEntry(now - 3 * HOUR, 100)]; // real usage, but outside the last hour
  assert.equal(estimateTimeToCap(entries, 1000, 100, now), null);
});

test('estimateTimeToCap projects forward using the last-hour token rate as tokens/hour', () => {
  const now = 10 * HOUR;
  // 100 tokens used in the last hour, 400 tokens remaining to the ceiling -> 4 hours out.
  const entries = [usageEntry(now - 30 * 60 * 1000, 100)];
  const result = estimateTimeToCap(entries, /* ceiling */ 1000, /* used */ 600, now);
  assert.ok(result, 'expected a projected timestamp, got null');
  const hoursOut = (new Date(result).getTime() - now) / HOUR;
  assert.ok(Math.abs(hoursOut - 4) < 0.01, `expected ~4 hours out, got ${hoursOut}`);
});

test('estimateTimeToCap ignores usage older than the last hour when computing the rate', () => {
  const now = 10 * HOUR;
  const entries = [
    usageEntry(now - 3 * HOUR, 10000), // old burst, must not inflate the rate
    usageEntry(now - 30 * 60 * 1000, 100), // only this counts
  ];
  const result = estimateTimeToCap(entries, 1000, 600, now);
  const hoursOut = (new Date(result).getTime() - now) / HOUR;
  assert.ok(Math.abs(hoursOut - 4) < 0.01, `expected ~4 hours out (old burst excluded), got ${hoursOut}`);
});

// currentWindowStartMs (Brain Dump #89 follow-up, 2026-08-18): "since last limit" must
// anchor to the REAL current-window boundary, not a generic trailing lookback -- these
// pin down all three real states a lastRateLimit record can be in.
test('currentWindowStartMs returns null when there is no rate-limit history at all', () => {
  assert.equal(currentWindowStartMs(null, Date.now()), null);
});

test('currentWindowStartMs anchors to resetsAt when the reset has already passed -- a new window began there', () => {
  const now = 10 * HOUR;
  const lastRateLimit = { at: now - 2 * HOUR, resetsAt: new Date(now - HOUR) };
  assert.equal(currentWindowStartMs(lastRateLimit, now), now - HOUR);
});

test('currentWindowStartMs anchors to the hit itself when still mid-limit (resetsAt in the future)', () => {
  const now = 10 * HOUR;
  const hitAt = now - HOUR;
  const lastRateLimit = { at: hitAt, resetsAt: new Date(now + HOUR) };
  assert.equal(currentWindowStartMs(lastRateLimit, now), hitAt);
});

test('currentWindowStartMs anchors to the hit itself when the reset time could not be parsed', () => {
  const now = 10 * HOUR;
  const hitAt = now - HOUR;
  const lastRateLimit = { at: hitAt, resetsAt: null };
  assert.equal(currentWindowStartMs(lastRateLimit, now), hitAt);
});

// End-to-end: real isBudgetHealthy() against synthetic transcript files (same technique
// used to verify this live before shipping it -- CLAUDE_PROJECTS_DIR points at a
// throwaway dir; budget-monitor.js reads PROJECTS_DIR at module-load time, so the module
// has to be freshly required AFTER the env var is set, not just once at file scope).
function withFreshBudgetMonitor(projectsDir, fn) {
  const prev = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = projectsDir;
  delete require.cache[require.resolve('./budget-monitor.js')];
  try {
    return fn(require('./budget-monitor.js'));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = prev;
    delete require.cache[require.resolve('./budget-monitor.js')];
  }
}

function writeTranscript(dir, lines) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('parseResetTime handles the bare-hour form ("resets 6pm"), not just "resets 6:10pm"', () => {
  // Confirmed live 2026-08-22: Claude's own rate-limit message doesn't always include
  // minutes ("You've hit your session limit · resets 6pm (America/Denver)") -- the
  // original regex required ":(\d{2})" and returned null on this real message, leaving
  // isBudgetHealthy() stuck unparsed (never self-clears by time alone) well past the
  // actual reset.
  const hitAt = Date.parse('2026-08-22T20:24:03.112Z');
  const resetsAt = parseResetTime("You've hit your session limit · resets 6pm (America/Denver)", hitAt);
  assert.ok(resetsAt, 'bare-hour form must parse, not return null');
  assert.equal(resetsAt.toISOString(), '2026-08-23T00:00:00.000Z'); // 6pm MDT (UTC-6) = 00:00 UTC next day
});

test('parseResetTime still handles the "H:MMam/pm" form (no regression from the bare-hour fix)', () => {
  const hitAt = Date.parse('2026-08-22T05:00:00.000Z');
  const resetsAt = parseResetTime("You've hit your session limit · resets 6:10am (America/Denver)", hitAt);
  assert.ok(resetsAt);
  assert.equal(resetsAt.toISOString(), '2026-08-22T12:10:00.000Z'); // 6:10am MDT (UTC-6) = 12:10 UTC
});

test('isBudgetHealthy: sinceLastLimit excludes usage from BEFORE the last reset, unlike a trailing-5h lookback would', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-monitor-test-'));
  try {
    const now = Date.now();
    const resetsAtWallClock = new Date(now - 30 * 60 * 1000); // reset 30 min ago
    // Build reset text budget-monitor.js's own parseResetTime() can actually parse, in
    // the SAME timezone/format its regex expects, then confirm it round-trips before
    // relying on it -- a silently-unparseable fixture would make this test meaningless.
    const tz = 'America/Denver';
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
    const resetText = `You've hit your session limit · resets ${fmt.format(resetsAtWallClock).toLowerCase().replace(' ', '')} (${tz})`;
    const hitAt = resetsAtWallClock.getTime() - 5 * 60 * 60 * 1000 - 60 * 1000; // a real hit ~5h before its own reset
    assert.ok(parseResetTime(resetText, hitAt), 'test fixture setup: resetText must be parseable by the real parseResetTime()');

    writeTranscript(dir, [
      { type: 'assistant', timestamp: new Date(hitAt - 4 * 60 * 60 * 1000).toISOString(), message: { usage: { input_tokens: 9999 } } }, // long before the hit -- must not count
      { type: 'assistant', timestamp: new Date(hitAt).toISOString(), error: 'rate_limit', message: { content: [{ text: resetText }] } },
      { type: 'assistant', timestamp: new Date(resetsAtWallClock.getTime() + 5 * 60 * 1000).toISOString(), message: { usage: { input_tokens: 123 } } }, // after the reset -- must count
    ]);

    withFreshBudgetMonitor(dir, (bm) => {
      const result = bm.isBudgetHealthy();
      assert.equal(result.sinceLastLimit.usedFallback5h, false);
      assert.equal(result.sinceLastLimit.tokens, 123);
      assert.equal(result.healthy, true); // real usage after the reset corroborates it's over
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isBudgetHealthy: falls back to a trailing-5h window and flags usedFallback5h when no rate-limit hit exists yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-monitor-test-'));
  try {
    const now = Date.now();
    writeTranscript(dir, [
      { type: 'assistant', timestamp: new Date(now - 6 * 60 * 60 * 1000).toISOString(), message: { usage: { input_tokens: 999 } } }, // older than 5h -- excluded by the fallback
      { type: 'assistant', timestamp: new Date(now - 60 * 1000).toISOString(), message: { usage: { input_tokens: 42 } } },
    ]);
    withFreshBudgetMonitor(dir, (bm) => {
      const result = bm.isBudgetHealthy();
      assert.equal(result.sinceLastLimit.usedFallback5h, true);
      assert.equal(result.sinceLastLimit.tokens, 42);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
