'use strict';

// Thin wrapper over the `claude` CLI's non-interactive mode (`claude -p`), matching
// local-client.js's exact interface (`{ call, callOnce, majorityVote, detectDegenerate }`)
// so it's a drop-in swap for `localCall`/`localMajorityVote` at local-draft.js's and
// review-task.js's existing injection points (`draftTask(task, { localCall = call, ... })`)
// -- see model-provider.js for the per-task-source selection that actually wires this in.
//
// The whole point of this module is running against a Claude Pro/Max/Team/Enterprise
// SUBSCRIPTION, never the metered pay-per-token Console API -- see ADR-none-yet /
// 2026-08-16 session notes. Two real footguns make that easy to get wrong silently:
//
//   1. `claude --bare` (the CLI's own documented recommendation for scripted/CI use,
//      for faster startup and determinism) does NOT read CLAUDE_CODE_OAUTH_TOKEN at
//      all -- only ANTHROPIC_API_KEY. Passing --bare here would silently either fail
//      auth or, worse, pick up a stray ANTHROPIC_API_KEY and bill the metered API
//      instead. This module deliberately never passes --bare.
//   2. Auth precedence: if ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is present in
//      the environment AT ALL, Claude Code uses it INSTEAD of the subscription OAuth
//      token, automatically, with no prompt, in non-interactive mode -- "the key is
//      always used when present" per the CLI's own auth-precedence docs. That is
//      exactly the "get hit with API usage bills" outcome this integration exists to
//      avoid. So: refuse to run at all if CLAUDE_CODE_OAUTH_TOKEN isn't set (fail
//      loud, not a silent fallback), AND strip ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN
//      from the CHILD PROCESS's env unconditionally, regardless of why they might be
//      set in the pipeline's own environment for some unrelated reason.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectDegenerate } = require('./local-client.js');
const { wrapWithSandbox } = require('./sandbox.js');

const CLAUDE_BIN = process.env.CLAUDE_CLI_BIN || 'claude';
const MODEL = process.env.CLAUDE_MODEL || 'sonnet';
// Claude Code turns can legitimately run minutes on hard tasks per its own docs, but
// every call here is --max-turns 1 with no tools -- a single completion, not an agentic
// loop -- so this is sized closer to local-client.js's own REQUEST_TIMEOUT_MS (240s)
// than to an open-ended agent run. Configurable for slower/loaded accounts.
const REQUEST_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 300_000;
const MAX_BUDGET_USD = process.env.CLAUDE_MAX_BUDGET_USD || '';
// Bounds what a read-only tool under --permission-mode dontAsk's "read-only command
// set" carve-out could see, regardless of --allowedTools -- an empty scratch dir has
// nothing sensitive in it even if some read-only capability slips through. Defense in
// depth, not the primary control (the primary control is not granting tools at all).
// A caller that explicitly wants real tool access against a real project (see
// callOnce's own `cwd` param) is deliberately opting out of this isolation -- that's
// the whole point of passing both allowedTools and cwd together.
const CLAUDE_CWD = process.env.CLAUDE_CWD || path.join(os.tmpdir(), 'agent-manager-claude-client-scratch');

function assertSubscriptionAuthAvailable() {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      'claude-client.js: CLAUDE_CODE_OAUTH_TOKEN is not set. Generate a subscription-billed, ' +
      'non-interactive token once with `claude setup-token` (requires being logged into a ' +
      'Pro/Max/Team/Enterprise account) and export it as CLAUDE_CODE_OAUTH_TOKEN before ' +
      'starting the pipeline. This module refuses to call `claude -p` without it rather than ' +
      'risk silently falling through to metered API billing -- see this file\'s header comment.'
    );
  }
}

// Returns a copy of process.env with ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN removed --
// unconditionally, not just when CLAUDE_CODE_OAUTH_TOKEN is also present -- because
// Claude Code's own auth precedence puts either of those ABOVE the subscription OAuth
// token. Warns (does not throw) when it actually had to strip something: stripping
// already neutralizes the billing risk for this one subprocess call, and a leftover
// ANTHROPIC_API_KEY in the parent shell may exist for an entirely unrelated tool --
// throwing here would break the whole pipeline over something already handled.
function buildChildEnv() {
  const env = { ...process.env };
  const stripped = [];
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    if (env[key]) {
      delete env[key];
      stripped.push(key);
    }
  }
  if (stripped.length > 0) {
    console.error(`[claude-client] stripped ${stripped.join(', ')} from the child process's env to force subscription billing via CLAUDE_CODE_OAUTH_TOKEN (see this file's header comment)`);
  }
  return env;
}

