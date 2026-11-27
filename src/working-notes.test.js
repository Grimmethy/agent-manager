'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  saveWorkingNotes,
  loadWorkingNotes,
  prependWorkingNotes,
} = require('./working-notes-store.js');

const SESSION = 'sess-test';
const TRUNCATION_SUFFIX = '...[truncated]';

// Runs fn with a fresh temp instancesDir and removes it afterwards.
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('300-char notes round-trip through save then load', () => {
  withTempDir((instancesDir) => {
    const notes = 'a'.repeat(300);
    saveWorkingNotes(instancesDir, SESSION, notes, 2);
    const loaded = loadWorkingNotes(instancesDir, SESSION);
    assert.deepEqual(loaded, { notes, lastTurn: 2 });
  });
});

test('5000-char save is truncated to at most 1600 chars ending with ...[truncated]', () => {
  withTempDir((instancesDir) => {
    saveWorkingNotes(instancesDir, SESSION, 'b'.repeat(5000), 3);
    const loaded = loadWorkingNotes(instancesDir, SESSION);
    assert.ok(loaded, 'expected notes to load');
    assert.ok(loaded.notes.length <= 1600, `length was ${loaded.notes.length}`);
    assert.ok(loaded.notes.endsWith(TRUNCATION_SUFFIX));
  });
});

test('load returns null when the notes file is missing', () => {
  withTempDir((instancesDir) => {
    assert.equal(loadWorkingNotes(instancesDir, SESSION), null);
  });
});

test('load returns null when the notes file is corrupt JSON', () => {
  withTempDir((instancesDir) => {
    const sessionDir = path.join(instancesDir, SESSION);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'working-notes.json'), '{not valid json');
    assert.equal(loadWorkingNotes(instancesDir, SESSION), null);
  });
});

test('prependWorkingNotes with lastTurn 1 and currentTurn 5 returns true and adds WARNING', () => {
  withTempDir((instancesDir) => {
    saveWorkingNotes(instancesDir, SESSION, 'old notes', 1);
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
    const result = prependWorkingNotes(messages, { instancesDir, sessionId: SESSION, currentTurn: 5 });
    assert.equal(result, true);
    assert.ok(messages.some((m) => String(m.content).includes('WARNING')), 'expected a WARNING message');
  });
});

test('prependWorkingNotes with lastTurn 4 and currentTurn 5 returns false with no WARNING', () => {
  withTempDir((instancesDir) => {
    saveWorkingNotes(instancesDir, SESSION, 'recent notes', 4);
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
    const result = prependWorkingNotes(messages, { instancesDir, sessionId: SESSION, currentTurn: 5 });
    assert.equal(result, false);
    assert.ok(!messages.some((m) => String(m.content).includes('WARNING')), 'unexpected WARNING message');
  });
});
