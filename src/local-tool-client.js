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
const { KEEP_ALIVE } = require('./local-client.js'); // same keep_alive the /api/generate path uses

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

// Multi-root variant (2026-08-31, system-wide Chat panel): the chat assistant is rooted
// at the agent-manager repo but can also reach every registered plugin/project repo. A
// RELATIVE path resolves against allowedRoots[0] (the primary root); an ABSOLUTE path is
// accepted only if it lands inside one of allowedRoots. Returns { full, root } or null.
// For every non-chat caller allowedRoots is [repoRoot] and this behaves exactly like
// resolveInsideRepo above.
function resolveInsideRoots(allowedRoots, p) {
  const roots = allowedRoots.map((r) => path.resolve(r));
  if (p && path.isAbsolute(p)) {
    const full = path.resolve(p);
    const root = roots.find((r) => full === r || full.startsWith(r + path.sep));
    return root ? { full, root } : null;
  }
  const root = roots[0];
  const full = path.resolve(root, p || '');
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return { full, root };
}

// Each file tool below accepts either (allowedRootsArray, argsObj) -- the system-wide
// Chat path, which threads its own root list -- or just (argsObj), in which case the
// single configured repoRoot is the only allowed root. The second shape is what every
// pre-2026-08-31 caller and the standalone unit tests use, unchanged.
function rootsAndArgs(a, b) {
  return Array.isArray(a)
    ? { roots: a, args: b || {} }
    : { roots: [getConfig().repoRoot], args: a || {} };
}

// Same cap/truncation-suffix convention as nextCandidateFulfillmentTask()'s own
// MAX_FETCHED_FILE_CHARS -- one huge file must not blow the model's context or the /api/chat
// response payload. This is only a hard SAFETY ceiling now: the primary control is the
// line window below.
const MAX_READ_FILE_CHARS = 8000;
// 2026-09-01: a read_file with no way to page is why the local write-tier could never
// implement a net-new route in python/dashboard/app.py -- the target region is ~130KB into
// a ~4000-line file, and the old behaviour returned a silent first-8000-char HEAD cut. A
// line window (offset/limit, 1-indexed, matching the Read tool the operator already knows)
// + a nextOffset the model can page with fixes that. Defaults chosen so the common
// "read a function" case is one call and a whole large file is a few deliberate pages.
const READ_FILE_DEFAULT_LINES = 400;
const READ_FILE_MAX_LINES = 800;

function readFileTool(a, b) {
  const { roots: allowedRoots, args } = rootsAndArgs(a, b);
  const relPath = args.path;
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { error: 'read_file requires a non-empty "path" argument' };
  }
  const resolved = resolveInsideRoots(allowedRoots, relPath);
  if (!resolved) {
    return { error: `path is not inside any accessible repo, refusing to read: ${relPath}` };
  }
  const { full } = resolved;
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (e) {
    return { error: `could not read ${relPath}: ${e.message}` };
  }

  const lines = raw.split('\n');
  const totalLines = lines.length;
  const windowGiven = args.offset != null || args.limit != null;

  let offset = Number.isFinite(args.offset) ? Math.floor(args.offset) : 1;
  if (offset < 1) offset = 1;
  let limit = Number.isFinite(args.limit) ? Math.floor(args.limit) : READ_FILE_DEFAULT_LINES;
  if (limit < 1) limit = 1;
  if (limit > READ_FILE_MAX_LINES) limit = READ_FILE_MAX_LINES;

  // offset past EOF -> empty content, but still report totalLines so the model can retry.
  if (offset > totalLines) {
    return { path: relPath, content: '', offset, limit, totalLines, nextOffset: null, truncated: false };
  }

  const endLine = Math.min(totalLines, offset - 1 + limit);
  let slice = lines.slice(offset - 1, endLine).join('\n');

  // Hard char ceiling still applies to the slice itself (a file with pathological line
  // lengths must not blow the payload). If it bites, trim the slice and mark truncated.
  let truncated = false;
  if (slice.length > MAX_READ_FILE_CHARS) {
    slice = `${slice.slice(0, MAX_READ_FILE_CHARS)}\n...[truncated: slice exceeded ${MAX_READ_FILE_CHARS} chars, narrow the line window]`;
    truncated = true;
  }

  const returnedThrough = truncated ? offset : endLine; // unknown exact line count when char-truncated
  const nextOffset = endLine < totalLines ? endLine + 1 : null;

  const out = { path: relPath, content: slice, offset, limit, totalLines, nextOffset, truncated };
  if (!windowGiven && nextOffset != null) {
    out.notice = `file has ${totalLines} lines; showing 1-${returnedThrough}. Re-call read_file with offset=${nextOffset} to page further (and limit=N, up to ${READ_FILE_MAX_LINES}).`;
  } else if (nextOffset != null) {
    out.notice = `showing lines ${offset}-${returnedThrough} of ${totalLines}. Re-call with offset=${nextOffset} for the next window.`;
  }
  return out;
}

