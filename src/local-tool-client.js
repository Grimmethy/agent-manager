'use strict';

// Multi-turn tool-calling loop for a plan pass, giving it a real, narrow, read-only
// codebase-search capability via grep-codebase-tool.js. Unlike local-client.js (which only
// ever calls Ollama's /api/generate -- a single prompt-in, text-out call with no structured
// tool support), this hits /api/chat, the endpoint that actually supports Ollama's tools
// array and tool_calls response field.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { grepCodebase } = require('./grep-codebase-tool.js');
const { getConfig } = require('./config.js');
const { postJson, postJsonStream } = require('./ollama-http.js');
const { wrapWithSandbox } = require('./sandbox.js');
const { withLock } = require('./single-flight-lock.js');
const { PINNED_NUM_CTX } = require('./gpu-capacity.js');

// Read-only file-exploration tools (2026-08-22, Grimmethy: "expand the tooling
// capabilities so that the local reasoning model can handle the work... I'd like to see
// the automated work being handled entirely locally") -- read_file/list_directory,
// alongside the pre-existing grep_codebase above. Deliberately READ-ONLY: no write_file,
// edit_file, or shell-execution tool exists here, and none should be added to this loop --
// a local model is materially less reliable at agentic tool use than Claude (real
// documented incident: a tool-calling call once stalled 13+ minutes with no progress, see
// docs/pipeline-incident-2026-07-19.md and local-worker.ps1's own comment on why this
// whole mechanism was disabled), so direct file-mutation/shell power here is a materially
// bigger risk than read-only exploration. Any real file change a caller of this loop
// produces still goes through the EXISTING, already-audited apply pipeline (see
// group-b-worktree-diff.js) -- never a tool that writes to disk or executes commands.

// Same repo-root escape guard task-sources.js's nextCandidateFulfillmentTask() already
// uses for its own fetchedFiles -- reused rather than a second, possibly-inconsistent
// guard (both this file's own header and that function's comment insist on this).
function resolveInsideRepo(repoRoot, relPath) {
  const rootResolved = path.resolve(repoRoot);
  const full = path.resolve(repoRoot, relPath || '');
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

// Same cap/truncation-suffix convention as nextCandidateFulfillmentTask()'s own
// MAX_FETCHED_FILE_CHARS -- one huge file must not blow the model's context or the /api/chat
// response payload.
const MAX_READ_FILE_CHARS = 8000;

function readFileTool({ path: relPath }) {
  const { repoRoot } = getConfig();
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { error: 'read_file requires a non-empty "path" argument' };
  }
  const full = resolveInsideRepo(repoRoot, relPath);
  if (!full) {
    return { error: `path escapes the repo root, refusing to read: ${relPath}` };
  }
  let content;
  try {
    content = fs.readFileSync(full, 'utf8');
  } catch (e) {
    return { error: `could not read ${relPath}: ${e.message}` };
  }
  const truncated = content.length > MAX_READ_FILE_CHARS;
  return {
    path: relPath,
    content: truncated ? `${content.slice(0, MAX_READ_FILE_CHARS)}\n...[truncated]` : content,
    truncated,
  };
}

function listDirectoryTool({ path: relPath }) {
  const { repoRoot } = getConfig();
  const target = typeof relPath === 'string' && relPath.trim() ? relPath : '.';
  const full = resolveInsideRepo(repoRoot, target);
  if (!full) {
    return { error: `path escapes the repo root, refusing to list: ${target}` };
  }
  let entries;
  try {
    entries = fs.readdirSync(full, { withFileTypes: true });
  } catch (e) {
    return { error: `could not list ${target}: ${e.message}` };
  }
  // Names and kind only -- deliberately not a recursive full-tree dump (see this file's
  // own header: keep this simple, list_directory is one shallow level per call).
  return {
    path: target,
    entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
  };
}

