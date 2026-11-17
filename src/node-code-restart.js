'use strict';

// Node code restart plan (FF-9/9a): after the pull has applied a bundle, decide from the applied diff what must restart and record it.
// planRestart reads `git diff --name-only oldSha..newSha`, asks restartActions (src/live-checkout-restart-rule.js) which actions the paths need,
// and writes <pipelineDir>/instances/code-restart-pending.json for the drain that follows (a later piece). Called once per applied update,
// no timer, no polling. mode is 'off' (nothing at all), 'dry-run' (an audit line in instances/code-restart.log, no record) or 'on'.
// Never throws: a git failure, a bad sha or an unwritable record is audited when it can be and gives null.

const childProcess = require('child_process');
const nodeFs = require('fs');
const path = require('path');
const { restartActions } = require('./live-checkout-restart-rule.js');

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PENDING_FILE = 'code-restart-pending.json';
const AUDIT_FILE = 'code-restart.log';

function defaultRun(cmd, args) {
  return childProcess.execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000 });
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return new Date(value == null ? Date.now() : value).toISOString();
}

function unique(list) {
  return [...new Set(list)];
}

// Appends one JSON audit line; an audit failure never changes the result.
function audit(fs, dir, line) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, AUDIT_FILE), `${JSON.stringify(line)}\n`);
  } catch (e) { /* the audit is best effort */ }
}

// The pending record already on disk, or null when there is none or it is unreadable.
function readPending(fs, file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record && typeof record === 'object' ? record : null;
  } catch (e) {
    return null;
  }
}

// Plans the restart for the applied update oldSha..newSha. Returns the pending record that was written, or null (mode off or dry-run, no action needed,
// a git failure, a bad sha). A record that already exists keeps its since, alerted and oldSha, takes the new newSha, and gains any new action (never loses one; the rule makes src a units AND pipeline change, so a written record always has pipeline true).
function planRestart({ repoDir, oldSha, newSha, pipelineDir, mode = 'on', run = defaultRun, fs = nodeFs, now = Date.now } = {}) {
  if (mode === 'off') return null;
  const dir = path.join(pipelineDir || '.', 'instances');
  const at = isoNow(now);
  const base = { at, mode, oldSha, newSha };
  if (typeof oldSha !== 'string' || !SHA_PATTERN.test(oldSha) || typeof newSha !== 'string' || !SHA_PATTERN.test(newSha)) {
    audit(fs, dir, { ...base, matched: [], decision: 'none', reason: 'sha must be 40 lowercase hex' });
    return null;
  }
  let paths;
  try {
    paths = String(run('git', ['-C', repoDir, 'diff', '--name-only', `${oldSha}..${newSha}`])).split('\n').map((p) => p.trim()).filter(Boolean);
  } catch (e) {
    audit(fs, dir, { ...base, matched: [], decision: 'none', reason: `git diff failed: ${e.message}` });
    return null;
  }
  const actions = restartActions(paths);
  const matched = unique([...actions.matched.units, ...actions.matched.pipeline]);
  if (!actions.units && !actions.pipeline) return null;
  if (mode === 'dry-run') {
    audit(fs, dir, { ...base, matched, decision: `would restart units=${actions.units} pipeline=${actions.pipeline}`, reason: 'dry-run: no record written' });
    return null;
  }
  const file = path.join(dir, PENDING_FILE);
  const existing = readPending(fs, file);
  const previous = existing && existing.matched && typeof existing.matched === 'object' ? existing.matched : {};
  const record = {
    oldSha: existing && SHA_PATTERN.test(String(existing.oldSha)) ? existing.oldSha : oldSha,
    newSha,
    units: actions.units || Boolean(existing && existing.units),
    pipeline: actions.pipeline,
    matched: {
      units: unique([...(Array.isArray(previous.units) ? previous.units : []), ...actions.matched.units]),
      pipeline: unique([...(Array.isArray(previous.pipeline) ? previous.pipeline : []), ...actions.matched.pipeline]),
    },
    since: existing && typeof existing.since === 'string' ? existing.since : at,
    alerted: Boolean(existing && existing.alerted),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    audit(fs, dir, { ...base, matched, decision: 'none', reason: `record not written: ${e.message}` });
    return null;
  }
  audit(fs, dir, { ...base, matched, decision: `restart units=${record.units} pipeline=${record.pipeline}`, reason: existing ? 'kept the pending record' : 'new pending record' });
  return record;
}

module.exports = { planRestart, PENDING_FILE, AUDIT_FILE };
