'use strict';

// Unit tests for claude-pause.js -- the manual "pause Claude" kill switch (Grimmethy,
// 2026-08-25: "I need a way to pause the claude use... preserve the tokens since I know
// I'm very likely to hit my weekly limit").

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { isClaudePaused } = require('./claude-pause.js');

function withTempPipelineDir(settings, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pause-test-'));
  if (settings !== undefined) {
    fs.writeFileSync(path.join(dir, 'dashboard-settings.json'), JSON.stringify(settings));
  }
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('isClaudePaused returns true when dashboard-settings.json has claudePaused: true', () => {
  withTempPipelineDir({ claudePaused: true }, (dir) => {
    assert.equal(isClaudePaused(dir), true);
  });
});

test('isClaudePaused returns false when claudePaused is false', () => {
  withTempPipelineDir({ claudePaused: false }, (dir) => {
    assert.equal(isClaudePaused(dir), false);
  });
});

test('isClaudePaused returns false when claudePaused is absent entirely', () => {
  withTempPipelineDir({ claudeDefaultModel: 'sonnet' }, (dir) => {
    assert.equal(isClaudePaused(dir), false);
  });
});

test('isClaudePaused fails open (false) when dashboard-settings.json does not exist', () => {
  withTempPipelineDir(undefined, (dir) => {
    assert.equal(isClaudePaused(dir), false);
  });
});

test('isClaudePaused fails open (false) on malformed JSON rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pause-test-'));
  fs.writeFileSync(path.join(dir, 'dashboard-settings.json'), '{not valid json');
  try {
    assert.equal(isClaudePaused(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isClaudePaused treats a truthy-but-non-boolean value as NOT paused (strict === true check)', () => {
  withTempPipelineDir({ claudePaused: 'true' }, (dir) => {
    assert.equal(isClaudePaused(dir), false);
  });
});
