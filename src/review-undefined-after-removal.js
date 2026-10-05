'use strict';

// Undefined-identifier-after-removal check for the review step (brain dump #1768, 2026-10-05).
//
// Why: TaxHarvest arch-review-ac-46 renamed STATUS_* positional constants to STATUS.<key>. Its edits deleted the destructuring that declared STATUS_PENDING but left one
// use (`prev.status !== STATUS_PENDING`) on a line the edit never touched, so every task claim threw ReferenceError. The review approved it; arch-review-ac-47 repeated the
// shape with five names. `node --check` and the covering tests cannot see a reference to an undefined name on an untested path, and the diff-based review checks only run for
// adhoc drafts that carry a rawDiff -- candidate lanes (arch_review, the *_fix sources) carry their draft as an array of {mode:'edit', file, find, replace} edits.
//
// What: given a draft as a unified diff and/or an edit array, report every identifier whose declaration the change REMOVES and that is still USED in the file after the change.
// The leftover use is usually on an unchanged line far from the edit, so this rebuilds the post-change file (base file from `git show <baseRef>:<file>` plus the change) and
// scans it. Precision over recall, because a wrong block costs a review cycle: a name is skipped when any text the change adds declares it again (a move or a rename keeps the
// name), when the post-change file still declares it anywhere (an inner scope, a parameter), or when it is a JS/Node global.
//
// Same-file only: a removed export that OTHER files import is a different check (not here). JS family only (.js .mjs .cjs .jsx .ts .tsx).
// Never throws: a base file that cannot be read, or a change that does not apply cleanly, counts as `unknown` and is never reported.

const { execFileSync } = require('child_process');

const JS_RE = /\.(?:[cm]?js|jsx|tsx?)$/;
const MAX_NAMES = 40;
const MAX_LINES = 5;
const NAME_MIN = 2;
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'typeof', 'await', 'yield', 'new', 'in', 'of']);
const GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'global', 'window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'self', 'process', 'console', 'require', 'module',
  'exports', '__dirname', '__filename', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'Blob', 'FormData', 'Headers', 'Request',
  'Response', 'fetch', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'structuredClone', 'performance', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Symbol', 'BigInt', 'Function', 'JSON', 'Math', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy',
  'Reflect', 'Intl', 'Uint8Array', 'Int32Array', 'Float64Array', 'ArrayBuffer', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'atob', 'btoa',
  'React', 'alert', 'confirm', 'prompt', 'arguments', 'this',
]);

// Whether a '/' at the end of `out` can start a regex literal (an operator or opening bracket before it) rather than a division.
function regexAllowedAfter(out) {
  const m = out.match(/([A-Za-z_$][\w$]*|\S)\s*$/);
  if (!m) return true;
  const tok = m[1];
  if (/^[A-Za-z_$]/.test(tok)) return /^(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(tok);
  return !/^[)\]}\w$'"`]$/.test(tok);
}

// Source with comments and string contents blanked (newlines and line numbers preserved); `${...}` code inside a template literal is kept because it is real code.
function stripNonCode(src) {
  const s = String(src || '');
  const n = s.length;
  const stack = [];                       // contexts: { tpl: true } | { expr: true, braces: n }
  let out = '';
  let i = 0;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    const top = stack[stack.length - 1];
    if (top && top.tpl) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '`') { out += '`'; stack.pop(); i += 1; continue; }
      if (c === '$' && d === '{') { out += '  '; stack.push({ expr: true, braces: 0 }); i += 2; continue; }
      out += blank(c); i += 1; continue;
    }
    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') { out += ' '; i += 1; } continue; }
    if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { out += blank(s[i]); i += 1; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {
      out += c; i += 1;
      while (i < n && s[i] !== c && s[i] !== '\n') { if (s[i] === '\\') { out += '  '; i += 2; continue; } out += ' '; i += 1; }
      if (i < n && s[i] === c) { out += c; i += 1; }
      continue;
    }
    if (c === '/' && regexAllowedAfter(out)) {
      // a regex literal: blank its body (it is not code), keep the slashes and flags; a class [...] may contain an unescaped '/'
      let j = i + 1; let inClass = false; let closed = false;
      while (j < n && s[j] !== '\n') {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '[') inClass = true; else if (s[j] === ']') inClass = false; else if (s[j] === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) { out += '/'; for (let k = i + 1; k < j; k += 1) out += ' '; out += '/'; i = j + 1; continue; }
    }
    if (c === '`') { out += '`'; stack.push({ tpl: true }); i += 1; continue; }
    if (top && top.expr) {
      if (c === '{') top.braces += 1;
      else if (c === '}') {
        if (top.braces === 0) { out += ' '; stack.pop(); i += 1; continue; }
        top.braces -= 1;
      }
    }
    out += c; i += 1;
  }
  return out;
}

