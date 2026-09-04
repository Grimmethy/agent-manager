'use strict';

// Opt-in apply-time acceptance check for adhoc tasks (2026-09-04). When a task supplies
// promptContext.acceptanceCommand (a shell string) AND
// AGENT_MANAGER_ADHOC_ACCEPTANCE_COMMAND=true, apply-adhoc-diff.js runs it in repoRoot
// AFTER the patch has been applied to the branch checkout, BEFORE apply-task.js commits.
// A non-zero exit blocks the apply (apply-task leaves the branch for inspection, same as a
// failed git-apply). All git/shell calls go through an injectable `exec` so the test can
// drive it with canned output -- same discipline as decompose-integration-gate.js.

const { execFileSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120_000;

function realExec(file, args, opts) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    ...opts,
  });
}

// { repoRoot, command, exec?, timeoutMs? } -> { ok, checks: [{ name, status, detail }] }
// status: 'pass' | 'fail'  (a missing interpreter etc. is still 'fail' here -- unlike the
// decompose gate this is a task-authored command, so we don't get to guess it's optional).
function runAcceptanceCommand({ repoRoot, command, exec = realExec, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: true, checks: [] };
  try {
    const out = exec('bash', ['-lc', cmd], { cwd: repoRoot, timeout: timeoutMs });
    return { ok: true, checks: [{ name: 'acceptance', status: 'pass', detail: String(out || '').trim().slice(-1500) }] };
  } catch (e) {
    const detail = String(e.stdout || e.stderr || e.message || e).slice(-1500);
    return { ok: false, checks: [{ name: 'acceptance', status: 'fail', detail }] };
  }
}

module.exports = { runAcceptanceCommand, DEFAULT_TIMEOUT_MS };