// 2026-08-24 (Chat panel, Brain Dump #153, Grimmethy: explicitly chose real local-model
// write access despite the read-only-only design above) -- write_file/edit_file/run_bash
// are kept SEPARATE from TOOLS/TOOL_HANDLERS below, not merged into them: the existing
// arch_discovery caller (runPlanWithTools({..., allowWrite: false})) must stay exactly
// as read-only as it is today, unaffected by this. A Chat caller opts in explicitly via
// allowWrite: true. This is the mitigation for the exact documented failure mode that
// justified read-only-only in the first place (a stalled 13+-minute tool-calling call,
// see this file's own header) -- not a bare capability grant:
//   - a SEPARATE kill switch (queue/.chat-write-tools-disabled) from arch_discovery's own
//     queue/.arch-discovery-tools-disabled, checked only when allowWrite is requested
//   - run_bash executes under sandbox.js's bwrap wrapper (the same real isolation the one
//     other Bash-capable, materially-less-reliable-than-Claude actor in this codebase --
//     adhoc-agentic-draft.js's Claude call -- already gets), with its own short per-command
//     timeout well inside the overall REQUEST_TIMEOUT_MS budget
//   - maxTurns stays caller-controlled and should be kept tight for Chat callers (see
//     chat_sessions.py)
const CHAT_BASH_TIMEOUT_MS = 30_000;

function writeFileTool({ path: relPath, content }) {
  const { repoRoot } = getConfig();
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { error: 'write_file requires a non-empty "path" argument' };
  }
  const full = resolveInsideRepo(repoRoot, relPath);
  if (!full) {
    return { error: `path escapes the repo root, refusing to write: ${relPath}` };
  }
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : '');
  } catch (e) {
    return { error: `could not write ${relPath}: ${e.message}` };
  }
  return { path: relPath, written: true };
}

function editFileTool({ path: relPath, find, replace }) {
  const { repoRoot } = getConfig();
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { error: 'edit_file requires a non-empty "path" argument' };
  }
  if (typeof find !== 'string' || find === '') {
    return { error: 'edit_file requires a non-empty "find" argument' };
  }
  const full = resolveInsideRepo(repoRoot, relPath);
  if (!full) {
    return { error: `path escapes the repo root, refusing to edit: ${relPath}` };
  }
  let content;
  try {
    content = fs.readFileSync(full, 'utf8');
  } catch (e) {
    return { error: `could not read ${relPath}: ${e.message}` };
  }
  if (!content.includes(find)) {
    return { error: `"find" text not found verbatim in ${relPath} -- no change made. Re-read the file and match it exactly.` };
  }
  const occurrences = content.split(find).length - 1;
  if (occurrences > 1) {
    return { error: `"find" text matches ${occurrences} places in ${relPath} -- make it unique (include more surrounding context) before editing.` };
  }
  const updated = content.replace(find, replace || '');
  try {
    fs.writeFileSync(full, updated);
  } catch (e) {
    return { error: `could not write ${relPath}: ${e.message}` };
  }
  return { path: relPath, edited: true };
}

// 2026-08-24 -- caught live within minutes of the Chat panel shipping: app.py used to
// wrap chat_sessions.send_message()'s ENTIRE call in the same git-safety mutex
// apply-task.sh/api_git_merge_branch use, held for however long the whole turn took
// (a local-provider turn can legitimately wait minutes on the GPU lock alone) even
// though most turns never touch git at all -- a second, unrelated Chat message got
// "the pipeline is mid-apply right now" while nothing was actually applying. Moved the
// real protection down to HERE, the one place in this module that can actually run a
// git-mutating command, held only around the single execFileSync call below -- not the
// surrounding sandbox setup, not the calling turn. Same fixed lockfile
// apply-task.sh/api_git_merge_branch already flock (cross-language-compatible, same
// mechanism proven interoperable all session), acquired via the identical
// open-fd-then-flock-the-child pattern single-flight-lock.js already uses for its own
// (different) lock file.
const APPLY_LOCK_PATH = path.join(os.homedir(), '.local', 'state', 'agent-manager', 'locks', 'apply-task.lock');
const APPLY_LOCK_CHILD_FD = 3;

