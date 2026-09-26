'use strict';

// local-tool-fs-tools.js -- extracted from src/local-tool-client.js ([[hub-task-integration]] node-module decompose).

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const { wrapWithSandbox } = require('./sandbox.js');

const MAX_READ_FILE_CHARS = 8000;

const READ_FILE_DEFAULT_LINES = 400;

const READ_FILE_MAX_LINES = 800;

const CHAT_BASH_TIMEOUT_MS = 30_000;

const MAX_BASH_OUTPUT_CHARS = 8000;

const APPLY_LOCK_PATH = path.join(os.homedir(), '.local', 'state', 'agent-manager', 'locks', 'apply-task.lock');

const APPLY_LOCK_CHILD_FD = 3;

const RISKY_GIT_COMMAND_RE = /\bgit\s+(merge\b|push\b)/;

function resolveInsideRepo(repoRoot, relPath) {
  const rootResolved = path.resolve(repoRoot);
  const full = path.resolve(repoRoot, relPath || '');
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

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

function rootsAndArgs(a, b) {
  return Array.isArray(a)
    ? { roots: a, args: b || {} }
    : { roots: [getConfig().repoRoot], args: a || {} };
}

function boundWindow(lines, off, endLine) {
  const whole = lines.slice(off - 1, endLine).join('\n');
  if (whole.length <= MAX_READ_FILE_CHARS) return { slice: whole, truncated: false, returnedThrough: endLine };
  let used = 0;
  let kept = 0;
  for (let i = off - 1; i < endLine; i += 1) {
    const add = lines[i].length + (kept ? 1 : 0);
    if (used + add > MAX_READ_FILE_CHARS) break;
    used += add;
    kept += 1;
  }
  if (kept === 0) {
    return {
      slice: `${lines[off - 1].slice(0, MAX_READ_FILE_CHARS)}\n...[truncated: slice exceeded ${MAX_READ_FILE_CHARS} chars, narrow the line window]`,
      truncated: true,
      returnedThrough: off,
    };
  }
  const returnedThrough = off + kept - 1;
  return {
    slice: `${lines.slice(off - 1, returnedThrough).join('\n')}\n...[truncated: slice exceeded ${MAX_READ_FILE_CHARS} chars after line ${returnedThrough}; continue with offset=${returnedThrough + 1}]`,
    truncated: true,
    returnedThrough,
  };
}

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
  // Hard char ceiling still applies to the slice itself (a file with pathological line
  // lengths must not blow the payload). If it bites, only whole lines that fit are returned.
  const { slice, truncated, returnedThrough } = boundWindow(lines, offset, endLine);
  const nextOffset = returnedThrough < totalLines ? returnedThrough + 1 : null;

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

function listRootsTool(a) {
  const roots = Array.isArray(a) ? a : [getConfig().repoRoot];
  return {
    primary: roots[0],
    roots: roots.map((r, i) => ({ path: r, name: path.basename(r), primary: i === 0 })),
  };
}

function capBashOutput(text) {
  const s = (text || '').toString();
  if (s.length <= MAX_BASH_OUTPUT_CHARS) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, MAX_BASH_OUTPUT_CHARS)}\n...[truncated: output exceeded ${MAX_BASH_OUTPUT_CHARS} chars, narrow the command (e.g. pipe through head/tail/grep) and retry]`,
    truncated: true,
  };
}

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
    console.error(`[local-tool-client] write failed ${full}: ${e.message}`, e.stack);
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
  // Function replacer: a string replacement would interpret `$$`/`$&`/`` $` ``/`$'`/`$<n>`
  // in `replace` (e.g. a regex literal ending `(.+)$` inside a template string). Substitute
  // verbatim. Uniqueness already enforced just above.
  const replacement = replace || '';
  const updated = content.replace(find, () => replacement);
  try {
    fs.writeFileSync(full, updated);
  } catch (e) {
    return { error: `could not write ${relPath}: ${e.message}` };
  }
  return { path: relPath, edited: true };
}

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
  const { command, readOnly } = args;
  if (typeof command !== 'string' || !command.trim()) {
    return { error: 'run_bash requires a non-empty "command" argument' };
  }
  if (RISKY_GIT_COMMAND_RE.test(command)) {
    return {
      error: 'git merge/push is not available via run_bash. The pipeline does not perform git '
        + 'operations either: it commits and pushes an unmerged branch itself after a draft passes '
        + 'review, and a human merges it from the dashboard\'s Unmerged Branches tab (which checks '
        + 'for conflicts first). Investigate and recommend; do not queue a task to merge, push or commit.',
    };
  }
  const realRoots = allowedRoots.map((r) => fs.realpathSync(r));
  const wrapped = wrapWithSandbox('bash', ['-c', command], {
    workDir: realRoots[0],
    // Every accessible repo is still BOUND (must be, or --chdir into it fails and every
    // command errors, read or write) -- just read-only instead of writable when this is
    // Chat's own restricted handler (readOnly:true, see buildChatToolHandlers). 2026-09-15
    // (Grimmethy: "I'd like to see the local chat stick to the task system when making
    // these fixes... build it in such a way that it honors the task log system and
    // pushes the fix to unmerged branches for review"): Chat no longer gets write_file/
    // edit_file at all (see CHAT_TOOLS below) and this read-only mount is the same
    // guarantee applied to its remaining run_bash access -- a real filesystem-level
    // block, not a string-matched command-shape guess the way RISKY_GIT_COMMAND_RE above
    // necessarily is (that check stays too, for a clear error message instead of an
    // opaque permission-denied one). Every accessible repo stays writable for every
    // OTHER allowWrite caller (the real agentic-draft implement pass,
    // local-agentic-write-draft.js) -- unaffected, readOnly is never set there.
    readOnlyBinds: readOnly
      ? ['/usr', '/bin', '/lib', '/lib64', '/etc/resolv.conf', '/etc/ssl', ...realRoots]
      : ['/usr', '/bin', '/lib', '/lib64', '/etc/resolv.conf', '/etc/ssl'],
    writableBinds: readOnly ? [] : realRoots,
  });
  if (!wrapped.available) {
    // Fails CLOSED here, not open -- unlike the Claude adhoc path (a hardening layer on
    // top of an already-trusted actor), an unsandboxed local-model Bash call is new,
    // meaningfully riskier territory this codebase has never granted before. No bwrap,
    // no local-model shell access, full stop.
    return { error: 'sandbox (bwrap) is not available on this host -- run_bash is disabled without it' };
  }
  try {
    const rawStdout = withApplyLock(() => execFileSync(wrapped.command, wrapped.args, {
      encoding: 'utf8', timeout: CHAT_BASH_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    }));
    const { text: stdout, truncated } = capBashOutput(rawStdout);
    return { command, stdout, exitCode: 0, truncated };
  } catch (e) {
    const { text: stdout, truncated } = capBashOutput(e.stdout);
    return {
      command,
      stdout,
      stderr: (e.stderr || e.message || '').toString().slice(0, 2000),
      exitCode: e.status != null ? e.status : null,
      timedOut: e.signal === 'SIGTERM' && e.killed === true,
      truncated,
    };
  }
}

module.exports = { resolveInsideRepo, resolveInsideRoots, rootsAndArgs, boundWindow, readFileTool, listDirectoryTool, listRootsTool, capBashOutput, writeFileTool, editFileTool, withApplyLock, runBashTool, MAX_READ_FILE_CHARS, READ_FILE_DEFAULT_LINES, READ_FILE_MAX_LINES, APPLY_LOCK_PATH, APPLY_LOCK_CHILD_FD, RISKY_GIT_COMMAND_RE, CHAT_BASH_TIMEOUT_MS, MAX_BASH_OUTPUT_CHARS };
