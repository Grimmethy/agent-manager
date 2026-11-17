'use strict';

// The only module that performs file I/O for apply failures. Persists to
// ~/.local/state/agent-manager/apply-failures.json. Never throws into the apply path:
// read problems are logged and treated as an empty state, and write problems are logged
// and swallowed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WINDOW_MS = 600000;

function storeDir() {
  return path.join(os.homedir(), '.local', 'state', 'agent-manager');
}

function storePath() {
  return path.join(storeDir(), 'apply-failures.json');
}

function emptyState() {
  return { version: 1, entries: [], notified: {} };
}

function isValidEntry(e) {
  return !!e && typeof e === 'object' && typeof e.sig === 'string' &&
    typeof e.ts === 'number' && typeof e.taskId === 'string';
}

function isValidState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (s.version !== 1) return false;
  if (!Array.isArray(s.entries) || !s.entries.every(isValidEntry)) return false;
  if (!s.notified || typeof s.notified !== 'object' || Array.isArray(s.notified)) return false;
  return Object.values(s.notified).every(v => typeof v === 'number');
}

function load() {
  let file = null;
  try {
    file = storePath();
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isValidState(parsed)) {
      console.warn(`[apply-failure-store] ${file} has an unexpected shape; treating as empty`);
      return emptyState();
    }
    return parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyState();
    console.warn(`[apply-failure-store] could not load ${file || 'apply-failures.json'}: ${err && err.message}; treating as empty`);
    return emptyState();
  }
}

function save(state) {
  let file = null;
  let tmp = null;
  try {
    file = storePath();
    const dir = path.dirname(file);
    tmp = path.join(dir, `apply-failures.json.${process.pid}.tmp`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[apply-failure-store] could not save ${file || 'apply-failures.json'}: ${err && err.message}`);
    try {
      if (tmp) fs.rmSync(tmp, { force: true });
    } catch (_) {
      // best-effort cleanup only
    }
  }
}

function pruneAll(state, now) {
  const base = state && typeof state === 'object' ? state : emptyState();
  const entries = Array.isArray(base.entries) ? base.entries : [];
  return {
    version: 1,
    entries: entries.filter(e => !(now - e.ts > WINDOW_MS)).map(e => ({ ...e })),
    notified: { ...(base.notified || {}) },
  };
}

module.exports = { load, save, pruneAll };
