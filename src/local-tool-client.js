'use strict';

// Multi-turn tool-calling loop for a plan pass, giving it a real, narrow, read-only
// codebase-search capability via grep-codebase-tool.js. Unlike local-client.js (which only
// ever calls Ollama's /api/generate -- a single prompt-in, text-out call with no structured
// tool support), this hits /api/chat, the endpoint that actually supports Ollama's tools
// array and tool_calls response field.

const path = require('path');
const fs = require('fs');
const { grepCodebase } = require('./grep-codebase-tool.js');
const { getConfig } = require('./config.js');
const { postJson } = require('./ollama-http.js');

// Read-only file-exploration tools (2026-08-22, Grimmethy: "expand the tooling
// capabilities so that the local reasoning model can handle the work... I'd like to see
// the automated work being handled entirely locally") -- read_file/list_directory,
// alongside the pre-existing grep_codebase above. Deliberately READ-ONLY: no write_file,
// edit_file, or shell-execution tool exists here, and none should be added to this loop --
// a local model is materially less reliable at agentic tool use than Claude (real
// documented incident: a tool-calling call once stalled 13+ minutes with no progress, see
// docs/pipeline-incident-2026-07-19.md and ornith-worker.ps1's own comment on why this
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

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
// No hardcoded fallback tag -- see local-client.js's matching comment. An unset
// LOCAL_MODEL now surfaces as a real Ollama "model not found" error, not a guessed name.
const MODEL = process.env.LOCAL_MODEL;

// Matches local-client.js's REQUEST_TIMEOUT_MS exactly -- was 1_800_000 (30 min) under the
// reasoning that a tool-calling turn can legitimately run longer than a plain generation
// call. That reasoning turned out to be actively harmful, not just generous: this exact
// path is why Invoke-OrnithToolClient is disabled in ornith-worker.ps1 (see that file's
// comment) -- a real call through here stalled a worker for 13+ minutes with no progress,
// and a 30-min ceiling meant nothing would have caught it for a very long time if the
// disable hadn't happened first. 5 minutes is the formalized ceiling for every Ornith-call-
// or liveness-related timeout in this pipeline as of 2026-07-19 (see
// docs/pipeline-incident-2026-07-19.md and queue-watchdog.ps1's $WorkerZombieThresholdSeconds)
// -- repeated-failure downtime compounds fast, and no legitimate call needs longer than
// this. Do not raise this again "to be safe" without revisiting that reasoning first.
const REQUEST_TIMEOUT_MS = Number(process.env.ORNITH_TIMEOUT_MS) || 240_000;

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

async function runPlanWithTools({ prompt, maxTurns = 5, source }) {
  const { pipelineDir } = getConfig();
  const killSwitchPath = path.join(pipelineDir, 'queue', '.arch-discovery-tools-disabled');
  if (fs.existsSync(killSwitchPath)) {
    const { call } = require('./local-client.js');
    const result = await call({ prompt, think: true });
    return { response: result.response, toolCallLog: [], turnsUsed: 0, toolsDisabled: true };
  }

  // Same TokenFold session/scope headers local-client.js sends on /api/generate.
  // Without the session header every /api/chat call hashed into its own one-off
  // TokenFold session, so the dictionary bootstrap's one-time cost could never
  // amortize across the tool loop's turns -- the exact traffic shape (one prompt
  // re-sent with growing history each turn) where session continuity pays most.
  const tokenFoldHeaders = { 'X-TokenFold-Session': `agent-manager-${process.env.AGENT_MANAGER_INSTANCE_ID || 'default'}` };
  if (source) tokenFoldHeaders['X-TokenFold-Scope'] = source;

  const messages = [{ role: 'user', content: prompt }];
  const toolCallLog = [];
  let turnsUsed = 0;
  let lastMessage = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    turnsUsed = turn + 1;
    const res = await postJson(`${OLLAMA_URL}/api/chat`, {
      model: MODEL,
      messages,
      tools: TOOLS,
      stream: false,
    }, REQUEST_TIMEOUT_MS, tokenFoldHeaders);

    const message = res.message || {};
    lastMessage = message;
    const toolCalls = message.tool_calls || [];

    if (toolCalls.length === 0) {
      return { response: message.content || '', toolCallLog, turnsUsed, toolsDisabled: false };
    }

    messages.push(message);
    for (const toolCall of toolCalls) {
      const name = toolCall.function && toolCall.function.name;
      const args = (toolCall.function && toolCall.function.arguments) || {};
      const handler = TOOL_HANDLERS[name];
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

module.exports = { runPlanWithTools, readFileTool, listDirectoryTool, resolveInsideRepo, TOOLS };

// CLI: node local-tool-client.js <request.json>
// request.json: { prompt, maxTurns, source? }  (source: task type, keys the
// per-task-type TokenFold dictionary -- same meaning as local-client.js's source)
// Writes the JSON result to stdout.
if (require.main === module) {
  const requestPath = process.argv[2];
  if (!requestPath) {
    console.error('usage: node local-tool-client.js <request.json>');
    process.exit(1);
  }
  const req = JSON.parse(fs.readFileSync(requestPath, 'utf8'));

  (async () => {
    try {
      const result = await runPlanWithTools(req);
      process.stdout.write(JSON.stringify(result));
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
