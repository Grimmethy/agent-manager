'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildEvidencePack } = require('../src/evidence-pack.js');
const { validateResolutionVerdict } = require('../src/validate-resolution.js');
const { next, apply, hasCodeReference, looksLikeResearch, isAlreadyChecked } = require('../src/brain-dump-resolution-check.js');

// Test evidence pack builder
test('buildEvidencePack: includes entry text', () => {
  const entry = { rawText: 'test entry', capturedAt: '2026-10-26T00:00:00Z' };
  const pack = buildEvidencePack(entry, 'abc123', 3000);
  assert.ok(pack.entryText.includes('test entry'));
});

test('buildEvidencePack: includes cited paths', () => {
  const entry = { rawText: 'check `src/foo.js`', capturedAt: '2026-10-26T00:00:00Z' };
  const pack = buildEvidencePack(entry, 'abc123', 3000);
  assert.ok(pack.citedPaths.length > 0);
  assert.strictEqual(pack.citedPaths[0].path, 'src/foo.js');
});

test('buildEvidencePack: includes recent commits', () => {
  const entry = { rawText: 'check `src/foo.js`', capturedAt: '2026-10-26T00:00:00Z' };
  const pack = buildEvidencePack(entry, 'abc123', 3000);
  assert.ok(Array.isArray(pack.recentCommits));
});

test('buildEvidencePack: caps at specified length', () => {
  const entry = { rawText: 'x'.repeat(5000), capturedAt: '2026-10-26T00:00:00Z' };
  const pack = buildEvidencePack(entry, 'abc123', 3000);
  const json = JSON.stringify(pack);
  assert.ok(json.length <= 3000, `Pack too large: ${json.length} chars`);
});

// Test validator
test('validator: accepts yes with grounded evidence (commit hash)', () => {
  const verdict = { resolved: 'yes', evidence: 'commit abc1234567890 fixed it' };
  const pack = { recentCommits: ['abc1234567890 subject'] };
  const result = validateResolutionVerdict(verdict, verdict.evidence, pack);
  assert.strictEqual(result.resolved, 'yes');
  assert.ok(result.evidence.includes('abc1234567890'));
});

test('validator: accepts yes with grounded evidence (file:line)', () => {
  const verdict = { resolved: 'yes', evidence: 'src/foo.js:42' };
  const pack = { citedIdentifiers: [{ identifier: 'foo', hits: ['src/foo.js:42: code'] }] };
  const result = validateResolutionVerdict(verdict, verdict.evidence, pack);
  assert.strictEqual(result.resolved, 'yes');
  assert.ok(result.evidence.includes('src/foo.js:42'));
});

test('validator: accepts yes with grounded evidence (quoted subject)', () => {
  const verdict = { resolved: 'yes', evidence: '"add hold subcommand" in commit' };
  const pack = { recentCommits: ['abc123 "add hold subcommand" to gpu-arbiter'] };
  const result = validateResolutionVerdict(verdict, verdict.evidence, pack);
  assert.strictEqual(result.resolved, 'yes');
  assert.ok(result.evidence.includes('add hold subcommand'));
});

test('validator: downgrades yes without grounded evidence', () => {
  const verdict = { resolved: 'yes', evidence: 'random text not in pack' };
  const pack = { entryText: 'test', citedPaths: [], citedIdentifiers: [], recentCommits: [] };
  const result = validateResolutionVerdict(verdict, verdict.evidence, pack);
  assert.strictEqual(result.resolved, 'unclear');
  assert.strictEqual(result.error, 'evidence not grounded in pack');
});

test('validator: downgrades invalid verdict format', () => {
  const verdict = { resolved: 'maybe' };
  const result = validateResolutionVerdict(verdict, 'evidence', {});
  assert.strictEqual(result.resolved, 'unclear');
  assert.strictEqual(result.error, 'invalid verdict format');
});

test('validator: downgrades missing evidence', () => {
  const verdict = { resolved: 'yes' };
  const result = validateResolutionVerdict(verdict, '', {});
  assert.strictEqual(result.resolved, 'unclear');
  assert.strictEqual(result.error, 'missing evidence');
});

