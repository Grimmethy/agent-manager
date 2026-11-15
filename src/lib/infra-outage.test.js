'use strict';

// Tests for src/lib/infra-outage.js. Pure helpers only: no network, no model host, no real HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyError, backoffDelayMs, formatGiveUpText } = require('./infra-outage.js');

let savedHome;
let tmpHome;

test.before(() => {
  savedHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-outage-'));
  process.env.HOME = tmpHome;
});

test.after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

test('backoff delays grow, are bounded by the cap, and never decrease', () => {
  const opts = { baseMs: 1000, capMs: 30000 };
  const delays = [];
  for (let a = 1; a <= 10; a += 1) delays.push(backoffDelayMs(a, opts));
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] >= delays[i - 1], `attempt ${i + 1} (${delays[i]}) below attempt ${i} (${delays[i - 1]})`);
    if (delays[i - 1] < opts.capMs) {
      assert.ok(delays[i] > delays[i - 1], `attempt ${i + 1} not strictly above attempt ${i} below the cap`);
    }
  }
  for (const d of delays) assert.ok(d <= opts.capMs, `delay ${d} above cap`);
  assert.equal(backoffDelayMs(1, opts), 1000);
  assert.equal(backoffDelayMs(0, opts), 1000);
  assert.equal(backoffDelayMs(Number.NaN, opts), 1000);
});

test('give-up text is never empty', () => {
  const cases = [undefined, null, {}, { code: 'ENOTFOUND' }, { status: 404, message: 'not found' }];
  for (const c of cases) {
    const text = formatGiveUpText(c);
    assert.equal(typeof text, 'string');
    assert.ok(text.trim().length > 0, `empty text for ${JSON.stringify(c)}`);
  }
  assert.ok(formatGiveUpText().trim().length > 0);
});

test('give-up text falls back to a class note when no detail was captured', () => {
  assert.match(formatGiveUpText({ code: 'ENOTFOUND' }), /no error detail captured/);
  assert.match(formatGiveUpText(undefined, 'infra'), /no error detail captured \(class=infra\)/);
});

test('give-up text includes the status and message when present', () => {
  const text = formatGiveUpText({ status: 404, message: 'not found' });
  assert.ok(text.includes('404') || text.includes('not found'), text);
});

test('content errors classify as content', () => {
  assert.equal(classifyError({ status: 404 }), 'content');
  assert.equal(classifyError(new Error('bad json in reply')), 'content');
  assert.equal(classifyError(null), 'content');
  assert.equal(classifyError(undefined), 'content');
});

test('5xx, transport codes, and timeouts classify as infra', () => {
  assert.equal(classifyError({ status: 500 }), 'infra');
  assert.equal(classifyError({ statusCode: 503 }), 'infra');
  assert.equal(classifyError({ code: 'ECONNREFUSED' }), 'infra');
  assert.equal(classifyError({ code: 'ECONNRESET' }), 'infra');
  assert.equal(classifyError(new Error('request timeout')), 'infra');
});
