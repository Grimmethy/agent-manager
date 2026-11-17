'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EDIT_TOOL_NAMES, checkLaneEditTools } = require('./lane-edit-tools-gate.js');

test('EDIT_TOOL_NAMES includes write_file and edit_file', () => {
  assert.ok(EDIT_TOOL_NAMES.includes('write_file'));
  assert.ok(EDIT_TOOL_NAMES.includes('edit_file'));
});

test('mustEdit with no edit tools is refused with a lane-misconfigured reason', () => {
  const r = checkLaneEditTools({ lane: 'laneX', toolNames: ['grep_codebase', 'read_file'], mustEdit: true });
  assert.ok(r, 'expected a refusal');
  assert.ok(r.reason.startsWith('lane-misconfigured:'));
  assert.strictEqual(r.lane, 'laneX');
  assert.deepStrictEqual(r.toolNames, ['grep_codebase', 'read_file']);
});

test('mustEdit with an empty tool list is refused', () => {
  const r = checkLaneEditTools({ lane: 'laneY', toolNames: [], mustEdit: true });
  assert.ok(r && r.reason.startsWith('lane-misconfigured:'));
});

test('mustEdit with edit_file present proceeds (null)', () => {
  assert.strictEqual(checkLaneEditTools({ lane: 'l', toolNames: ['read_file', 'edit_file'], mustEdit: true }), null);
});

test('mustEdit false never refuses, even with no tools', () => {
  assert.strictEqual(checkLaneEditTools({ lane: 'l', toolNames: [], mustEdit: false }), null);
});
