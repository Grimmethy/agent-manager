'use strict';

// local-tool-fs-tools.js -- extracted from src/local-tool-client.js ([[hub-task-integration]] node-module decompose).

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const { wrapWithSandbox } = require('./sandbox.js');
const { isSecretLookingPath } = require('./accessible-roots.js');

const MAX_READ_FILE_CHARS = 8000;

const READ_FILE_DEFAULT_LINES = 400;

const READ_FILE_MAX_LINES = 800;

const CHAT_BASH_TIMEOUT_MS = 30_000;

const MAX_BASH_OUTPUT_CHARS = 8000;

// list_directory returns at most this many entries per call (2026-10-25: one call on a 3876-entry archive folder returned ~457k characters and overflowed the
// model's context window); the result says how to page (offset) or narrow (prefix).
const LIST_DIR_MAX_ENTRIES = 200;

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

// readOnlyRoots (the implement pass's sibling repos): the optional list of roots in `allowedRoots` that are read-only. Absent for every other caller.
function inReadOnlyRoot(readOnlyRoots, full) {
  if (!Array.isArray(readOnlyRoots) || !readOnlyRoots.length) return false;
  return readOnlyRoots.some((r) => { const root = path.resolve(r); return full === root || full.startsWith(root + path.sep); });
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
  if (inReadOnlyRoot(args.readOnlyRoots, full) && isSecretLookingPath(full)) {
    return { error: `refusing to read a credential-looking file in a read-only sibling repo: ${relPath}` };
  }
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
  const siblingRead = inReadOnlyRoot(args.readOnlyRoots, full);
  if (siblingRead && isSecretLookingPath(full)) {
    return { error: `refusing to list a credential-looking path in a read-only sibling repo: ${target}` };
  }
  let entries;
  try {
    entries = fs.readdirSync(full, { withFileTypes: true });
  } catch (e) {
    return { error: `could not list ${target}: ${e.message}` };
  }
  if (siblingRead) entries = entries.filter((e) => !isSecretLookingPath(e.name));
  // Names and kind only -- deliberately not a recursive full-tree dump (see this file's
  // own header: keep this simple, list_directory is one shallow level per call).
  // Sorted by name (code-unit order) so the page order is stable; an optional `prefix` keeps only names that start with it; one page is at most
  // LIST_DIR_MAX_ENTRIES entries from `offset`, and `truncated` / `nextOffset` / `note` say how to get the rest.
  const prefix = typeof args.prefix === 'string' ? args.prefix : '';
  const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) > 0 ? Math.trunc(Number(args.offset)) : 0;
  const all = entries
    .filter((e) => !prefix || e.name.startsWith(prefix))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const page = all.slice(offset, offset + LIST_DIR_MAX_ENTRIES);
  const truncated = all.length > offset + page.length;
  const result = {
    path: target,
    entries: page.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
    totalEntries: all.length,
    truncated,
    nextOffset: truncated ? offset + page.length : null,
  };
  if (truncated) {
    result.note = `Listing capped at ${LIST_DIR_MAX_ENTRIES} entries (${all.length} match). Pass offset=${offset + page.length} to read the next page, prefix=<start of a name> to narrow it, `
      + 'or use grep_codebase or a more specific path.';
  }
  return result;
}