async function callOnce({ prompt, model, effort, maxTurns = 1, allowedTools, permissionMode = 'dontAsk', cwd, timeoutMs, sandbox, resume }) {
  assertSubscriptionAuthAvailable();
  // cwd lets a caller run this against a real project directory instead of the
  // isolated scratch dir -- e.g. the dashboard's Discuss sessions (2026-08-17, brain-
  // dump entry: "Claude in the agent-manager has no access to... the system it's
  // housed inside") pass the active project's repoRoot here alongside a read-only
  // allowedTools list, so Read/Grep/Glob actually resolve real files instead of an
  // empty directory. Falls back to CLAUDE_CWD (the isolated scratch dir) for every
  // caller that doesn't explicitly ask for this -- the existing, safer default.
  const workDir = cwd || CLAUDE_CWD;
  fs.mkdirSync(workDir, { recursive: true });

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', model || MODEL,
    '--max-turns', String(maxTurns),
    '--permission-mode', permissionMode,
  ];
  // low/medium/high/xhigh/max -- see CLI --effort. Falls back to the CLI's own default
  // (currently "high") when neither the call site nor CLAUDE_EFFORT sets one, same
  // "don't invent a value the caller didn't ask for" reasoning as `model` above.
  const effortLevel = effort || process.env.CLAUDE_EFFORT;
  if (effortLevel) args.push('--effort', effortLevel);
  // No --allowedTools by default -- this module is used as a plain text-completion
  // backend (drafting/critiquing/reviewing prompt text), the same shape as Ollama's
  // /api/generate, not an agentic session. Callers that genuinely need tool access can
  // pass allowedTools explicitly.
  //
  // But leaving tools implicitly available (the CLI's own default) combined with
  // --max-turns 1 is a live footgun, confirmed 2026-08-16: a prompt that reads as a
  // request to go investigate something (a Discuss reply like "please look it up and
  // see if we can find usable information") pushes the model to attempt a built-in
  // tool call (e.g. WebFetch) as its one turn instead of returning text, and the CLI
  // then exits with "Reached maximum number of turns (1)" -- the raw JSON of that
  // error is what a caller (e.g. discuss_sessions.py) sees, with no completion at all.
  // When the caller hasn't opted into tools via allowedTools, explicitly pass
  // `--tools ''` (the CLI's own documented way to disable the built-in set entirely,
  // distinct from --allowedTools which only narrows an already-available set) so a
  // plain-text-completion call can never spend its single turn attempting a tool call
  // it was never meant to have.
  if (allowedTools) {
    args.push('--allowedTools', allowedTools);
  } else {
    args.push('--tools', '');
  }
  if (MAX_BUDGET_USD) args.push('--max-budget-usd', MAX_BUDGET_USD);
  // 2026-08-24 (Ghost panel, Brain Dump #153: "very similar to the claude terminal I have
  // been using externally") -- resume threads --resume <sessionId> so the CLI's OWN
  // session storage carries real conversation context forward between calls, instead of
  // every caller having to rebuild a full prompt+transcript from scratch each turn the
  // way discuss_sessions.py's Discuss/Grill callers already do. `result.sessionId` from a
  // prior callOnce() (parsed.session_id, already returned below) is what a caller passes
  // back in here for its next message.
  if (resume) args.push('--resume', resume);

  // sandbox (2026-08-24, sandbox.js): only adhoc-agentic-draft.js's agentic call passes
  // this -- the one real Bash-capable, unattended tool-use path in this codebase (see
  // sandbox.js's own header). Every other caller omits it and this branch never runs,
  // completely unchanged behavior. Fails OPEN with a flagged return field, not closed --
  // a hardening layer on top of existing behavior must never become a new single point of
  // failure that halts real work; the caller (adhoc-agentic-draft.js) is responsible for
  // surfacing sandboxUnavailable somewhere visible (task.sandboxUnavailable) rather than
  // silently degrading.
  let execBin = CLAUDE_BIN;
  let execArgs = args;
  let sandboxUnavailable = false;
  if (sandbox) {
    const wrapped = wrapWithSandbox(CLAUDE_BIN, args, { workDir, ...sandbox });
    if (wrapped.available) {
      execBin = wrapped.command;
      execArgs = wrapped.args;
    } else {
      sandboxUnavailable = true;
      console.error('[claude-client] sandbox requested but bwrap is not available on this host -- running unsandboxed (see sandbox.js AGENT_MANAGER_ADHOC_SANDBOX)');
    }
  }

  let stdout;
  try {
    stdout = execFileSync(execBin, execArgs, {
      encoding: 'utf8',
      // timeoutMs lets a caller running a genuinely long agentic session (real
      // Read/Grep/Glob/Edit/Write/Bash investigation + implementation + test runs, not
      // this module's usual single-completion call) override the 300s default sized for
      // that ordinary case -- see adhoc-agentic-draft.js, the first caller that needs it.
      timeout: timeoutMs || REQUEST_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      cwd: workDir,
      env: buildChildEnv(),
    });
  } catch (e) {
    const detail = (e.stdout || e.stderr || e.message || '').toString().slice(0, 2000);
    throw new Error(`claude -p failed: ${detail}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`claude -p returned non-JSON output with --output-format json: ${stdout.slice(0, 500)}`);
  }

  return {
    response: parsed.result || '',
    thinking: '',
    // total_cost_usd is a client-side estimate per Claude Code's own docs, and is
    // largely moot here anyway since a subscription-authenticated call isn't billed
    // per-token -- kept only as an observability breadcrumb, never treated as billing.
    costUsd: parsed.total_cost_usd,
    sessionId: parsed.session_id,
    // stopReason/numTurns (2026-08-23, Grimmethy: "Fix: Claude agentic adhoc drafts that
    // exhaust their turn budget get blindly retried at the same budget, wasting real
    // spend") -- previously discarded entirely, even though the raw CLI JSON always
    // carries them (confirmed live in a real failure: stop_reason":"tool_use",
    // "num_turns":31). Without these, a caller has no way to tell "ran out of turns
    // mid-investigation" apart from any other incomplete response -- see
    // adhoc-agentic-draft.js's own turn-exhaustion retry, the first real consumer.
    stopReason: parsed.stop_reason || null,
    numTurns: parsed.num_turns != null ? parsed.num_turns : null,
    sandboxUnavailable,
  };
}

// Same retry-on-degenerate shape as local-client.js's call() -- reuses that module's
// detectDegenerate() rather than duplicating the heuristics, since garbage output
// (empty, repeated-character, repetition-loop, non-ascii-gibberish) is a property of
// what counts as a usable response, not of which backend produced it.
async function call(opts, maxRetries = 2) {
  let lastDegenerate = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await callOnce(opts);
    const degenerate = detectDegenerate(result.response, { allowEmpty: opts.allowEmpty });
    if (!degenerate) return { ...result, degenerate: null, attempts: attempt + 1 };
    lastDegenerate = degenerate;
  }
  return { response: '', thinking: '', degenerate: lastDegenerate, attempts: maxRetries + 1 };
}

// Mirrors local-client.js's majorityVote() exactly (same signature, same tally logic)
// so review-task.js's localMajorityVote injection point works unchanged with this
// module swapped in -- duplicated rather than imported since local-client.js's version
// calls its own local `call` directly with no injection seam of its own. Still true as
// of 2026-08-24 (model-profile-registry.js) -- not consolidated, deliberately deferred,
// see that file's own header. model/effort/timeoutMs added here for profile support --
// no numCtx/numPredict equivalent exists on this module's own callOnce() (a Claude Code
// CLI call, not a raw Ollama /api/generate), so those two are local-client.js-only.
async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2, model, effort, timeoutMs }) {
  const votes = [];
  for (let i = 0; i < n; i++) {
    const result = await call({ prompt, think: false, temperature, model, effort, timeoutMs }, 1);
    if (result.degenerate) continue;
    const verdict = classify(result.response);
    if (verdict) votes.push({ verdict, response: result.response });
  }

  const tally = {};
  for (const v of votes) tally[v.verdict] = (tally[v.verdict] || 0) + 1;

  let winner = null;
  let winnerCount = 0;
  for (const [verdict, count] of Object.entries(tally)) {
    if (count > winnerCount) {
      winner = verdict;
      winnerCount = count;
    }
  }

  return {
    verdict: winnerCount >= minAgreeing ? winner : null,
    confident: winnerCount >= minAgreeing,
    votes,
    realVoteCount: votes.length,
    requestedVotes: n,
  };
}

module.exports = { call, callOnce, majorityVote, detectDegenerate, assertSubscriptionAuthAvailable };

// CLI: node claude-client.js <request.json>
// request.json: { prompt, model, maxTurns, allowedTools, permissionMode, maxRetries,
//                 mode: "single" | "majority-vote", classifyMarkers: [string, ...] }
// Writes the JSON result to stdout. Mirrors local-client.js's own CLI shape.
if (require.main === module) {
  const requestPath = process.argv[2];
  if (!requestPath) {
    console.error('usage: node claude-client.js <request.json>');
    process.exit(1);
  }
  const req = JSON.parse(fs.readFileSync(requestPath, 'utf8'));

  (async () => {
    try {
      if (req.mode === 'majority-vote') {
        const markers = req.classifyMarkers || [];
        const minReasoningChars = req.minReasoningChars || 0;
        const classify = (text) => {
          const lower = text.toLowerCase();
          const marker = markers.find((m) => lower.includes(m.toLowerCase()));
          if (!marker) return null;
          if (minReasoningChars > 0) {
            const stripped = text.replace(new RegExp(marker + '\\s*:?', 'i'), '').trim();
            if (stripped.length < minReasoningChars) return null;
          }
          return marker;
        };
        const result = await majorityVote({ ...req, classify });
        process.stdout.write(JSON.stringify(result));
      } else {
        const result = await call(req, req.maxRetries ?? 2);
        process.stdout.write(JSON.stringify(result));
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