function withApplyLock(fn) {
  fs.mkdirSync(path.dirname(APPLY_LOCK_PATH), { recursive: true });
  const fd = fs.openSync(APPLY_LOCK_PATH, 'w');
  try {
    execFileSync('flock', [String(APPLY_LOCK_CHILD_FD)], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    return fn();
  } finally {
    fs.closeSync(fd);
  }
}

function runBashTool({ command }) {
  const { repoRoot } = getConfig();
  if (typeof command !== 'string' || !command.trim()) {
    return { error: 'run_bash requires a non-empty "command" argument' };
  }
  const realRepoRoot = fs.realpathSync(repoRoot);
  const wrapped = wrapWithSandbox('bash', ['-c', command], {
    workDir: realRepoRoot,
    readOnlyBinds: ['/usr', '/bin', '/lib', '/lib64', '/etc/resolv.conf', '/etc/ssl'],
    // The whole live repo, writable -- unlike adhoc-agentic-draft.js's throwaway
    // worktree, Chat edits are meant to land directly on the real working tree (see
    // this feature's own plan: "the same trust model as this session itself").
    writableBinds: [realRepoRoot],
  });
  if (!wrapped.available) {
    // Fails CLOSED here, not open -- unlike the Claude adhoc path (a hardening layer on
    // top of an already-trusted actor), an unsandboxed local-model Bash call is new,
    // meaningfully riskier territory this codebase has never granted before. No bwrap,
    // no local-model shell access, full stop.
    return { error: 'sandbox (bwrap) is not available on this host -- run_bash is disabled without it' };
  }
  try {
    const stdout = withApplyLock(() => execFileSync(wrapped.command, wrapped.args, {
      encoding: 'utf8', timeout: CHAT_BASH_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    }));
    return { command, stdout, exitCode: 0 };
  } catch (e) {
    return {
      command,
      stdout: (e.stdout || '').toString(),
      stderr: (e.stderr || e.message || '').toString().slice(0, 2000),
      exitCode: e.status != null ? e.status : null,
      timedOut: e.signal === 'SIGTERM' && e.killed === true,
    };
  }
}

const WRITE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or overwrite an existing one with the given content, given a path relative to the repo root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the repo root.' },
          content: { type: 'string', description: 'Full file content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one exact, unique occurrence of "find" with "replace" in an existing file. Fails if "find" is not found verbatim or matches more than once -- include enough surrounding context to make it unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the repo root.' },
          find: { type: 'string', description: 'Exact text to find, must match verbatim and uniquely.' },
          replace: { type: 'string', description: 'Text to replace it with.' },
        },
        required: ['path', 'find', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_bash',
      description: 'Run a shell command in the repo root, inside a filesystem sandbox. Use for git operations, running tests, or anything read_file/write_file/edit_file cannot do directly.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
        },
        required: ['command'],
      },
    },
  },
];

const WRITE_TOOL_HANDLERS = {
  write_file: (args) => writeFileTool({ path: args.path, content: args.content }),
  edit_file: (args) => editFileTool({ path: args.path, find: args.find, replace: args.replace }),
  run_bash: (args) => runBashTool({ command: args.command }),
};

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
// No hardcoded fallback tag -- see local-client.js's matching comment. An unset
// LOCAL_MODEL now surfaces as a real Ollama "model not found" error, not a guessed name.
const MODEL = process.env.LOCAL_MODEL;

// Matches local-client.js's REQUEST_TIMEOUT_MS exactly -- was 1_800_000 (30 min) under the
// reasoning that a tool-calling turn can legitimately run longer than a plain generation
// call. That reasoning turned out to be actively harmful, not just generous: this exact
// path is why Invoke-LocalToolClient is disabled in local-worker.ps1 (see that file's
// comment) -- a real call through here stalled a worker for 13+ minutes with no progress,
// and a 30-min ceiling meant nothing would have caught it for a very long time if the
// disable hadn't happened first. 5 minutes is the formalized ceiling for every local-model-
// call- or liveness-related timeout in this pipeline as of 2026-07-19 (see
// docs/pipeline-incident-2026-07-19.md and queue-watchdog.ps1's $WorkerZombieThresholdSeconds)
// -- repeated-failure downtime compounds fast, and no legitimate call needs longer than
// this. Do not raise this again "to be safe" without revisiting that reasoning first.
const REQUEST_TIMEOUT_MS = Number(process.env.LOCAL_TIMEOUT_MS || process.env.ORNITH_TIMEOUT_MS) || 240_000;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'grep_codebase',
      description: 'Search the codebase for a text/word match. Returns up to 20 matches with file path and line number.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Plain substring/word to search for.' },
          dir: { type: 'string', description: 'Which source root to search (one of the configured allowed dirs).' },
        },
        required: ['query', 'dir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full content of a real file, given a path relative to the repo root. Content over ~8000 characters is truncated. Read-only -- cannot write or edit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the repo root, e.g. "src/task-sources.js".' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the files and subdirectories directly inside a given path (one level, not recursive), relative to the repo root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the repo root, e.g. "src". Omit or use "." for the repo root itself.' },
        },
        required: [],
      },
    },
  },
];