function listNames(part) {
  const out = [];
  for (const raw of String(part || '').split(',')) {
    let p = raw.trim();
    if (!p || /[{[]/.test(p)) continue;                    // nested pattern: not handled (recall, not precision)
    p = p.replace(/^\.\.\./, '');
    const colon = p.indexOf(':');
    if (colon >= 0) p = p.slice(colon + 1);                // { a: b } binds b
    const eq = p.indexOf('=');
    if (eq >= 0) p = p.slice(0, eq);                       // default value
    const m = p.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    if (m) out.push(m[2] || m[1]);
  }
  return out;
}

// Names the text declares as variables, functions, classes or imports.
function removedDeclarations(text) {
  const t = stripNonCode(text);
  const names = new Set();
  const add = (list) => { for (const x of list) if (x.length >= NAME_MIN) names.add(x); };
  let m;
  const objRe = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
  while ((m = objRe.exec(t))) add(listNames(m[1]));
  const arrRe = /\b(?:const|let|var)\s*\[([^\]]*)\]\s*=/g;
  while ((m = arrRe.exec(t))) add(listNames(m[1]));
  const plainRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = plainRe.exec(t))) add([m[1]]);
  const fnRe = /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
  while ((m = fnRe.exec(t))) add([m[1]]);
  const clsRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  while ((m = clsRe.exec(t))) add([m[1]]);
  const impDefRe = /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\b/g;
  while ((m = impDefRe.exec(t))) { add([m[1]]); if (m[2]) add(listNames(m[2])); }
  const impNamedRe = /\bimport\s*\{([^}]*)\}\s*from\b/g;
  while ((m = impNamedRe.exec(t))) add(listNames(m[1]));
  const impStarRe = /\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g;
  while ((m = impStarRe.exec(t))) add([m[1]]);
  return names;
}

// Every name the text could bind: declarations plus parameters (over-inclusive on purpose -- this is only used to SKIP a name).
function boundNames(text) {
  const t = stripNonCode(text);
  const names = removedDeclarations(text);
  const tokens = (s) => { for (const x of String(s || '').match(/[A-Za-z_$][\w$]*/g) || []) names.add(x); };
  let m;
  const arrowParens = /\(([^()]*)\)\s*=>/g;
  while ((m = arrowParens.exec(t))) tokens(m[1]);
  const arrowOne = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = arrowOne.exec(t))) tokens(m[1]);
  const fnParams = /\bfunction\s*\*?\s*[A-Za-z_$]*\s*\(([^()]*)\)/g;
  while ((m = fnParams.exec(t))) tokens(m[1]);
  const methodDef = /(?:^|[\s,{;}])(?:(?:async|static|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g;
  while ((m = methodDef.exec(t))) { if (!CONTROL.has(m[1])) tokens(m[2]); }
  const catchRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g;
  while ((m = catchRe.exec(t))) names.add(m[1]);
  return names;
}

// Lines of `post` that USE `name`: not a member access (`.name`), not an object key (`{ name:` / `, name:`), not inside a comment or string. A spread (`...name`) is a use.
function usesOf(post, name) {
  const stripped = stripNonCode(post).split('\n');
  const original = String(post).split('\n');
  const re = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g');
  const out = [];
  for (let i = 0; i < stripped.length; i += 1) {
    const line = stripped[i];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + name.length);
      if (/(?<!\.)\.\s*$/.test(before)) continue;                                  // member access (`obj.name`, `obj?.name`)
      if (/[{,]\s*$/.test(before) && /^\s*:(?!:)/.test(after)) continue;           // object-literal key
      if (/(?:^|[^\w$])(?:const|let|var|function|class)\s+$/.test(before)) continue; // a declaration, not a use
      out.push({ line: i + 1, text: String(original[i] || '').trim().slice(0, 140) });
      break;
    }
  }
  return out;
}

// ---- the change: unified diff and edit array -> per-file { file, base?, hunks | edits | content, removed, added } ----

function parseDiffChanges(rawDiff) {
  const files = [];
  for (const chunk of String(rawDiff || '').split(/^(?=diff --git )/m)) {
    const head = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!head) continue;
    if (/^(?:Binary files|GIT binary patch)/m.test(chunk)) continue;
    const first = chunk.search(/^@@ /m);
    const header = first < 0 ? chunk : chunk.slice(0, first);
    const entry = { file: head[2], isNew: /^new file mode/m.test(header), isDeleted: /^deleted file mode/m.test(header), isRename: /^rename from /m.test(header), hunks: [], removed: [], added: [] };
    if (first >= 0) {
      for (const hunk of chunk.slice(first).split(/^(?=@@ )/m)) {
        const hh = hunk.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
        if (!hh) continue;
        const h = { oldStart: Number(hh[1]), oldLen: hh[2] === undefined ? 1 : Number(hh[2]), oldLines: [], newLines: [] };
        for (const line of hunk.split('\n').slice(1)) {
          if (line.startsWith('\\')) continue;
          if (line.startsWith('-')) { h.oldLines.push(line.slice(1)); entry.removed.push(line.slice(1)); }
          else if (line.startsWith('+')) { h.newLines.push(line.slice(1)); entry.added.push(line.slice(1)); }
          else if (line.startsWith(' ')) { h.oldLines.push(line.slice(1)); h.newLines.push(line.slice(1)); }
        }
        // a trailing empty element from the final newline of the diff is not a context line
        if (h.oldLines.length > h.oldLen && h.oldLines[h.oldLines.length - 1] === '' && h.newLines[h.newLines.length - 1] === '') { h.oldLines.pop(); h.newLines.pop(); }
        entry.hunks.push(h);
      }
    }
    files.push(entry);
  }
  return files;
}

