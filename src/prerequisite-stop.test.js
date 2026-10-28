'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectPrerequisiteStop } = require('./agentic-draft-common.js');

describe('detectPrerequisiteStop', () => {
  it('detects a line starting with STOP', () => {
    const text = 'Some preamble\n\nSTOP: accounts hub must be merged to master first\n\nConclusion';
    const result = detectPrerequisiteStop(text);
    assert.equal(result, 'STOP: accounts hub must be merged to master first');
  });

  it('detects a line starting with PREREQUISITE', () => {
    const text = 'PREREQUISITE: HUB0006 must be merged before this can proceed';
    const result = detectPrerequisiteStop(text);
    assert.equal(result, 'PREREQUISITE: HUB0006 must be merged before this can proceed');
  });

  it('detects needs-clarification outside quotes', () => {
    const text = 'The model says we need needs-clarification on the accounts hub merge';
    const result = detectPrerequisiteStop(text);
    assert.ok(result);
    assert.ok(result.includes('needs-clarification'));
  });

  it('does NOT detect needs-clarification inside double quotes', () => {
    const text = 'The task text says "needs-clarification" but that is just quoted text';
    const result = detectPrerequisiteStop(text);
    assert.equal(result, null);
  });

  it('does NOT detect needs-clarification inside single quotes', () => {
    const text = "The task text says 'needs-clarification' but that is just quoted text";
    const result = detectPrerequisiteStop(text);
    assert.equal(result, null);
  });

  it('truncates to 600 chars', () => {
    const longLine = 'STOP: ' + 'x'.repeat(700);
    const result = detectPrerequisiteStop(longLine);
    assert.equal(result.length, 600);
  });

  it('returns null for infra-error without prerequisite stop', () => {
    const text = 'BLOCKER-TYPE: infra-error\nThe model crashed';
    const result = detectPrerequisiteStop(text);
    assert.equal(result, null);
  });

  it('returns null for random text without any stop signal', () => {
    const text = 'The implementation is complete. All tests pass.';
    const result = detectPrerequisiteStop(text);
    assert.equal(result, null);
  });

  it('handles empty text', () => {
    assert.equal(detectPrerequisiteStop(''), null);
  });

  it('handles null text', () => {
    assert.equal(detectPrerequisiteStop(null), null);
  });

  it('handles undefined text', () => {
    assert.equal(detectPrerequisiteStop(undefined), null);
  });

  it('case-insensitive STOP detection', () => {
    const text = 'some text\nstop: the hub must be merged\nmore text';
    const result = detectPrerequisiteStop(text);
    assert.ok(result);
    assert.ok(result.toLowerCase().startsWith('stop:'));
  });

  it('case-insensitive PREREQUISITE detection', () => {
    const text = 'some text\nprerequisite: the hub must be merged\nmore text';
    const result = detectPrerequisiteStop(text);
    assert.ok(result);
    assert.ok(result.toLowerCase().startsWith('prerequisite:'));
  });

  it('STOP word boundary -- "STOPPED" does not match', () => {
    const text = 'The process was STOPPED because of an error';
    const result = detectPrerequisiteStop(text);
    assert.equal(result, null);
  });
});