// Test next() filtering
test('next(): skips entries with no code reference', () => {
  const entries = [{ rawText: 'just an idea', status: 'sorted', capturedAt: '2026-10-26' }];
  const result = next({ entries, masterSha: 'abc123' });
  assert.strictEqual(result.length, 0);
});

test('next(): skips research notes', () => {
  const entries = [{ rawText: 'see https://example.com', status: 'sorted', capturedAt: '2026-10-26' }];
  const result = next({ entries, masterSha: 'abc123' });
  assert.strictEqual(result.length, 0);
});

test('next(): skips already-checked entries', () => {
  const entries = [{ 
    rawText: 'check `scripts/foo.js`', 
    status: 'sorted', 
    capturedAt: '2026-10-26',
    resolutionCheck: { at: '2026-10-27', masterSha: 'abc123' }
  }];
  entries[0]._currentMasterSha = 'abc123';
  const result = next({ entries, masterSha: 'abc123' });
  assert.strictEqual(result.length, 0);
});

test('next(): yields entries ready for checking', () => {
  const entries = [{ 
    rawText: 'check `scripts/foo.js`', 
    status: 'sorted', 
    capturedAt: '2026-10-26'
  }];
  const result = next({ entries, masterSha: 'abc123' });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].entry.rawText, 'check `scripts/foo.js`');
});

// Test apply()
test('apply(): sets possiblyResolved on validated yes', () => {
  const entry = { rawText: 'check `scripts/foo.js`', status: 'sorted', capturedAt: '2026-10-26' };
  apply({ 
    entry, 
    verdict: { resolved: 'yes', evidence: 'commit abc123' }, 
    evidence: 'commit abc123', 
    masterSha: 'abc123' 
  });
  assert.ok(entry.possiblyResolved);
  assert.strictEqual(entry.possiblyResolved.masterSha, 'abc123');
  assert.ok(entry.possiblyResolved.checkedAt);
});

test('apply(): records check on no/unclear', () => {
  const entry = { rawText: 'check `scripts/foo.js`', status: 'sorted', capturedAt: '2026-10-26' };
  apply({ 
    entry, 
    verdict: { resolved: 'unclear', evidence: '' }, 
    evidence: '', 
    masterSha: 'abc123' 
  });
  assert.ok(entry.resolutionCheck);
  assert.strictEqual(entry.resolutionCheck.masterSha, 'abc123');
  assert.strictEqual(entry.resolutionCheck.verdict, 'unclear');
});

test('apply(): never changes status or rawText', () => {
  const entry = { rawText: 'check `scripts/foo.js`', status: 'sorted', capturedAt: '2026-10-26' };
  const originalStatus = entry.status;
  const originalRawText = entry.rawText;
  
  apply({ 
    entry, 
    verdict: { resolved: 'yes', evidence: 'commit abc123' }, 
    evidence: 'commit abc123', 
    masterSha: 'abc123' 
  });
  
  assert.strictEqual(entry.status, originalStatus);
  assert.strictEqual(entry.rawText, originalRawText);
});

// Test helper functions
test('hasCodeReference: detects backticked paths', () => {
  assert.ok(hasCodeReference('check `scripts/foo.js`'));
  assert.ok(!hasCodeReference('no backticks here'));
});

test('looksLikeResearch: detects URLs and research keywords', () => {
  assert.ok(looksLikeResearch('see https://example.com'));
  assert.ok(looksLikeResearch('research paper on ML'));
  assert.ok(!looksLikeResearch('check `scripts/foo.js`'));
});

test('isAlreadyChecked: checks masterSha match', () => {
  const entry = { resolutionCheck: { masterSha: 'abc123' } };
  entry._currentMasterSha = 'abc123';
  assert.ok(isAlreadyChecked(entry));
  
  entry._currentMasterSha = 'def456';
  assert.ok(!isAlreadyChecked(entry));
  
  delete entry.resolutionCheck;
  assert.ok(!isAlreadyChecked(entry));
});