function applyHunks(base, hunks) {
  const lines = String(base).split('\n');
  let offset = 0;
  for (const h of hunks) {
    const idx = (h.oldLines.length === 0 ? h.oldStart : h.oldStart - 1) + offset;
    const have = lines.slice(idx, idx + h.oldLines.length);
    if (have.length !== h.oldLines.length || have.some((l, k) => l !== h.oldLines[k])) return null;
    lines.splice(idx, h.oldLines.length, ...h.newLines);
    offset += h.newLines.length - h.oldLines.length;
  }
  return lines.join('\n');
}

// Group an edit array by file in order, like apply-group-b applies it: edit = replace the find text once, create = new file, delete = file removed.
function changesFromEdits(edits) {
  const byFile = new Map();
  for (const op of Array.isArray(edits) ? edits : []) {
    if (!op || typeof op.file !== 'string') continue;
    if (!byFile.has(op.file)) byFile.set(op.file, { file: op.file, isNew: false, isDeleted: false, edits: [], removed: [], added: [] });
    const c = byFile.get(op.file);
    if (op.mode === 'edit' && typeof op.find === 'string' && typeof op.replace === 'string') { c.edits.push({ find: op.find, replace: op.replace }); c.removed.push(op.find); c.added.push(op.replace); }
    else if (op.mode === 'create' && typeof op.content === 'string') { c.isNew = true; c.content = op.content; c.added.push(op.content); }
    else if (op.mode === 'delete') c.isDeleted = true;
  }
  return [...byFile.values()];
}

function defaultReadBase(repoRoot, baseRef, file) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'show', `${baseRef}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  } catch { return null; }
}

function postImageOf(change, base) {
  if (change.isNew && typeof change.content === 'string') return change.content;
  if (change.isNew) return change.added.join('\n');
  if (base === null || base === undefined) return null;
  if (change.edits && change.edits.length) {
    let post = base;
    for (const e of change.edits) {
      if (!e.find || !post.includes(e.find)) return null;
      post = post.replace(e.find, () => e.replace);
    }
    return post;
  }
  if (change.hunks && change.hunks.length) return applyHunks(base, change.hunks);
  return base;
}

/**
 * @param {{ rawDiff?: string, edits?: Array, repoRoot?: string, baseRef?: string, readBase?: (file: string) => string|null }} args
 * @returns {{ considered: number, unknown: number, uses: Array<{ file: string, name: string, lines: Array<{ line: number, text: string }> }> }}
 */
function findUndefinedAfterRemoval({ rawDiff, edits, repoRoot, baseRef, readBase } = {}) {
  const result = { considered: 0, unknown: 0, uses: [] };
  try {
    const read = readBase || ((file) => defaultReadBase(repoRoot, baseRef, file));
    const all = [...parseDiffChanges(rawDiff).filter((c) => !c.isRename), ...changesFromEdits(edits)];
    const changes = all.filter((c) => JS_RE.test(c.file));
    const addedBound = boundNames(changes.map((c) => c.added.join('\n')).join('\n'));
    for (const change of changes) {
      if (change.isDeleted) continue;                                   // the declarations go away with the file; uses elsewhere are the cross-file check's business
      const removedNames = [...removedDeclarations(change.removed.join('\n'))].filter((nm) => !GLOBALS.has(nm) && !addedBound.has(nm));
      if (!removedNames.length) continue;
      const base = change.isNew ? '' : read(change.file);
      const post = postImageOf(change, base);
      if (post === null || post === undefined) { result.unknown += 1; continue; }
      const postBound = boundNames(post);
      for (const name of removedNames) {
        if (result.considered >= MAX_NAMES) return result;
        result.considered += 1;
        if (postBound.has(name)) continue;
        const lines = usesOf(post, name);
        if (lines.length) result.uses.push({ file: change.file, name, lines: lines.slice(0, MAX_LINES) });
      }
    }
  } catch {
    result.unknown += 1;
  }
  return result;
}

module.exports = { findUndefinedAfterRemoval, changesFromDiff: parseDiffChanges, changesFromEdits, removedDeclarations, boundNames, usesOf, stripNonCode, applyHunks, postImageOf, MAX_NAMES, MAX_LINES };
