'use strict';

// node-loaded-sha.js -- record what the running units actually loaded from the checkout.
//
// The checkout HEAD (codeSha, from src/node-heartbeat.js) says what is on disk. A unit
// that applied a bundle but did not restart is not current: its loadedSha still points at
// the sha it loaded last time it started. We write loadedSha at each unit start (event:
// unit start only, no timer) and the existing heartbeat carries it to the registry.
//
// writeLoadedSha reads the checkout HEAD the same way readCodeSha does, then writes
// instances/loaded-sha-<unitName>.json atomically. Any git/fs failure returns null without
// throwing: a unit start must not fail because the registry file is unwritable.
//
// readLoadedSha enumerates every instances/loaded-sha-*.json file and returns the sha only
// when at least one file exists, every file holds a valid 40 lowercase hex sha and all
// files agree; otherwise it returns null.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('./atomic-write.js');
const { sharedInstancesDir } = require('./instances-dir.js');

const HEX40 = /^[0-9a-f]{40}$/;

function readHeadSha(deps) {
  try {
    const d = (deps && deps.codeDir) || process.cwd();
    const execGit = (deps && deps.execGit) || ((args) => {
      const childProcess = require('child_process');
      return String(
        childProcess.execFileSync('git', args, {
          timeout: 3000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      ).replace(/\r?\n$/, '');
    });
    const out = String(execGit(['-C', d, 'rev-parse', 'HEAD'])).replace(/\r?\n$/, '');
    return HEX40.test(out) ? out : null;
  } catch (e) {
    return null;
  }
}

function resolveInstancesDir(deps) {
  if (deps && deps.instancesDir) return deps.instancesDir;
  const pipelineDir = (deps && deps.pipelineDir) || process.cwd();
  return sharedInstancesDir(pipelineDir);
}

// Write the loaded-sha file for one unit. Returns the sha on success, null on any failure.
// Never throws: a unit start must not fail because the registry file is unwritable.
function writeLoadedSha(unitName, deps) {
  const sha = readHeadSha(deps);
  if (!sha) return null;
  const dir = resolveInstancesDir(deps);
  const file = path.join(dir, `loaded-sha-${unitName}.json`);
  const payload = { sha, timestamp: new Date().toISOString() };
  try {
    writeJsonAtomicSync(file, payload);
  } catch (e) {
    return null;
  }
  return sha;
}

// Read every instances/loaded-sha-*.json file and return the agreed sha, or null.
// Returns null when:
//   - no file exists
//   - any file is corrupt (bad JSON)
//   - any file's sha is not a 40 lowercase hex string
//   - files disagree on the sha
// Never throws: a heartbeat must not fail because a stale file is unreadable.
function readLoadedSha(deps) {
  const dir = resolveInstancesDir(deps);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return null;
  }
  const candidates = files.filter((f) => f.startsWith('loaded-sha-') && f.endsWith('.json'));
  if (candidates.length === 0) return null;
  let agreed = null;
  for (const name of candidates) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    const sha = parsed && typeof parsed.sha === 'string' ? parsed.sha : null;
    if (!sha || !HEX40.test(sha)) return null;
    if (agreed === null) {
      agreed = sha;
    } else if (agreed !== sha) {
      return null;
    }
  }
  return agreed;
}

module.exports = { writeLoadedSha, readLoadedSha };

if (require.main === module) {
  const [command, unitName] = process.argv.slice(2);
  if (command === 'write' && unitName) {
    try {
      writeLoadedSha(unitName);
    } catch (_) {}
  }
  process.exit(0);
}