const TOOL_HANDLERS = {
  grep_codebase: (args) => grepCodebase({ query: args.query, dir: args.dir }),
  read_file: (args) => readFileTool({ path: args.path }),
  list_directory: (args) => listDirectoryTool({ path: args.path }),
};

// One /api/chat turn, normalized to a plain {content, tool_calls} message object
// regardless of whether it streamed or not -- keeps runPlanWithTools' own loop below
// completely unaware of which transport carried the turn.
//
// 2026-08-26 (Chat panel streaming, Grimmethy: "vastly improve the chat system... Open
// WebUI does this over Socket.IO/SSE" -- see that investigation): onChunk, when given,
// switches this turn to Ollama's stream:true NDJSON form and calls onChunk(text) with
// each content delta as it arrives, the same "show it thinking live" fix that made the
// old CHAT_LOCAL_MAX_TURNS "ran out of budget" explainer necessary in the first place --
// a user watching real tokens land never has to wonder if it's hung. Tool-call turns
// still resolve in one shot either way (Ollama emits tool_calls fully-formed, not
// token-by-token), so onChunk simply never fires for those turns.
// 2026-08-26 (Chat panel "stuck thinking" + blank reply, Grimmethy): confirmed live via
// journalctl that the running llama-server was launched with `-c 8192` -- this call path
// never sent an explicit num_ctx at all, so it inherited whatever context size some
// earlier caller happened to establish. A real tool-heavy investigation reached 8033-8114
// tokens against that 8192 ceiling; llama.cpp's own context-shift (`--context-shift --keep
// 4` on the runner) then evicts the OLDEST tokens to make room -- which can shift the
// original user message itself out of the window, matching Ollama's "no user query found
// in messages" check exactly. Confirmed live: this reproduced on a tight loop (succeed,
// hit the ceiling, flake x3, roll back one turn, succeed, immediately hit the ceiling
// again) that never actually escaped the 8192 boundary, burning the whole turn budget on
// churn. gpu-capacity.js's PINNED_NUM_CTX is the SAME hard-won fix local-client.js's own
// /api/generate path already uses for exactly this class of problem (see that module's
// own header: "pin num_ctx to ONE stable value and never vary it by request" -- varying it
// per-call is what causes an expensive reload-triggered hang, not the fix for one).
// Reusing the existing pinned constant instead of picking a new number keeps every local-
// provider caller on the one value this pipeline has already vetted.
async function postChatTurn({ messages, tools, tokenFoldHeaders, onChunk }) {
  if (!onChunk) {
    const res = await postJson(`${OLLAMA_URL}/api/chat`, {
      model: MODEL, messages, tools, stream: false, options: { num_ctx: PINNED_NUM_CTX },
    }, REQUEST_TIMEOUT_MS, tokenFoldHeaders);
    return res.message || {};
  }
  let contentAcc = '';
  let toolCalls = null;
  let streamError = null;
  await postJsonStream(`${OLLAMA_URL}/api/chat`, {
    model: MODEL, messages, tools, options: { num_ctx: PINNED_NUM_CTX },
  }, REQUEST_TIMEOUT_MS, tokenFoldHeaders, (obj) => {
    if (obj.error || obj.done_reason === 'error') {
      streamError = obj.error || obj.done_reason || 'unknown stream error';
      return;
    }
    const msg = obj.message || {};
    if (typeof msg.content === 'string' && msg.content) {
      contentAcc += msg.content;
      onChunk(msg.content);
    }
    if (msg.tool_calls && msg.tool_calls.length) toolCalls = msg.tool_calls;
  });
  if (streamError) throw new Error(streamError);
  return { role: 'assistant', content: contentAcc, tool_calls: toolCalls || undefined };
}

