'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const modPath = path.join(__dirname, '..', 'src', 'provider-limit.js');
const { parseProviderLimit, isLegacyPlanLimitBlock, extractLegacyResetsAt } = require(modPath);

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-limit-'));
const savedHome = process.env.HOME;
process.env.HOME = tmpHome;
test.after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const ISO = '2027-01-15T12:00:00.000Z';
const ISO_MS = Date.parse(ISO);
const legacy = (extra) => `draft call failed 3 times in a row: ${extra || ''} five-hour limit reached`;

test('exports exactly the three functions', () => {
  assert.deepStrictEqual(Object.keys(require(modPath)).sort(), ['extractLegacyResetsAt', 'isLegacyPlanLimitBlock', 'parseProviderLimit']);
});

test('plan-limit 429 with ISO resetsAt', () => {
  const r = parseProviderLimit(`ollama http 429: ${JSON.stringify({ error: 'plan-limit', resetsAt: ISO })}`);
  assert.deepStrictEqual(r, { resetsAt: ISO_MS, resetsAtIso: ISO });
});

test('status field plus body object works', () => {
  const r = parseProviderLimit({ status: 429, body: { error: 'plan-limit', resetsAt: ISO_MS } });
  assert.strictEqual(r.resetsAt, ISO_MS);
});

test('other 429 error with valid resetsAt is accepted; epoch seconds normalised', () => {
  assert.ok(parseProviderLimit(`ollama http 429: ${JSON.stringify({ error: 'x', resetsAt: ISO })}`));
  const r = parseProviderLimit(`ollama http 429: ${JSON.stringify({ resetsAt: ISO_MS / 1000 })}`);
  assert.strictEqual(r.resetsAt, ISO_MS);
});

test('accepts retryAfter as fallback: relative seconds from now', () => {
  const r = parseProviderLimit('ollama http 429: {"retryAfter": 3600}', { now: NOW });
  assert.strictEqual(r.resetsAt, NOW + 3_600_000);
  assert.ok(r.resetsAt > NOW);
  assert.strictEqual(r.resetsAtIso, new Date(NOW + 3_600_000).toISOString());
  assert.strictEqual(parseProviderLimit('ollama http 429: {"retry-after": "60"}', { now: NOW }).resetsAt, NOW + 60_000);
  assert.strictEqual(parseProviderLimit('ollama http 429: {"retryAfter": 0}', { now: NOW }).resetsAt, NOW);
});

test('resetsAt wins over retryAfter; invalid resetsAt does not fall through', () => {
  const both = parseProviderLimit(`ollama http 429: ${JSON.stringify({ resetsAt: ISO, retryAfter: 5 })}`, { now: NOW });
  assert.strictEqual(both.resetsAt, ISO_MS);
  assert.strictEqual(parseProviderLimit('ollama http 429: {"resetsAt":"garbage","retryAfter":5}', { now: NOW }), null);
});

test('invalid retryAfter / missing reset returns null', () => {
  for (const body of ['{"retryAfter": -1}', '{"retryAfter": "soon"}', '{"retryAfter": null}', '{"error":"plan-limit"}', '{"resetsAt": -5}', '{"resetsAt": ""}']) {
    assert.strictEqual(parseProviderLimit(`ollama http 429: ${body}`, { now: NOW }), null, body);
  }
});

test('non-429 and malformed inputs return null without throwing', () => {
  const circular = {}; circular.self = circular;
  const inputs = [
    `ollama http 500: ${JSON.stringify({ resetsAt: ISO })}`, { status: 500, body: { resetsAt: ISO } },
    'ollama http 429: {bad json', 'ollama http 429: {"resetsAt":', 'ollama http 429:', 'ollama http 429: [1,2]',
    '', null, undefined, 42, [], {}, circular, { status: 429, body: 'str' },
  ];
  for (const i of inputs) assert.strictEqual(parseProviderLimit(i, { now: NOW }), null);
});

test('isLegacyPlanLimitBlock', () => {
  assert.strictEqual(isLegacyPlanLimitBlock(legacy()), true);
  assert.strictEqual(isLegacyPlanLimitBlock('draft call failed 3 times in a row: timeout'), false);
  assert.strictEqual(isLegacyPlanLimitBlock('five hour limit reached'), false);
  for (const v of [null, undefined, 5, {}, '']) assert.strictEqual(isLegacyPlanLimitBlock(v), false);
});

test('extractLegacyResetsAt: ISO, UTC clock time, rollover, null', () => {
  assert.strictEqual(extractLegacyResetsAt(legacy(`resets ${ISO}`), { now: NOW }), ISO_MS);
  const now = Date.UTC(2027, 0, 15, 10, 0);
  assert.strictEqual(extractLegacyResetsAt(legacy('resets at 15:30 UTC'), { now }), Date.UTC(2027, 0, 15, 15, 30));
  assert.strictEqual(extractLegacyResetsAt(legacy('resets at 3pm UTC'), { now }), Date.UTC(2027, 0, 15, 15, 0));
  assert.strictEqual(extractLegacyResetsAt(legacy('resets at 08:00 UTC'), { now }), Date.UTC(2027, 0, 16, 8, 0));
  assert.strictEqual(extractLegacyResetsAt(legacy('no time here'), { now }), null);
  assert.strictEqual(extractLegacyResetsAt('resets 15:30 UTC', { now }), null);
  assert.strictEqual(extractLegacyResetsAt(null), null);
});

test('legacy UTC fallback is identical under different TZ values', () => {
  const now = Date.UTC(2027, 0, 15, 23, 30);
  const script = `const m=require(${JSON.stringify(modPath)});` +
    `process.stdout.write(String(m.extractLegacyResetsAt('draft call failed 3 times in a row: resets at 01:00 UTC five-hour limit reached',{now:${now}})))`;
  const outs = ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles'].map((TZ) =>
    execFileSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH, HOME: tmpHome, TZ }, encoding: 'utf8' }));
  assert.deepStrictEqual(outs, [String(Date.UTC(2027, 0, 16, 1, 0))].concat(Array(2).fill(String(Date.UTC(2027, 0, 16, 1, 0)))));
});
