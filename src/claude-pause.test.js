'use strict';

// Unit tests for claude-pause.js -- the manual "pause Claude" kill switch (Grimmethy,
// 2026-08-25: "I need a way to pause the claude use... preserve the tokens since I know
// I'm very likely to hit my weekly limit").

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { isClaudePaused, settingsPathFor } = require('./claude-pause.js');

// isClaudePaused takes an explicit settings-file path as a test seam; production callers
// pass nothing and get settingsPathFor() (the package root -- see the module header).
function withTempSettingsFile(settings, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pause-test-'));
  const file = path.join(dir, 'dashboard-settings.json');
  if (settings !== undefined) {
    fs.writeFileSync(file, typeof settings === 'string' ? settings : JSON.stringify(settings));
  }
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('settingsPathFor resolves to <packageRoot>/dashboard-settings.json (beside src/, matching app.py + agent-manager-common.sh)', () => {
  const p = settingsPathFor();
  assert.equal(path.basename(p), 'dashboard-settings.json');
  assert.equal(path.dirname(p), path.resolve(__dirname, '..'));
});

test('isClaudePaused returns true when dashboard-settings.json has claudePaused: true', () => {
  withTempSettingsFile({ claudePaused: true }, (file) => {
    assert.equal(isClaudePaused(file), true);
  });
});

test('isClaudePaused returns false when claudePaused is false', () => {
  withTempSettingsFile({ claudePaused: false }, (file) => {
    assert.equal(isClaudePaused(file), false);
  });
});

test('isClaudePaused returns false when claudePaused is absent entirely', () => {
  withTempSettingsFile({ claudeDefaultModel: 'sonnet' }, (file) => {
    assert.equal(isClaudePaused(file), false);
  });
});

test('isClaudePaused fails open (false) when dashboard-settings.json does not exist', () => {
  withTempSettingsFile(undefined, (file) => {
    assert.equal(isClaudePaused(file), false);
  });
});

test('isClaudePaused fails open (false) on malformed JSON rather than throwing', () => {
  withTempSettingsFile('{not valid json', (file) => {
    assert.equal(isClaudePaused(file), false);
  });
});

test('isClaudePaused treats a truthy-but-non-boolean value as NOT paused (strict === true check)', () => {
  withTempSettingsFile({ claudePaused: 'true' }, (file) => {
    assert.equal(isClaudePaused(file), false);
  });
});
