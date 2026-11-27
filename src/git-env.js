'use strict';

// Single home for how this package shells out to git non-interactively: the env that
// disables credential prompts, and a small synchronous runner built on it.

const { execFileSync } = require('child_process');
const { gitTimeoutMs } = require('./lib/git-timeout.js');   // AGENT_MANAGER_GIT_TIMEOUT_MS (default 60000), read on each call

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};

// Runs `git <args>` in `cwd` and returns stdout as a utf8 string; throws on a non-zero exit.
// `extra` is merged into the execFileSync options (e.g. { maxBuffer }).
function runGit(args, cwd, extra = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: gitTimeoutMs(), ...extra });
}

module.exports = { GIT_ENV, runGit };
