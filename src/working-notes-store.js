'use strict';

// working-notes-store.js -- model-maintained working notes, persisted per session.
//
// Notes live at <instancesDir>/<sanitized sessionId>/working-notes.json as {notes, lastTurn}.
// This module makes no model call and runs no timers or watchers: it is a pure read/write helper.

const fs = require('fs');
const path = require('path');

const WORKING_NOTES_MAX_CHARS = 1600;
const WORKING_NOTES_STALE_GAP_TURNS = 3;
const TRUNCATION_SUFFIX = '...[truncated]';
const NOTES_FILE_NAME = 'working-notes.json';

function sessionDir(instancesDir, sessionId) {
  const safeId = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(String(instancesDir), safeId);
}

// Keeps the stored string at most WORKING_NOTES_MAX_CHARS long, suffix included.
function truncateNotes(notes) {
  const text = String(notes == null ? '' : notes);
  if (text.length <= WORKING_NOTES_MAX_CHARS) return text;
  return text.slice(0, WORKING_NOTES_MAX_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

function saveWorkingNotes(instancesDir, sessionId, notes, turn) {
  const dir = sessionDir(instancesDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, NOTES_FILE_NAME);
  const tmp = target + '.tmp';
  const body = JSON.stringify({ notes: truncateNotes(notes), lastTurn: turn });
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
}

// Returns {notes, lastTurn} or null. Never throws.
function loadWorkingNotes(instancesDir, sessionId) {
  try {
    const raw = fs.readFileSync(path.join(sessionDir(instancesDir, sessionId), NOTES_FILE_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.notes !== 'string' || !Number.isFinite(parsed.lastTurn)) return null;
    return { notes: parsed.notes, lastTurn: parsed.lastTurn };
  } catch (_) {
    return null;
  }
}

// Mutates messages in place. Returns true when a staleness warning was appended, otherwise false.
// With no saved notes, messages is left unchanged and the result is false.
function prependWorkingNotes(messages, opts) {
  const { instancesDir, sessionId, currentTurn } = opts || {};
  const saved = loadWorkingNotes(instancesDir, sessionId);
  if (!saved) return false;

  const insertAt = messages.length > 0 && messages[0] && messages[0].role === 'system' ? 1 : 0;
  messages.splice(insertAt, 0, {
    role: 'user',
    content: `[WORKING NOTES -- model-maintained, last updated turn ${saved.lastTurn}]\n${saved.notes}`,
  });

  const gap = Number(currentTurn) - saved.lastTurn;
  if (gap > WORKING_NOTES_STALE_GAP_TURNS) {
    messages.push({
      role: 'user',
      content: `[WARNING: notes not updated for ${gap} turns -- consider calling update_working_notes]`,
    });
    return true;
  }
  return false;
}

module.exports = {
  WORKING_NOTES_MAX_CHARS,
  WORKING_NOTES_STALE_GAP_TURNS,
  saveWorkingNotes,
  loadWorkingNotes,
  prependWorkingNotes,
};
