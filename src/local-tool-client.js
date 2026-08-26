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
async function postChatTurn({ messages, tools, tokenFoldHeaders, onChunk }) {
  if (!onChunk) {
    const res = await postJson(`${OLLAMA_URL}/api/chat`, {
      model: MODEL, messages, tools, stream: false,
    }, REQUEST_TIMEOUT_MS, tokenFoldHeaders);
    return res.message || {};
  }
  let contentAcc = '';
  let toolCalls = null;
  let streamError = null;
  await postJsonStream(`${OLLAMA_URL}/api/chat`, {
    model: MODEL, messages, tools,
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

async function runPlanWithTools({ prompt, messages: reqMessages, maxTurns = 5, source, allowWrite = false, onChunk }) {
  const { pipelineDir } = getConfig();
  // allowWrite=true (Chat panel only) checks its OWN kill switch, separate from
  // arch_discovery's -- see WRITE_TOOLS' own header for why these must stay independent.
  const killSwitchPath = path.join(pipelineDir, 'queue',
    allowWrite ? '.chat-write-tools-disabled' : '.arch-discovery-tools-disabled');
  if (fs.existsSync(killSwitchPath)) {
    const { call } = require('./local-client.js');
    // local-client.js's own call() doesn't self-lock -- local-draft.js's maybeLocked()
    // wraps it externally for its own plan pass, same discipline applied here.
    const result = await withLock(path.join(pipelineDir, 'instances'), () => call({ prompt, think: true }), MODEL);
    return { response: result.response, toolCallLog: [], turnsUsed: 0, toolsDisabled: true };
  }

  const tools = allowWrite ? [...TOOLS, ...WRITE_TOOLS] : TOOLS;
  const toolHandlers = allowWrite ? { ...TOOL_HANDLERS, ...WRITE_TOOL_HANDLERS } : TOOL_HANDLERS;
  // 2026-08-24 -- caught live via the Chat panel's first real message: this loop's own
  // /api/chat calls had NO coordination with worker-1/reviewer's use of the same single
  // resident Ollama model, the exact uncoordinated-contention bug the Discuss-side lock
  // work earlier tonight was built to fix, just reintroduced through a different call
  // path. Same instancesDir derivation and withLock() usage local-draft.js's own
  // maybeLocked() already establishes -- held ONLY around each individual /api/chat call
  // below, not the whole multi-turn loop (tool execution between turns doesn't touch the
  // GPU and shouldn't block other lanes while it runs).
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

  // 2026-08-26 (Chat panel 502, Grimmethy): a real Ollama /api/chat call can
  // intermittently come back "Ollama HTTP 500: {"error":"no user query found in
  // messages"}". CORRECTED root cause (an earlier version of this comment wrongly
  // blamed the vendored TokenFold proxy -- ruled out live: OLLAMA_URL is unset for this
  // caller, so TokenFold was never actually in the request path): confirmed via
  // `journalctl -u ollama` that this is Ollama's OWN renderer failing --
  // `source=routes.go:2684 msg="chat prompt error" error="no user query found in
  // messages"` -- on longer, tool-heavy conversations. It's genuinely transient, not
  // content-triggered: the exact same messages array, resent unchanged moments later,
  // can succeed. A single retry isn't reliable enough -- confirmed live, it failed twice
  // in a row on a real multi-tool-call chat turn -- so this retries up to
  // CHAT_FLAKE_MAX_ATTEMPTS times total per turn (not counted against
  // maxTurns/turnsUsed), the same bounded-retry-on-known-transient-failure treatment
  // this pipeline already gives other infra flakiness (see local-worker.sh's
  // INFRA_FAILURE_PATTERN).
  const CHAT_FLAKE_MAX_ATTEMPTS = 3;

  for (let turn = 0; turn < maxTurns; turn++) {
    turnsUsed = turn + 1;
    let message;
    let flakeErr = null;
    for (let attempt = 0; attempt < CHAT_FLAKE_MAX_ATTEMPTS; attempt++) {
      try {
        message = await withLock(instancesDir, () => postChatTurn({ messages, tools, tokenFoldHeaders, onChunk }), MODEL);
        flakeErr = null;
        break;
      } catch (e) {
        if (!/no user query found in messages/i.test(e.message)) throw e;
        flakeErr = e;
      }
    }
    if (flakeErr) {
      // Retries exhausted. A LATER turn (turn > 0) means the model already said
      // something real on earlier turns -- onChunk already streamed it to the browser.
      // Throwing here would silently discard all of that (confirmed live: a whole
      // streamed AC-3 investigation vanished and the Chat panel quietly rolled back to
      // its pre-message state) for a failure that has nothing to do with what was
      // already said. Same graceful-degrade shape as the maxTurns-reached return below.
      if (lastMessage) {
        // The already-streamed content (if any) already reached onChunk on earlier
        // turns -- this note is NEW text the model never said, so it needs its own
        // onChunk call to actually reach the browser (the CLI's own "emittedAny"
        // fallback only fires when NOTHING streamed yet, which isn't this case).
        const note = '\n\n*(Lost the connection to the local model mid-investigation -- '
          + "Ollama's own renderer hit a known intermittent fault. The above is what it "
          + 'had said so far; ask again to let it continue.)*';
        if (onChunk) onChunk(note);
        return {
          response: (lastMessage.content || '') + note,
          toolCallLog, turnsUsed: turnsUsed - 1, toolsDisabled: false,
        };
      }
      throw flakeErr;
    }

    lastMessage = message;
    const toolCalls = message.tool_calls || [];

    if (toolCalls.length === 0) {
      return { response: message.content || '', toolCallLog, turnsUsed, toolsDisabled: false };
    }

    messages.push(message);
    for (const toolCall of toolCalls) {
      const name = toolCall.function && toolCall.function.name;
      const args = (toolCall.function && toolCall.function.arguments) || {};
      const handler = toolHandlers[name];
      // A malformed/unknown tool call (bad name, missing/wrong-typed args, an escaping
      // path) must degrade gracefully -- a clear error STRING back to the model as the
      // tool result, so it can see it made a mistake and try again, not a thrown
      // exception that kills the whole loop (see this file's own header: one bad tool
      // call from the model should never crash the entire draft attempt).
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
