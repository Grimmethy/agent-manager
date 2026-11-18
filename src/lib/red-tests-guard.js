'use strict';

// red-tests-guard.js: guards the agent loop against a red test result that
// survives until the final answer. The rule:
//
//   1. A failing recognised test run sets the guard to RED and records the
//      command and the red tail (last ~500 chars of output).
//   2. A later green run of the same command, or a superset of it, clears
//      RED.
//   3. A RED run that occurs BEFORE any file mutation is a "baseline": it
//      is accepted only when the agent's final text contains a line
//       BASELINE-RED: <command>
//      that matches the baseline command (after normalisation).
//   4. A RED run AFTER a file mutation is always blocking, even if a
//      BASELINE-RED line is present.
//
// The guard is inert when the environment variable
// AGENT_MANAGER_RED_TESTS_GUARD is set to the literal string "off".
// Otherwise (unset or any other value) the guard is active.
//
// No polling, no timers, no model calls. Synchronous callback surface
// called from the tool loop (sibling 3/4).

const { classifyTestCommand, isRedRun, tailOf, normaliseCommand } = require('./test-command-recogniser.js');

const MUTATION_TOOLS = ['write_file', 'edit_file'];
const RED_TAIL_LEN = 500;

function isOff(env) {
  return env && String(env.AGENT_MANAGER_RED_TESTS_GUARD) === 'off';
}

function createRedTestsGuard(env) {
  const flagOff = isOff(env);
  let red = false;
  let redCommand = null;
  let redTail = '';
  let baseline = false;
  let mutated = false;

  function resetSnapshot() {
    return { red, redCommand, redTail, baseline };
  }

  function observe(toolName, args, result) {
    if (flagOff) return;

    // Detect mutations.
    if (MUTATION_TOOLS.includes(toolName)) {
      mutated = true;
    }

    // Classify the result.
    const cmd = args && args.command;
    if (!cmd) return;
    const classification = classifyTestCommand(cmd);
    if (!classification.isTest) return;

    const isRed = isRedRun({ command: cmd, output: args.output || result?.output || '', exitCode: args.exitCode ?? result?.exitCode });
    if (isRed) {
      red = true;
      redCommand = normaliseCommand(cmd);
      redTail = tailOf(args.output || result?.output || '', RED_TAIL_LEN);
      if (!mutated) {
        baseline = true;
      } else {
        baseline = false;
      }
    } else {
      // Green run: clear red only if it matches the current red command or is a superset.
      if (red) {
        const norm = normaliseCommand(cmd);
        if (norm === redCommand || isSupersetOf(norm, redCommand)) {
          red = false;
          redCommand = null;
          redTail = '';
          baseline = false;
        }
      }
    }
  }

  function isSupersetOf(a, b) {
    // Treat a as a superset of b if a's normalised tokens include all of b's
    // leading framework tokens. Conservative check: a starts with b.
    if (!b) return false;
    return a.startsWith(b) || a === b;
  }

  function blockReason(finalText) {
    if (flagOff) return '';
    if (!red) return '';

    // Baseline path: red before mutation, check for honest declaration.
    if (baseline && redCommand) {
      const text = String(finalText || '');
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('BASELINE-RED:')) {
          const declared = normaliseCommand(trimmed.slice('BASELINE-RED:'.length).trim());
          if (declared === redCommand) {
            return '';
          }
        }
      }
    }

    // Blocking: quote the red tail and tell the agent to fix or finish with
    // an honest blocked resolution.
    const tail = redTail || '(no output captured)';
    return (
      `Blocked: last test run was red.\n` +
      `Command: ${redCommand || '(unknown)'}\n` +
      `Tail:\n${tail}\n` +
      `Fix the failure, or finish with an honest blocked resolution that declares BASELINE-RED: ${redCommand}.`
    );
  }

  function state() {
    return resetSnapshot();
  }

  return { observe, blockReason, state };
}

module.exports = { createRedTestsGuard };