// 2026-08-26 (Chat panel 502, Grimmethy): a real Ollama /api/chat call can
// intermittently come back "Ollama HTTP 500: {"error":"no user query found in
// messages"}". CORRECTED root cause (an earlier version of this comment wrongly
// blamed the vendored TokenFold proxy -- ruled out live: OLLAMA_URL is unset for this
// caller, so TokenFold was never actually in the request path): confirmed via
// `journalctl -u ollama` this is Ollama's OWN renderer failing --
// `source=routes.go:2702 msg="chat prompt error" error="no user query found in
// messages"` -- and confirmed live a SECOND time that it is NOT a live-inference race:
// the failing calls returned in <100ms, far too fast to have reached the model at all,
// and retrying the IDENTICAL messages array failed 3/3 times, deterministically, every
// time. Matches a documented Ollama renderer bug (github.com/ollama/ollama#17647): a
// tool-call-only assistant turn (empty content, just tool_calls) leaves the rendered
// `<think>` block unclosed, and that corruption is baked into the STORED history from
// then on -- every later request that replays it trips the same "no user query" check,
// no matter how many times it's retried unchanged. A plain retry (still done first,
// CHAT_FLAKE_MAX_ATTEMPTS times, in case it's a genuine one-off) can never fix this
// specific shape of failure; only dropping the poisoned turn and making the model
// regenerate it (a fresh sample can easily come out with content this time, or a
// properly-closed think block) can.
const CHAT_FLAKE_MAX_ATTEMPTS = 3;
// Bounded separately from CHAT_FLAKE_MAX_ATTEMPTS -- each rollback re-asks the model to
// redo a whole prior turn (a real generation, not a cheap resend), so this stays small.
const MAX_ROLLBACK_ATTEMPTS = 2;

// Kill switch is set: drop to local-client.js's plain /api/generate call() -- no tools,
// no multi-turn loop. local-client.js's own call() doesn't self-lock, so it's wrapped
// externally here, the same discipline local-draft.js's maybeLocked() applies for its
// own plan pass.
async function runWithoutToolsFallback(prompt, pipelineDir) {
  const { call } = require('./local-client.js');
  const result = await withLock(path.join(pipelineDir, 'instances'), () => call({ prompt, think: true }), MODEL);
  return { response: result.response, toolCallLog: [], turnsUsed: 0, toolsDisabled: true };
}

// Runs one /api/chat turn with the two-layer recovery this call path needs for Ollama's
// "no user query found in messages" renderer bug (see CHAT_FLAKE_MAX_ATTEMPTS' comment):
// retry the identical call CHAT_FLAKE_MAX_ATTEMPTS times first, then -- since that error
// is baked into stored history and a plain retry can never clear it -- roll the
// conversation back to the START of the prior turn (up to MAX_ROLLBACK_ATTEMPTS times) so
// the model regenerates that turn from a fresh sample. Mutates messages / toolCallLog /
// turnStartLengths / turnStartLogLengths in place on each rollback. Returns
// { message } once a call succeeds, or { flakeErr } when both recovery layers are spent.
async function chatTurnWithFlakeRecovery({ messages, tools, tokenFoldHeaders, onChunk, instancesDir, toolCallLog, turnStartLengths, turnStartLogLengths }) {
  let rollbackAttempts = 0;
  for (;;) {
    let message;
    let attemptErr = null;
    for (let attempt = 0; attempt < CHAT_FLAKE_MAX_ATTEMPTS; attempt++) {
      try {
        message = await withLock(instancesDir, () => postChatTurn({ messages, tools, tokenFoldHeaders, onChunk }), MODEL);
        attemptErr = null;
        break;
      } catch (e) {
        if (!/no user query found in messages/i.test(e.message)) throw e;
        attemptErr = e;
      }
    }
    if (!attemptErr) return { message };
    if (rollbackAttempts < MAX_ROLLBACK_ATTEMPTS && turnStartLengths.length >= 2) {
      const priorStart = turnStartLengths[turnStartLengths.length - 2];
      const priorLogStart = turnStartLogLengths[turnStartLengths.length - 2];
      messages.length = priorStart;
      toolCallLog.length = priorLogStart;
      turnStartLengths.pop();
      turnStartLogLengths.pop();
      // NOT decrementing turnsUsed in the caller for this: a rollback still consumes a
      // real outer-loop iteration slot (the `for` loop's own `turn` counter doesn't
      // rewind), so turnsUsed must keep tracking that real count. 2026-08-26 bug, caught
      // live: decrementing it meant a request that repeatedly flaked-rolled-back-
      // succeeded could exhaust the entire maxTurns budget while turnsUsed stayed
      // artificially low -- chat_sessions.py's `turnsUsed >= CHAT_LOCAL_MAX_TURNS` check
      // never fired, so a maxTurns-exhausted call returned a silent BLANK reply instead
      // of the "ran out of its turn budget" explainer.
      rollbackAttempts += 1;
      continue;
    }
    return { flakeErr: attemptErr };
  }
}

