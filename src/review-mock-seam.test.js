'use strict';

// Tests for src/review-mock-seam.js (HUB0321 · 3/3).
//
// Covers: detection, non-detection, Python+JS syntax, advisory format, and the
// chat-retry legitimate-mock scenario where one test calls _stream_local directly.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { analyzeMockSeams } = require('./review-mock-seam.js');

const FIXTURES_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'mock-seam');

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Flagged fixture: production changes processMessage(), test mocks it.
// ---------------------------------------------------------------------------
test('flagged fixture: detects seam when test mocks the changed production function', () => {
  const diff = loadFixture('fixture_flagged.diff');
  const { seams, advisory } = analyzeMockSeams({ diff, config: {} });

  assert.ok(seams.length > 0, 'expected at least one seam');
  const flagged = seams.find((s) => s.changedFn === 'processMessage');
  assert.ok(flagged, 'expected processMessage to be flagged');
  assert.ok(
    flagged.mockedInTests.some((t) => t.includes('test_engine')),
    `expected tests/test_engine.py to be in mockedInTests, got ${JSON.stringify(flagged.mockedInTests)}`
  );
  assert.ok(typeof advisory === 'string' && advisory.length > 0, 'expected an advisory string');
});

// ---------------------------------------------------------------------------
// 2. Not-flagged fixture: production changes validateInput(), test mocks only collaborators.
// ---------------------------------------------------------------------------
test('not-flagged fixture: returns no seams when test mocks only collaborators', () => {
  const diff = loadFixture('fixture_not_flagged.diff');
  const { seams } = analyzeMockSeams({ diff, config: {} });

  assert.deepStrictEqual(seams, [], 'expected no seams -- validateInput is not mocked');
});

// ---------------------------------------------------------------------------
// 3. Partial fixture: some tests mock, some don't. Still flagged because at least one mocks.
// ---------------------------------------------------------------------------
test('partial fixture: flags when at least one test mocks the changed function', () => {
  const diff = loadFixture('fixture_partial.diff');
  const { seams } = analyzeMockSeams({ diff, config: {} });

  assert.ok(seams.length > 0, 'expected at least one seam');
  const flagged = seams.find((s) => s.changedFn === 'calculateScore');
  assert.ok(flagged, 'expected calculateScore to be flagged');
  assert.ok(
    flagged.mockedInTests.some((t) => t.includes('test_scoring')),
    `expected tests/test_scoring.py to be in mockedInTests, got ${JSON.stringify(flagged.mockedInTests)}`
  );
});

// ---------------------------------------------------------------------------
// 4. Advisory format: the advisory string is human-readable and structured.
// ---------------------------------------------------------------------------
test('advisory string is formatted with seam count and affected function names', () => {
  const diff = loadFixture('fixture_flagged.diff');
  const { advisory } = analyzeMockSeams({ diff, config: {} });

  assert.ok(typeof advisory === 'string');
  assert.match(advisory, /Detected \d+ mock seam\(s\):/);
  assert.match(advisory, /processMessage/);
  assert.match(advisory, /mocked in:/);
});

// ---------------------------------------------------------------------------
// 5. JS syntax: mock.method / jest.spyOn patterns are detected.
// ---------------------------------------------------------------------------
test('JS syntax: detects seams when test uses mock.method or jest.spyOn', () => {
  const jsDiff = [
    'diff --git a/src/service.js b/src/service.js',
    '--- a/src/service.js',
    '+++ b/src/service.js',
    '@@ -5,3 +5,8 @@',
    ' const helpers = require("./helpers");',
    '',
    '+function processRequest(payload) {',
    '+    if (!payload) throw new Error("empty");',
    '+    return helpers.transform(payload);',
    '+}',
    '',
    'diff --git a/tests/service.test.js b/tests/service.test.js',
    '--- a/tests/service.test.js',
    '+++ b/tests/service.test.js',
    '@@ -1,5 +1,10 @@',
    " const { processRequest } = require('../src/service');",
    "+const mock = require('./mock');",
    '',
    '+mock.method(service, "processRequest", () => ({}));',
    '+// jest.spyOn(service, "processRequest").mockReturnValue({});',
    '',
    ' describe("processRequest", () => {',
    '   it("returns transformed payload", () => {',
    '     const result = processRequest({ a: 1 });',
    '     expect(result).toEqual({});',
    '   });',
    ' });',
  ].join('\n');

  const { seams } = analyzeMockSeams({ diff: jsDiff, config: {} });
  assert.ok(seams.length > 0, 'expected at least one seam for JS mock.method');
  const flagged = seams.find((s) => s.changedFn === 'processRequest');
  assert.ok(flagged, 'expected processRequest to be flagged');
});

// ---------------------------------------------------------------------------
// 6. Chat-retry legitimate-mock scenario: one test calls _stream_local directly.
//    The changed function is sendChat, but the test legitimately invokes an
//    internal helper -- no mock pattern targets sendChat, so no seam.
// ---------------------------------------------------------------------------
test('chat-retry legitimate mock: no seam when test calls _stream_local directly', () => {
  const chatRetryDiff = [
    'diff --git a/src/chat/retry.js b/src/chat/retry.js',
    '--- a/src/chat/retry.js',
    '+++ b/src/chat/retry.js',
    '@@ -8,3 +8,12 @@',
    ' const { backoff } = require("./backoff");',
    '',
    '+function sendChat(session, message) {',
    '+    const enriched = { ...message, sessionId: session.id };',
    '+    try {',
    '+        return _stream_local(session, enriched);',
    '+    } catch (e) {',
    '+        return backoff.retry(() => _stream_local(session, enriched));',
    '+    }',
    '+}',
    '+',
    ' module.exports = { sendChat };',
    '',
    'diff --git a/tests/chat/retry.test.js b/tests/chat/retry.test.js',
    '--- a/tests/chat/retry.test.js',
    '+++ b/tests/chat/retry.test.js',
    '@@ -1,5 +1,14 @@',
    " const { sendChat } = require('../../src/chat/retry');",
    "+const { _stream_local } = require('../../src/chat/stream');",
    '',
    ' describe("sendChat", () => {',
    '+    it("calls _stream_local directly on success", () => {',
    '+        const payload = { text: "hi" };',
    '+        const result = _stream_local({ id: "s1" }, payload);',
    '+        expect(result).toBeDefined();',
    '+    });',
    '+',
    '     it("returns a string", () => {',
    '         const result = sendChat({ id: "s1" }, { text: "hi" });',
    '         expect(typeof result).toBe("string");',
    '     });',
    ' });',
  ].join('\n');

  const { seams } = analyzeMockSeams({ diff: chatRetryDiff, config: {} });
  assert.deepStrictEqual(
    seams,
    [],
    'expected no seams -- _stream_local is an internal helper, not a mock of sendChat'
  );
});

// ---------------------------------------------------------------------------
// 7. Config gating: mode=false returns empty seams regardless of content.
// ---------------------------------------------------------------------------
test('config mode=false short-circuits and returns no seams', () => {
  const diff = loadFixture('fixture_flagged.diff');
  const { seams, advisory } = analyzeMockSeams({
    diff,
    config: { AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK: 'false' },
  });
  assert.deepStrictEqual(seams, []);
  assert.equal(advisory, null);
});

// ---------------------------------------------------------------------------
// 8. Empty / null diff returns empty seams with no error.
// ---------------------------------------------------------------------------
test('empty diff returns no seams and no advisory', () => {
  const { seams, advisory } = analyzeMockSeams({ diff: '', config: {} });
  assert.deepStrictEqual(seams, []);
  assert.equal(advisory, null);
});