function listDirectoryTool(a, b) {
  const { roots: allowedRoots, args } = rootsAndArgs(a, b);
  const relPath = args.path;
  const target = typeof relPath === 'string' && relPath.trim() ? relPath : '.';
  const resolved = resolveInsideRoots(allowedRoots, target);
  if (!resolved) {
    return { error: `path is not inside any accessible repo, refusing to list: ${target}` };
  }
  const { full } = resolved;
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

// 2026-08-31 (system-wide Chat panel): the assistant is rooted at the agent-manager repo
// but can also read/edit every registered plugin/project repo. list_roots tells it which
// absolute paths those are so it can target a non-primary repo with an absolute path
// argument (read_file/list_directory/write_file/edit_file) or grep_codebase's `root`.
function listRootsTool(a) {
  const roots = Array.isArray(a) ? a : [getConfig().repoRoot];
  return {
    primary: roots[0],
    roots: roots.map((r, i) => ({ path: r, name: path.basename(r), primary: i === 0 })),
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

function writeFileTool(a, b) {
  const { roots: allowedRoots, args } = rootsAndArgs(a, b);
  const { path: relPath, content } = args;
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { error: 'write_file requires a non-empty "path" argument' };
  }
  const resolved = resolveInsideRoots(allowedRoots, relPath);
  if (!resolved) {
    return { error: `path is not inside any accessible repo, refusing to write: ${relPath}` };
  }
  const { full } = resolved;
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : '');
  } catch (e) {
    return { error: `could not write ${relPath}: ${e.message}` };
  }
  return { path: relPath, written: true };
}

function editFileTool(a, b) {
  const { roots: allowedRoots, args } = rootsAndArgs(a, b);
  const { path: relPath, find, replace } = args;
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { error: 'edit_file requires a non-empty "path" argument' };
  }
  if (typeof find !== 'string' || find === '') {
    return { error: 'edit_file requires a non-empty "find" argument' };
  }
  const resolved = resolveInsideRoots(allowedRoots, relPath);
  if (!resolved) {
    return { error: `path is not inside any accessible repo, refusing to edit: ${relPath}` };
  }
  const { full } = resolved;
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