// Both recovery layers in chatTurnWithFlakeRecovery are spent, but the model already said
// something real on an earlier turn (already streamed to the browser via onChunk).
// Throwing would silently discard all of that (confirmed live: a whole streamed AC-3
// investigation vanished and the Chat panel quietly rolled back to its pre-message
// state). Append a NEW note explaining the drop -- it needs its own onChunk call since
// the model never said it -- and return the same graceful-degrade shape as the
// maxTurns-reached return.
function flakeDegradeResult(lastMessage, toolCallLog, turnsUsed, onChunk) {
  const note = '\n\n*(Lost the connection to the local model mid-investigation -- '
    + "Ollama's own renderer hit a known intermittent fault. The above is what it "
    + 'had said so far; ask again to let it continue.)*';
  if (onChunk) onChunk(note);
  return {
    response: (lastMessage.content || '') + note,
    toolCallLog, turnsUsed: Math.max(turnsUsed - 1, 0), toolsDisabled: false,
  };
}

// Runs every tool call the model made this turn: appends the assistant turn, then one
// tool-result message (and one toolCallLog entry) per call. A malformed/unknown/throwing
// tool call degrades to an error STRING result the model can see and correct on its next
// turn -- never a thrown exception that would kill the whole loop (see this file's header:
// one bad tool call should never crash the entire draft attempt).
function executeToolCalls(assistantMessage, toolCalls, toolHandlers, messages, toolCallLog) {
  messages.push(assistantMessage);
  for (const toolCall of toolCalls) {
    const name = toolCall.function && toolCall.function.name;
    const args = (toolCall.function && toolCall.function.arguments) || {};
    const handler = toolHandlers[name];
    let result;
    if (!handler) {
      result = { error: `unknown tool: ${name}` };
    } else {
      try {
        result = handler(args);
      } catch (e) {
        result = { error: `tool ${name} failed: ${e.message}` };
      }
    }
    toolCallLog.push({ tool: name, args, result });
    messages.push({ role: 'tool', content: JSON.stringify(result) });
  }
}

async function runPlanWithTools({ prompt, messages: reqMessages, maxTurns = 5, source, allowWrite = false, onChunk }) {
  const { pipelineDir } = getConfig();
  // allowWrite=true (Chat panel only) checks its OWN kill switch, separate from
  // arch_discovery's -- see WRITE_TOOLS' own header for why these must stay independent.
  const killSwitchPath = path.join(pipelineDir, 'queue',
    allowWrite ? '.chat-write-tools-disabled' : '.arch-discovery-tools-disabled');
  if (fs.existsSync(killSwitchPath)) {
    return runWithoutToolsFallback(prompt, pipelineDir);
  }

  const tools = allowWrite ? [...TOOLS, ...WRITE_TOOLS] : TOOLS;
  const toolHandlers = allowWrite ? { ...TOOL_HANDLERS, ...WRITE_TOOL_HANDLERS } : TOOL_HANDLERS;
  // 2026-08-24 -- caught live via the Chat panel's first real message: this loop's own
  // /api/chat calls had NO coordination with worker-1/reviewer's use of the same single
  // resident Ollama model, the exact uncoordinated-contention bug the Discuss-side lock
  // work earlier tonight was built to fix, just reintroduced through a different call
  // path. Same instancesDir derivation and withLock() usage local-draft.js's own
  // maybeLocked() already establishes -- held ONLY around each individual /api/chat call
  // (in chatTurnWithFlakeRecovery), not the whole multi-turn loop (tool execution between
  // turns doesn't touch the GPU and shouldn't block other lanes while it runs).
  const instancesDir = path.join(pipelineDir, 'instances');

  // Same TokenFold session/scope headers local-client.js sends on /api/generate.
  // Without the session header every /api/chat call hashed into its own one-off
  // TokenFold session, so the dictionary bootstrap's one-time cost could never
  // amortize across the tool loop's turns -- the exact traffic shape (one prompt
  // re-sent with growing history each turn) where session continuity pays most.
  const tokenFoldHeaders = { 'X-TokenFold-Session': `agent-manager-${process.env.AGENT_MANAGER_INSTANCE_ID || 'default'}` };
  if (source) tokenFoldHeaders['X-TokenFold-Scope'] = source;

  // 2026-08-26 (Chat panel, Grimmethy: "vastly improve the chat system... Open WebUI"
  // investigation) -- callers with real conversation history now pass a proper per-turn
  // `messages` array (chat_sessions.py builds it with real system/user/assistant roles)
  // instead of chat_sessions.py's old approach of flattening the whole transcript into
  // one giant string inside a single {role:'user'} message. Plain single-shot callers
  // (local-agentic-draft.js) still pass `prompt` and get the old one-message behavior,
  // unchanged.
  const messages = Array.isArray(reqMessages) && reqMessages.length
    ? reqMessages.slice()
    : [{ role: 'user', content: prompt }];
  const toolCallLog = [];
  let turnsUsed = 0;
  let lastMessage = null;

  // messages.length / toolCallLog.length as of the START of each turn, in order -- lets a
  // later turn's unrecoverable flake roll back exactly the PRIOR turn's own additions
  // (the ones most likely to be the corrupting tool-call-only turn) rather than just the
  // current turn's, since the corruption always lives in already-stored history, never in
  // the turn that's actively failing.
  const turnStartLengths = [];
  const turnStartLogLengths = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    turnsUsed = turn + 1;
    turnStartLengths.push(messages.length);
    turnStartLogLengths.push(toolCallLog.length);

    const { message, flakeErr } = await chatTurnWithFlakeRecovery({
      messages, tools, tokenFoldHeaders, onChunk, instancesDir,
      toolCallLog, turnStartLengths, turnStartLogLengths,
    });
    if (flakeErr) {
      // Rollback exhausted too (or there was no prior turn to roll back -- a first-turn
      // failure is a genuinely different, unexplained case). Graceful-degrade if the
      // model already produced real content on an earlier turn; otherwise rethrow.
      if (lastMessage) return flakeDegradeResult(lastMessage, toolCallLog, turnsUsed, onChunk);
      throw flakeErr;
    }

    lastMessage = message;
    const toolCalls = message.tool_calls || [];
    if (toolCalls.length === 0) {
      return { response: message.content || '', toolCallLog, turnsUsed, toolsDisabled: false };
    }
    executeToolCalls(message, toolCalls, toolHandlers, messages, toolCallLog);
  }

  // maxTurns reached without a final (no-tool-calls) response -- deliberate forced stop,
  // not a crash, matching how this pipeline already treats an empty/degenerate plan pass.
  return { response: (lastMessage && lastMessage.content) || '', toolCallLog, turnsUsed, toolsDisabled: false };
}

