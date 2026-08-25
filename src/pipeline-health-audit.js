'use strict';

// Deterministic "detector" half of a real hygiene task source (2026-08-24, Grimmethy:
// "that going looking needs to be an automated process. A task that happens just like
// any other hygiene task") -- automates the live-system investigation this session did
// by hand (queue throughput, daemon process health, GPU lock state, recent error-log
// signatures) that found three real incidents in one sitting: a structurally-broken
// model profile silently failing every draft of one task type, a stray bash syntax
// error masking a retry-limit check, and orphaned zombie processes holding the GPU lock
// indefinitely. None of those were visible from queue counts alone -- the queue looked
// "big but healthy" the whole time.
//
// Mirrors pipeline-self-audit.js's own shape: detect-only, never edits pipeline code or
// touches queue/ files directly -- task-sources.js's nextPipelineHealthAuditTask() wraps
// this into a real adhoc task (same harness-grounded draft -> review -> apply path every
// other adhoc fix goes through) only when something actually looks wrong. A clean run
// produces zero anomalies and files nothing, same "silently no-op when healthy"
// discipline pipeline_self_audit/staleness_audit already follow.
//
// THROUGHPUT_STALL is the headline signal (exactly what tipped this session off): real
// pending work exists, daemons report themselves running, but nothing has actually
// completed in the check window. The other signals (duplicate daemon instances, a GPU
// lock held with no corresponding "working" heartbeat, known error-log signatures) are
// supplementary evidence folded into the SAME filed task rather than separate triggers
// of their own -- a human/local-model investigating "why did throughput stop" needs all of
// this at once, not four separate half-informed tasks.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly -- matches system-report.js's own hourly period, a natural fit since "completions in the last hour" IS the window this checks.
const THROUGHPUT_WINDOW_MS = 60 * 60 * 1000;

// Every long-running daemon this pipeline expects, and the pattern that identifies it in
// a process list -- worker-reasoning is deliberately NOT matched by the worker-1 pattern
// (anchored with a trailing word boundary) despite the substring overlap.
const EXPECTED_DAEMONS = [
  { name: 'worker-1', pattern: /local-worker\.sh worker-1\b/ },
  { name: 'worker-reasoning', pattern: /local-worker\.sh worker-reasoning\b/ },
  { name: 'queue-watchdog', pattern: /queue-watcher\.sh/ },
  { name: 'reviewer', pattern: /review-runner\.sh/ },
];

// Same known-bad-signature shape as pipeline-self-audit.js's REASON_CATEGORIES, but over
// recent LOG lines instead of blockedReason text -- both real incidents caught live this
// session left a distinctive trace here before either ever produced a single blocked task.
const LOG_ERROR_SIGNATURES = [
  { key: 'ansi-color-broke-numeric-test', pattern: /operand expected/i },
  { key: 'ollama-model-config-mismatch', pattern: /does not support thinking/i },
  { key: 'ollama-request-timeout', pattern: /Ollama request timed out/i },
];

function schedulePath(instancesDir) {
  return path.join(instancesDir, '.health-audit-schedule.json');
}

function isDue(instancesDir, now = new Date()) {
  let schedule;
  try {
    schedule = JSON.parse(fs.readFileSync(schedulePath(instancesDir), 'utf8'));
  } catch {
    return true; // never checked before -- due immediately.
  }
  const last = schedule.lastCheckedAt;
  if (!last) return true;
  return now.getTime() - new Date(last).getTime() >= CHECK_INTERVAL_MS;
}

function markChecked(instancesDir, now = new Date()) {
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(schedulePath(instancesDir), JSON.stringify({ lastCheckedAt: now.toISOString() }, null, 2));
}