function listRootsTool(a, readOnlyRoots = []) {
  const roots = Array.isArray(a) ? a : [getConfig().repoRoot];
  return {
    primary: roots[0],
    roots: roots.map((r, i) => (readOnlyRoots.includes(r)
      ? { path: r, name: path.basename(r), primary: false, readOnly: true }
      : { path: r, name: path.basename(r), primary: i === 0 })),
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

function readOnlySiblingHit(readOnlyRoots, relPath) {
  return path.isAbsolute(relPath) && inReadOnlyRoot(readOnlyRoots, path.resolve(relPath));
}

function writeFileTool(a, b) {
  const { roots: allowedRoots, args } = rootsAndArgs(a, b);
  const { path: relPath, content } = args;
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { error: 'write_file requires a non-empty "path" argument' };
  }
  const resolved = resolveInsideRoots(allowedRoots, relPath);
  if (!resolved) {
    if (readOnlySiblingHit(args.readOnlyRoots, relPath)) return { error: `${relPath} is in a read-only sibling repo, refusing to write it. Writes are limited to this task's own checkout.` };
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

// Tiered edit_file matching (2026-10-18, brain-dump 1890, harness-derived): when the exact `find` misses,
// try the fallback tiers the competition harness uses (adk_eval_core/editing/edit.py) -- a line-window match
// that ignores trailing whitespace, then indentation (the replacement is re-indented to the file's own
// indentation), then the same on JSON-unescaped text (models that send `\n` / `\"` literally). The harness's
// regex tier is not ported. Every tier keeps the uniqueness rule: more than one hit is not applied.
//
// AGENT_MANAGER_EDIT_FILE_TIERS=on (or 1/true) enables applying a fallback; default OFF. Off, an exact miss still
// runs the tiers as a SHADOW PROBE: the would-be strategy is attached to the error result as a non-enumerable
// `matchProbe`, which the tool-loop audit records but JSON.stringify (what the model sees) leaves out. Measured
// when this was written (tool-loop audit, 2026-10-18): 3 of 54 edit_file calls missed, cause unknown -- the probe
// counts are what should decide switching the tiers on.
function editTiersEnabled() {
  const v = String(process.env.AGENT_MANAGER_EDIT_FILE_TIERS || '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}

function splitKeepEnds(text) {
  const out = [];
  const re = /[^\n]*\n|[^\n]+$/g;
  let m;
  while ((m = re.exec(text)) !== null) { if (m[0] === '') break; out.push(m[0]); }
  return out;
}

const stripEol = (l) => l.replace(/\r?\n$/, '');
const leadingWs = (l) => /^[ \t]*/.exec(l)[0];
const minIndent = (lines) => {
  const ns = lines.filter((l) => l.trim());
  return ns.length ? Math.min(...ns.map((l) => leadingWs(l).length)) : 0;
};

// The unique line window `find` matches once whitespace is relaxed, or { count > 1 } / null.
function flexibleMatch(content, find) {
  const findLines = find.replace(/\r?\n$/, '').split(/\r?\n/);
  if (!findLines.some((l) => l.trim())) return null;
  const lines = splitKeepEnds(content);
  const n = findLines.length;
  for (const [strategy, norm] of [['flexible-rstrip', (l) => l.replace(/\s+$/, '')], ['flexible-strip', (l) => l.trim()]]) {
    const want = findLines.map(norm);
    const hits = [];
    for (let i = 0; i + n <= lines.length; i += 1) {
      let ok = true;
      for (let k = 0; k < n; k += 1) if (norm(stripEol(lines[i + k])) !== want[k]) { ok = false; break; }
      if (ok) { hits.push(i); i += n - 1; }
    }
    if (hits.length) return { strategy, count: hits.length, startLine: hits[0], lines, n, findLines };
  }
  return null;
}

// Replacement text for the matched window, re-indented to the window's own indentation (plus the replacement's
// indent relative to `find`), with the window's line ending and trailing newline.
function reindentReplacement(window, findLines, replace) {
  const eol = window.some((l) => l.endsWith('\r\n')) ? '\r\n' : '\n';
  const newLines = replace.replace(/\r?\n$/, '').split(/\r?\n/);
  if (replace === '') return '';
  const base = leadingWs(window.find((l) => l.trim() && leadingWs(l).length === minIndent(window.map(stripEol))) || window[0]);
  const delta = Math.max(0, minIndent(newLines) - minIndent(findLines));
  const ref = minIndent(newLines);
  const body = newLines.map((l) => (l.trim() ? base + ' '.repeat(delta) + l.slice(ref) : '')).join(eol);
  const last = window[window.length - 1];
  return last.endsWith('\n') ? body + eol : body;
}

function applyFlexible(content, find, replace) {
  const m = flexibleMatch(content, find);
  if (!m) return null;
  if (m.count > 1) return { ambiguous: m.count, strategy: m.strategy };
  const window = m.lines.slice(m.startLine, m.startLine + m.n);
  const before = m.lines.slice(0, m.startLine).join('');
  const after = m.lines.slice(m.startLine + m.n).join('');
  return { updated: before + reindentReplacement(window, m.findLines, replace) + after, strategy: m.strategy };
}

// `s` with one JSON string-escape layer removed, only when it carries literal escapes and no real newline.
function unescapeJsonText(s) {
  if (typeof s !== 'string' || s.includes('\n') || !/\\[nt"\\]/.test(s)) return null;
  try { return JSON.parse(`"${s.replace(/(^|[^\\])"/g, '$1\\"')}"`); } catch { return null; }
}

// The first fallback tier that hits: { updated, strategy } (unique), { ambiguous, strategy }, or null.
function tryFallbackTiers(content, find, replace) {
  const flex = applyFlexible(content, find, replace);
  if (flex) return flex;
  const uFind = unescapeJsonText(find);
  if (uFind === null) return null;
  const uReplace = unescapeJsonText(replace || '') ?? (replace || '');
  const exactHits = content.split(uFind).length - 1;
  if (exactHits === 1) return { updated: content.replace(uFind, () => uReplace), strategy: 'unescaped' };
  if (exactHits > 1) return { ambiguous: exactHits, strategy: 'unescaped' };
  const uFlex = applyFlexible(content, uFind, uReplace);
  return uFlex ? { ...uFlex, strategy: `unescaped+${uFlex.strategy}` } : null;
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
    if (readOnlySiblingHit(args.readOnlyRoots, relPath)) return { error: `${relPath} is in a read-only sibling repo, refusing to edit it. Writes are limited to this task's own checkout.` };
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
    const fallback = tryFallbackTiers(content, find, replace);
    if (fallback && fallback.updated != null && editTiersEnabled()) {
      try {
        fs.writeFileSync(full, fallback.updated);
      } catch (e) {
        return { error: `could not write ${relPath}: ${e.message}` };
      }
      return { path: relPath, edited: true, matchStrategy: fallback.strategy };
    }
    const miss = { error: `"find" text not found verbatim in ${relPath} -- no change made. Re-read the file and match it exactly.` };
    // Shadow probe (see the tier block's header): audit-only, invisible to JSON.stringify and so to the model.
    if (fallback) Object.defineProperty(miss, 'matchProbe', { value: fallback.updated != null ? fallback.strategy : `${fallback.strategy}-ambiguous`, enumerable: false });
    return miss;
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
  const siblingRoots = readOnly ? [] : (Array.isArray(args.readOnlyRoots) ? args.readOnlyRoots : []).map((r) => { try { return fs.realpathSync(r); } catch { return null; } }).filter(Boolean);
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
      : ['/usr', '/bin', '/lib', '/lib64', '/etc/resolv.conf', '/etc/ssl', ...siblingRoots],
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

module.exports = { resolveInsideRepo, resolveInsideRoots, rootsAndArgs, boundWindow, readFileTool, listDirectoryTool, listRootsTool, capBashOutput, writeFileTool, editFileTool, editTiersEnabled, tryFallbackTiers, unescapeJsonText, withApplyLock, runBashTool, LIST_DIR_MAX_ENTRIES, MAX_READ_FILE_CHARS, READ_FILE_DEFAULT_LINES, READ_FILE_MAX_LINES, APPLY_LOCK_PATH, APPLY_LOCK_CHILD_FD, RISKY_GIT_COMMAND_RE, CHAT_BASH_TIMEOUT_MS, MAX_BASH_OUTPUT_CHARS };
