'use strict';

// Node code pull (multi-node plan, node code sync): applies the bundle published into inDir to this node's checkout and plans the restart the new code needs.
// AGENT_MANAGER_CODE_PULL is off, dry-run or on; anything else (unset, empty, another case) means off and pullCode returns before touching git, the bundle or the restart plan.
// It is a plain function a caller invokes on an event: no timers, no polling. A refused or no-op apply plans nothing; dry-run only audits (planRestart writes the audit line).

const childProcess = require('child_process');
const { applyCode } = require('./node-code-apply');
const { planRestart } = require('./node-code-restart');

const PULL_MODES = ['off', 'dry-run', 'on'];

// Default run: stdout of a command, no shell.
function defaultRun(cmd, args) {
  return childProcess.execFileSync(cmd, args, { encoding: 'utf8' });
}

// 'off' | 'dry-run' | 'on'; exact match only, anything else is 'off'.
function pullMode(env = process.env) {
  const raw = env ? env.AGENT_MANAGER_CODE_PULL : undefined;
  return PULL_MODES.includes(raw) ? raw : 'off';
}

// Pulls code into nodeRepoDir from inDir. deps: env, run, runStatus, repo (passed to applyCode), pipelineDir, fs, now (passed to planRestart).
// Returns { mode: 'off', applied: false } when off; otherwise { mode, ...applyCode result, planned } where planned is true when planRestart was called.
// applyCode errors propagate; planRestart never throws.
function pullCode(inDir, nodeRepoDir, deps = {}) {
  const mode = pullMode(deps.env || process.env);
  if (mode === 'off') return { mode, applied: false };
  const run = deps.run || defaultRun;
  const oldSha = run('git', ['-C', nodeRepoDir, 'rev-parse', 'HEAD']).trim();
  const result = applyCode(inDir, nodeRepoDir, { ...deps, run });
  if (!result || result.applied !== true) return { mode, ...result, planned: false };
  planRestart({ repoDir: nodeRepoDir, oldSha, newSha: result.sha, pipelineDir: deps.pipelineDir, mode, run, fs: deps.fs, now: deps.now });
  return { mode, ...result, planned: true };
}

module.exports = { pullCode, pullMode };