function countRecentCompletions(pipelineDir, now, windowMs) {
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  let names;
  try {
    names = fs.readdirSync(doneDir).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - windowMs;
  let count = 0;
  for (const name of names) {
    try {
      if (fs.statSync(path.join(doneDir, name)).mtimeMs >= cutoff) count++;
    } catch { /* file vanished mid-scan -- doesn't count either way */ }
  }
  return count;
}

function countPending(pipelineDir) {
  try {
    return fs.readdirSync(path.join(pipelineDir, 'queue', 'pending')).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function listProcesses() {
  const out = execFileSync('ps', ['-eo', 'pid,ppid,cmd', '--no-headers'], { encoding: 'utf8' });
  return out.split('\n').map((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : null;
  }).filter(Boolean);
}

function checkDaemonCounts(ps) {
  const findings = [];
  for (const daemon of EXPECTED_DAEMONS) {
    const matches = ps.filter((p) => daemon.pattern.test(p.cmd));
    if (matches.length === 0) findings.push(`${daemon.name}: no process found (dead-process-check.js should restart this on its own next tick, but it's absent right now)`);
    else if (matches.length > 1) findings.push(`${daemon.name}: ${matches.length} processes running simultaneously (pids ${matches.map((m) => m.pid).join(', ')}) -- should only ever be one`);
  }
  return findings;
}

function checkOrphanedModelCalls(ps) {
  return ps.filter((p) => p.ppid === 1 && /\blocal-draft\.js\b/.test(p.cmd));
}

function tailLogErrorSignatures(logDir, lines = 200) {
  const findings = [];
  let names;
  try {
    names = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
  } catch {
    return findings;
  }
  for (const name of names) {
    let content;
    try {
      content = fs.readFileSync(path.join(logDir, name), 'utf8');
    } catch {
      continue;
    }
    const recentLines = content.split('\n').slice(-lines);
    for (const sig of LOG_ERROR_SIGNATURES) {
      const hitCount = recentLines.filter((l) => sig.pattern.test(l)).length;
      if (hitCount > 0) findings.push(`${name}: ${hitCount} recent line(s) matching "${sig.key}"`);
    }
  }
  return findings;
}

/**
 * Runs the full deterministic check. Returns { anomalies: string[], evidence: object } --
 * anomalies is empty when nothing looks wrong (the common, expected case).
 */
function checkPipelineHealth({ pipelineDir, instancesDir, logDir, now = new Date(), listProcessesFn = listProcesses } = {}) {
  const recentCompletions = countRecentCompletions(pipelineDir, now, THROUGHPUT_WINDOW_MS);
  const pending = countPending(pipelineDir);

  let ps = [];
  try {
    ps = listProcessesFn();
  } catch { /* best-effort -- process-derived checks just come back empty below */ }

  const daemonFindings = checkDaemonCounts(ps);
  const orphans = checkOrphanedModelCalls(ps);
  const logFindings = tailLogErrorSignatures(logDir);

  const anomalies = [];
  // The headline signal: real work is waiting, but nothing has finished in a full hour.
  // A quiet pipeline with an empty pending/ is NOT an anomaly -- there's simply nothing
  // to do; this only fires when there's a real backlog not being worked through.
  if (recentCompletions === 0 && pending > 5) {
    anomalies.push(`Zero tasks completed in the last hour despite ${pending} pending -- throughput has stalled.`);
  }
  if (daemonFindings.length > 0) anomalies.push(...daemonFindings);
  if (orphans.length > 0) anomalies.push(`${orphans.length} orphaned model-call process(es) still running (ppid=1) -- should have been caught by dead-process-check.js's own kill-orphan action; if you're seeing this, that mechanism itself may need attention.`);
  if (logFindings.length > 0) anomalies.push(...logFindings);

  return {
    anomalies,
    evidence: { recentCompletions, pending, daemonFindings, orphanPids: orphans.map((o) => o.pid), logFindings },
  };
}

module.exports = {
  checkPipelineHealth, isDue, markChecked,
  countRecentCompletions, countPending, checkDaemonCounts, checkOrphanedModelCalls, tailLogErrorSignatures,
  THROUGHPUT_WINDOW_MS, CHECK_INTERVAL_MS,
};