function runBashTool(a, b) {
  const { roots: allowedRoots, args } = rootsAndArgs(a, b);
  const { command } = args;
  if (typeof command !== 'string' || !command.trim()) {
    return { error: 'run_bash requires a non-empty "command" argument' };
  }
  const realRoots = allowedRoots.map((r) => fs.realpathSync(r));
  const wrapped = wrapWithSandbox('bash', ['-c', command], {
    workDir: realRoots[0],
    readOnlyBinds: ['/usr', '/bin', '/lib', '/lib64', '/etc/resolv.conf', '/etc/ssl'],
    // Every accessible repo, writable -- unlike adhoc-agentic-draft.js's throwaway
    // worktree, Chat edits are meant to land directly on the real working trees (see
    // this feature's own plan: "the same trust model as this session itself"). For a
    // non-chat caller allowedRoots is just [repoRoot], identical to before.
    writableBinds: realRoots,
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
      description: 'Create a new file or overwrite an existing one with the given content. Path is relative to the primary repo root, OR an absolute path inside any accessible repo (see list_roots).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the primary repo root, or an absolute path inside another accessible repo.' },
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
      description: 'Replace one exact, unique occurrence of "find" with "replace" in an existing file. Fails if "find" is not found verbatim or matches more than once -- include enough surrounding context to make it unique. Path is relative to the primary repo root, OR an absolute path inside any accessible repo.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the primary repo root, or an absolute path inside another accessible repo.' },
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
      description: 'Run a shell command inside a filesystem sandbox. The working directory is the primary repo root; every accessible repo is mounted writable (use `git -C <abs path>` or `cd` for another repo). Use for git operations, running tests, or anything the file tools cannot do directly.',
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
      description: 'Search source files for a literal substring (or, for a multi-word query, lines containing every word). NOT a regex. Returns up to 20 matching lines with file path and line number, matching line only -- read_file around a hit for surrounding context. To search a repo other than the primary one, pass its absolute path (from list_roots) as "root".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal substring, or several words (a line matches if it contains all of them). No regex.' },
          dir: { type: 'string', description: 'Which subdirectory to search: one of the primary repo\'s searchable dirs (see the error message if unsure), a subpath of one (e.g. "python/dashboard"), or "." / omitted to search all of them. For another "root", any subdirectory or "." for the whole repo.' },
          root: { type: 'string', description: 'Optional absolute path of another accessible repo to search instead of the primary one (see list_roots).' },
          contextLines: { type: 'integer', description: 'Optional 0-5: include this many lines of context before and after each hit.' },
        },
        required: ['query', 'dir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a real file as a window of lines. Path is relative to the primary repo root, OR an absolute path inside any accessible repo (see list_roots). Returns { content, offset, limit, totalLines, nextOffset }. Files here can be thousands of lines: check totalLines and, if nextOffset is not null, re-call with offset=nextOffset to page. Never assume the first window is the whole file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the primary repo root (e.g. "src/task-sources.js") or an absolute path inside another accessible repo.' },
          offset: { type: 'integer', description: 'First line to return (1-indexed). Default 1.' },
          limit: { type: 'integer', description: 'How many lines to return. Default 400, max 800.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the files and subdirectories directly inside a given path (one level, not recursive). Path is relative to the primary repo root, OR an absolute path inside any accessible repo (see list_roots).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the primary repo root (e.g. "src"), or an absolute path inside another accessible repo. Omit or use "." for the primary repo root.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_roots',
      description: 'List every repo you can access: the primary one (agent-manager, where relative paths resolve) and each additional plugin/project repo, with its absolute path. Use these paths to read/edit/grep a non-primary repo.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// Handler sets are built PER CALL as closures over that call's allowedRoots (the
// system-wide Chat path threads a multi-repo list; every other caller gets
// [getConfig().repoRoot], identical to the old static behaviour).
function buildToolHandlers(allowedRoots) {
  // A model-supplied `root` for grep_codebase must be one of THIS call's allowed roots --
  // otherwise the tool would grep any path on disk. allowedRoots is already realpath'd
  // (see runPlanWithTools), so compare on realpath. A `root` that resolves to the primary
  // repo is fine (grepCodebase ignores it via its own primary-root check) -- only a path
  // OUTSIDE every allowed root is rejected.
  const grepRoot = (raw) => {
    if (!raw) return { ok: true, root: undefined };
    let real;
    try { real = fs.realpathSync(raw); } catch { real = null; }
    if (!real || !allowedRoots.includes(real)) return { ok: false };
    return { ok: true, root: real };
  };
  return {
    grep_codebase: (args) => {
      const r = grepRoot(args.root);
      if (!r.ok) return { error: `root is not an accessible repo: ${args.root} (call list_roots)` };
      return grepCodebase({ query: args.query, dir: args.dir, root: r.root, contextLines: args.contextLines });
    },
    read_file: (args) => readFileTool(allowedRoots, { path: args.path, offset: args.offset, limit: args.limit }),
    list_directory: (args) => listDirectoryTool(allowedRoots, { path: args.path }),
    list_roots: () => listRootsTool(allowedRoots),
  };
}

// The grep_codebase `dir` description is generic in the static TOOLS array; fill in the
// live searchable-dir list at call time so the model sees the real names (src, python, ...)
// rather than guessing and getting an error. Returns a shallow copy with only that one
// field rewritten.
function grepDirsHint() {
  try {
    const dirs = getConfig().grepAllowedDirs || [];
    return dirs.length ? dirs.join(', ') : null;
  } catch { return null; }
}
function withGrepDirsHint(tools) {
  const hint = grepDirsHint();
  if (!hint) return tools;
  return tools.map((t) => {
    if (t.function?.name !== 'grep_codebase') return t;
    const props = t.function.parameters.properties;
    return {
      ...t,
      function: {
        ...t.function,
        parameters: {
          ...t.function.parameters,
          properties: { ...props, dir: { ...props.dir, description: `${props.dir.description} This repo's searchable dirs: ${hint}.` } },
        },
      },
    };
  });
}

function buildWriteToolHandlers(allowedRoots) {
  return {
    write_file: (args) => writeFileTool(allowedRoots, { path: args.path, content: args.content }),
    edit_file: (args) => editFileTool(allowedRoots, { path: args.path, find: args.find, replace: args.replace }),
    run_bash: (args) => runBashTool(allowedRoots, { command: args.command }),
  };
}

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
// 2026-08-31: same story for keep_alive. This path sent none, so between agentic turns the
// model unloaded on Ollama's 5-minute default and the next turn ate a cold reload (~114s
// observed on the 27B during the first live run of the #36 write-agentic adhoc tier, whose
// turns routinely outlast 5 min: model reasoning + a 240s run_bash + worker-1 holding the
// GPU lock in between). local-client.js's KEEP_ALIVE (LOCAL_KEEP_ALIVE || ORNITH_KEEP_ALIVE
// || '30m') is exported now and reused here so both call paths agree.
// Returns { message, usage } where usage carries Ollama's own token accounting for this
// turn (prompt_eval_count / eval_count / eval_duration) -- summed across turns by
// runPlanWithTools and surfaced on its result so model-stats-client.recordCall can persist
// per-call token counts (they were silently dropped before 2026-09-01, leaving every
// model_calls row's token columns NULL and forensics blind to context-window pressure).
function pickUsage(o) {
  return {
    prompt_eval_count: Number(o && o.prompt_eval_count) || 0,
    eval_count: Number(o && o.eval_count) || 0,
    eval_duration: Number(o && o.eval_duration) || 0,
  };
}

async function postChatTurn({ messages, tools, tokenFoldHeaders, onChunk }) {
  if (!onChunk) {
    const res = await postJson(`${OLLAMA_URL}/api/chat`, {
      model: MODEL, messages, tools, stream: false, keep_alive: KEEP_ALIVE, options: { num_ctx: PINNED_NUM_CTX },
    }, REQUEST_TIMEOUT_MS, tokenFoldHeaders);
    return { message: res.message || {}, usage: pickUsage(res) };
  }
  let contentAcc = '';
  let toolCalls = null;
  let streamError = null;
  let usage = pickUsage(null);
  await postJsonStream(`${OLLAMA_URL}/api/chat`, {
    model: MODEL, messages, tools, keep_alive: KEEP_ALIVE, options: { num_ctx: PINNED_NUM_CTX },
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
    // Ollama's final NDJSON frame carries done:true + the token counts for the turn.
    if (obj.done) usage = pickUsage(obj);
  });
  if (streamError) throw new Error(streamError);
  return { message: { role: 'assistant', content: contentAcc, tool_calls: toolCalls || undefined }, usage };
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

// Edit-by-turn-N forcing function (2026-09-01): a real live failure class -- the local
// write-agentic tier repeatedly spent its ENTIRE turn budget on grep/read/list orientation
// and never once called edit_file/write_file, then blocked. Grounding the prompt with the
// plan + a prior read-only investigation helped it find the right files faster but did NOT
// get it off the fence. So once a `nudgeToEditEarly` run has used this many turns with zero
// edits, inject one firm mid-run message: stop exploring, next action is an edit or a
// RESOLUTION line. Env-overridable; clamped below maxTurns so it always leaves room to act.
const ORIENT_TURN_LIMIT = Number(process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS) || 10;

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
    let usage = null;
    let attemptErr = null;
    for (let attempt = 0; attempt < CHAT_FLAKE_MAX_ATTEMPTS; attempt++) {
      try {
        const turnRes = await withLock(instancesDir, () => postChatTurn({ messages, tools, tokenFoldHeaders, onChunk }), MODEL);
        message = turnRes.message;
        usage = turnRes.usage;
        attemptErr = null;
        break;
      } catch (e) {
        if (!/no user query found in messages/i.test(e.message)) throw e;
        attemptErr = e;
      }
    }
    if (!attemptErr) return { message, usage };
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

async function runPlanWithTools({ prompt, messages: reqMessages, maxTurns = 5, source, allowWrite = false, onChunk, primaryRoot, extraRoots = [], forceSummaryOnCap = false, nudgeToEditEarly = false, leafMustEdit = false }) {
  const { pipelineDir, repoRoot } = getConfig();
  // allowWrite=true (Chat panel only) checks its OWN kill switch, separate from
  // arch_discovery's -- see WRITE_TOOLS' own header for why these must stay independent.
  const killSwitchPath = path.join(pipelineDir, 'queue',
    allowWrite ? '.chat-write-tools-disabled' : '.arch-discovery-tools-disabled');
  if (fs.existsSync(killSwitchPath)) {
    return runWithoutToolsFallback(prompt, pipelineDir);
  }

  // Multi-root (2026-08-31, system-wide Chat panel): the caller may thread its own
  // primary root + a list of additional accessible repo roots. Every non-chat caller
  // passes neither, so allowedRoots is just [repoRoot] and every tool behaves exactly
  // as it did before. Deduped on realpath, primary first.
  const rawRoots = [primaryRoot || repoRoot, ...(Array.isArray(extraRoots) ? extraRoots : [])];
  const seen = new Set();
  const allowedRoots = [];
  for (const r of rawRoots) {
    let real;
    try { real = fs.realpathSync(r); } catch { continue; }
    if (!seen.has(real)) { seen.add(real); allowedRoots.push(real); }
  }
  if (allowedRoots.length === 0) allowedRoots.push(path.resolve(repoRoot));

  const tools = withGrepDirsHint(allowWrite ? [...TOOLS, ...WRITE_TOOLS] : TOOLS);
  const toolHandlers = allowWrite
    ? { ...buildToolHandlers(allowedRoots), ...buildWriteToolHandlers(allowedRoots) }
    : buildToolHandlers(allowedRoots);
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

  // Ollama token accounting, summed across every turn (incl. flake-retried and
  // forced-summary turns) -- surfaced on the result for model-stats-client.recordCall.
  const usageAcc = { prompt_eval_count: 0, eval_count: 0, eval_duration: 0 };
  const addUsage = (u) => {
    if (!u) return;
    usageAcc.prompt_eval_count += Number(u.prompt_eval_count) || 0;
    usageAcc.eval_count += Number(u.eval_count) || 0;
    usageAcc.eval_duration += Number(u.eval_duration) || 0;
  };
  const withUsage = (r) => ({ ...r, ...usageAcc });

  // messages.length / toolCallLog.length as of the START of each turn, in order -- lets a
  // later turn's unrecoverable flake roll back exactly the PRIOR turn's own additions
  // (the ones most likely to be the corrupting tool-call-only turn) rather than just the
  // current turn's, since the corruption always lives in already-stored history, never in
  // the turn that's actively failing.
  const turnStartLengths = [];
  const turnStartLogLengths = [];

  // A final no-tools message that already carries a RESOLUTION: line is a clean finish and
  // needs no forced-summary turn. Anchored + multiline so it matches the line the
  // agentic-draft resolvers actually parse, not the word appearing mid-sentence.
  const HAS_RESOLUTION_RE = /^\s*RESOLUTION:/im;

  // One extra no-tools turn that asks only for the RESOLUTION line, reusing whatever the
  // model already learned. Shared by the two forceSummaryOnCap paths below (cap hit while
  // still calling tools; stopped early with no RESOLUTION line). See the header on the
  // forceSummaryOnCap param and the call sites for why each path needs it.
  const runForcedSummaryTurn = async () => {
    turnStartLengths.push(messages.length);
    turnStartLogLengths.push(toolCallLog.length);
    messages.push({
      role: 'user',
      content: 'You are out of turns and can no longer call tools. Using only what you have already learned, give your best final answer now and end with exactly one RESOLUTION: line plus the follow-up its format requires. If you never got far enough to implement or decide, use RESOLUTION: decompose (followed by the sub-task JSON array) or RESOLUTION: needs-human-decision (followed by the open question).',
    });
    turnsUsed += 1;
    const { message: summaryMsg, usage: summaryUsage, flakeErr: summaryFlake } = await chatTurnWithFlakeRecovery({
      messages, tools: [], tokenFoldHeaders, onChunk, instancesDir,
      toolCallLog, turnStartLengths, turnStartLogLengths,
    });
    addUsage(summaryUsage);
    const summaryContent = (!summaryFlake && summaryMsg && summaryMsg.content) ? summaryMsg.content : '';
    return withUsage({
      response: summaryContent || (lastMessage && lastMessage.content) || '',
      toolCallLog, turnsUsed, toolsDisabled: false, forcedSummary: true,
    });
  };

  // Edit-by-turn-N forcing function -- fired at most once, see ORIENT_TURN_LIMIT.
  let editNudgeFired = false;
  // A second, firmer nudge for a task that is a CONFIRMED-ATOMIC LEAF (leafMustEdit): the
  // soft nudge above did not always get the 27B off the fence (the /api/chat/inject leaf
  // took the soft nudge, then still chose decompose instead of editing). A few turns after
  // the soft one, if there is STILL no edit, one last message: edit now or conclude
  // needs-human-decision -- decompose is not an option for a leaf.
  let hardNudgeFired = false;
  const editToolCallCount = () => toolCallLog.filter((c) => c && /^(edit_file|write_file)$/.test(c.tool)).length;

  for (let turn = 0; turn < maxTurns; turn++) {
    turnsUsed = turn + 1;
    turnStartLengths.push(messages.length);
    turnStartLogLengths.push(toolCallLog.length);

    // If this run is meant to produce a diff and has spent its orientation budget without
    // a single edit, one firm push before the next turn: stop exploring, act now. The
    // model still has (maxTurns - ORIENT_TURN_LIMIT) turns left to implement or conclude.
    if (nudgeToEditEarly && !editNudgeFired && turn >= ORIENT_TURN_LIMIT
        && turn < maxTurns - 1 && editToolCallCount() === 0) {
      editNudgeFired = true;
      messages.push({
        role: 'user',
        content: `You have used ${turn} turns exploring and have not made a single edit. Stop exploring now -- you have enough information. Your next action MUST be an edit_file or write_file call to start implementing, OR your final message with exactly one RESOLUTION: line (implemented / no-changes-needed / decompose / needs-human-decision). Do not call grep_codebase / read_file / list_directory / run_bash again.`,
      });
      // Keep the flake-rollback anchor for THIS turn after the nudge, so a rollback re-does
      // only the (poisoned) assistant turn and preserves the nudge.
      turnStartLengths[turnStartLengths.length - 1] = messages.length;
    }

    // Firmer second push for a confirmed-atomic leaf that STILL has not edited a few turns
    // after the soft nudge.
    if (leafMustEdit && !hardNudgeFired && turn >= ORIENT_TURN_LIMIT + 3
        && turn < maxTurns - 2 && editToolCallCount() === 0) {
      hardNudgeFired = true;
      messages.push({
        role: 'user',
        content: `Final warning: ${turn} turns used and zero edits on a task that a prior decompose pass already confirmed is implementable in one pass. Your NEXT message MUST be an edit_file or write_file call, OR exactly "RESOLUTION: needs-human-decision" followed by the one concrete fact you are missing. RESOLUTION: decompose is not available for this task.`,
      });
      turnStartLengths[turnStartLengths.length - 1] = messages.length;
    }

    const { message, usage, flakeErr } = await chatTurnWithFlakeRecovery({
      messages, tools, tokenFoldHeaders, onChunk, instancesDir,
      toolCallLog, turnStartLengths, turnStartLogLengths,
    });
    addUsage(usage);
    if (flakeErr) {
      // Rollback exhausted too (or there was no prior turn to roll back -- a first-turn
      // failure is a genuinely different, unexplained case). Graceful-degrade if the
      // model already produced real content on an earlier turn; otherwise rethrow.
      if (lastMessage) return withUsage(flakeDegradeResult(lastMessage, toolCallLog, turnsUsed, onChunk));
      throw flakeErr;
    }

    lastMessage = message;
    const toolCalls = message.tool_calls || [];
    if (toolCalls.length === 0) {
      const content = message.content || '';
      // forceSummaryOnCap, voluntary-stop case (bra-1788142124203 follow-up): the model can
      // also just END early -- a final no-tools message well before the cap -- without ever
      // writing a RESOLUTION: line. resolveAgenticDraft reads that exactly as fatally as a
      // cap-out ("cannot determine outcome -> hard block"), throwing away a run that may
      // have gotten most of the way there. Confirmed live: a tier-3 write run stopped at
      // turn 12 of 20 with a plain no-tools message and blocked with zero salvageable
      // output. Same remedy as the cap path -- one more no-tools turn asking only for the
      // sentinel -- gated on the caller opting in and the line genuinely being absent (a
      // clean finish still returns immediately, as before).
      if (forceSummaryOnCap && !HAS_RESOLUTION_RE.test(content)) {
        return runForcedSummaryTurn();
      }
      return withUsage({ response: content, toolCallLog, turnsUsed, toolsDisabled: false });
    }
    executeToolCalls(message, toolCalls, toolHandlers, messages, toolCallLog);
  }

  // maxTurns reached without a final (no-tool-calls) response -- deliberate forced stop,
  // not a crash, matching how this pipeline already treats an empty/degenerate plan pass.
  //
  // forceSummaryOnCap (2026-08-31, bra-1788142124203): the agentic-draft callers need one
  // more thing here. A run that hits the cap while still calling tools never wrote a
  // verdict, so `lastMessage.content` is usually empty or a half-thought -- and
  // resolveAgenticDraft can only read that as "did not end with a RESOLUTION: line ->
  // hard block", discarding the entire run (a real tier-3 case burned all 20 turns on
  // read-only exploration and blocked with zero salvageable output). Spend ONE final
  // no-tools turn asking only for the RESOLUTION line (runForcedSummaryTurn, shared with
  // the voluntary-stop path above). Off by default so the Chat panel CLI path (which has
  // its own "ran out of budget" explainer keyed on turnsUsed) is unaffected.
  if (forceSummaryOnCap) {
    return runForcedSummaryTurn();
  }

  return withUsage({ response: (lastMessage && lastMessage.content) || '', toolCallLog, turnsUsed, toolsDisabled: false });
}

module.exports = {
  runPlanWithTools, readFileTool, listDirectoryTool, listRootsTool,
  resolveInsideRepo, resolveInsideRoots, TOOLS,
  writeFileTool, editFileTool, runBashTool, WRITE_TOOLS,
  buildToolHandlers, buildWriteToolHandlers,
  withApplyLock, APPLY_LOCK_PATH, ORIENT_TURN_LIMIT,
};

// CLI: node local-tool-client.js <request.json>
// request.json: { prompt, maxTurns, source?, allowWrite?, primaryRoot?, extraRoots? }
//   source: task type, keys the per-task-type TokenFold dictionary -- same meaning as
//     local-client.js's source.
//   allowWrite: Chat panel only, see WRITE_TOOLS' own header.
//   primaryRoot / extraRoots (system-wide Chat panel, 2026-08-31): the repo the assistant
//     is rooted at + additional accessible repo roots. Omitted by every other caller,
//     which then operates on the single configured repoRoot exactly as before.
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
