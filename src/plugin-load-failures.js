'use strict';

// Records plugin register.js load failures. An in-memory list (one entry per plugin, last
// failure wins) backs recordPluginLoadFailure/getPluginLoadFailures; writePluginLoadFailures
// persists them to <stateDir>/plugin-load-failures.json. The file is read-modify-written by
// whichever process reports a failure, so concurrent processes race on it and the last
// writer wins.
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'plugin-load-failures.json';

const failures = new Map();

function normalize(entry) {
  return {
    plugin: String(entry.plugin),
    registerPath: String(entry.registerPath),
    message: String(entry.message),
    stack: entry.stack == null ? '' : String(entry.stack),
  };
}

function recordPluginLoadFailure(entry) {
  const e = normalize(entry);
  failures.set(e.plugin, e);
  console.error(`[plugin-load-failed] ${e.plugin} ${e.registerPath}: ${e.message}`);
}

function getPluginLoadFailures() {
  return Array.from(failures.values()).map((e) => ({ ...e }));
}

// Concurrent processes race on this read-modify-write; last writer wins.
function writePluginLoadFailures(stateDir, incoming) {
  const finalPath = path.join(stateDir, FILE_NAME);
  const tmpPath = finalPath + '.tmp';

  const merged = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (e && typeof e.plugin === 'string') merged.set(e.plugin, e);
      }
    }
  } catch {
    // Missing or corrupt file counts as empty.
  }

  for (const e of incoming) {
    const n = normalize(e);
    merged.set(n.plugin, n);
  }

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify([...merged.values()], null, 2));
  fs.renameSync(tmpPath, finalPath);
}

module.exports = {
  recordPluginLoadFailure,
  getPluginLoadFailures,
  writePluginLoadFailures,
};