module.exports = {
  runPlanWithTools, readFileTool, listDirectoryTool, resolveInsideRepo, TOOLS,
  writeFileTool, editFileTool, runBashTool, WRITE_TOOLS,
  withApplyLock, APPLY_LOCK_PATH,
};

// CLI: node local-tool-client.js <request.json>
// request.json: { prompt, maxTurns, source?, allowWrite? }  (source: task type, keys the
// per-task-type TokenFold dictionary -- same meaning as local-client.js's source.
// allowWrite: Chat panel only, see WRITE_TOOLS' own header)
// Writes the JSON result to stdout.
if (require.main === module) {
  const requestPath = process.argv[2];
  if (!requestPath) {
    console.error('usage: node local-tool-client.js <request.json>');
    process.exit(1);
  }
  const req = JSON.parse(fs.readFileSync(requestPath, 'utf8'));

  // req.stream: true (Chat panel only, local_tool_client.py's stream_plan_with_tools) --
  // instead of one final JSON blob on stdout, write one NDJSON line per content chunk as
  // it arrives ({"type":"chunk","text":...}), then exactly one closing
  // {"type":"final", ...same shape runPlanWithTools always returns}. Non-streaming
  // callers (arch_discovery, local-agentic-draft.js's one-shot drafts) are completely
  // unaffected -- this branch only exists when the request explicitly opts in.
  (async () => {
    try {
      if (req.stream) {
        let emittedAny = false;
        const onChunk = (text) => {
          emittedAny = true;
          process.stdout.write(`${JSON.stringify({ type: 'chunk', text })}\n`);
        };
        const result = await runPlanWithTools(Object.assign({}, req, { onChunk }));
        // The tools-disabled kill-switch path (and, in principle, a turn whose only
        // content arrived on a turn where onChunk was never wired) never streams --
        // give the browser SOMETHING to show rather than a silent jump straight to
        // "final" with an empty-looking transcript entry.
        if (!emittedAny && result.response) {
          process.stdout.write(`${JSON.stringify({ type: 'chunk', text: result.response })}\n`);
        }
        process.stdout.write(`${JSON.stringify(Object.assign({ type: 'final' }, result))}\n`);
      } else {
        const result = await runPlanWithTools(req);
        process.stdout.write(JSON.stringify(result));
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
