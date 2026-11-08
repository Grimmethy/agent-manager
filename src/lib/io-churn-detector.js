'use strict';

// io-churn-detector.js -- one shared, deterministic definition of the mistakes that make Ollama reload the resident model (docs/agents/io-churn-detector.md).
//
// Why it exists: on 2026-11-06 the 21 GB local model was reloaded from the SSD 13-20 times an hour (IO pressure 87-95%) because code (a) sent a num_ctx different from the pinned
// one (a different context restarts Ollama's runner), (b) sent a finite keep_alive over the server's never-expire, (c) unloaded the model, or (d) POSTed to Ollama directly instead of
// through src/local-client.js (which pins the context, sends the never-expire keep_alive and waits for the model to be resident). This module is the shared definition; the prompt lines
// (src/lib/io-avoidance-lines.js) and the pre-merge gates use it. Like src/lib/poll-detector.js it is deterministic and reads only text.
//
//   parseAnnotation(lines, index) -> { annotated, reason }   `io-ok: <reason>` in a comment on line `index` or the line above; an empty reason does not count
//   scanText({ language, path, text })                       -> Finding[]   (every line)
//   scanDiff(unifiedDiff, { includeTests })                   -> Finding[]   (ADDED lines only, new-file line numbers)
//   isSanctionedPath(path)                                    -> true for the files that ARE the one place allowed to name these things
//   signatureOf(finding)                                      -> sha1 hex of path|kind|snippet: survives a line move
// Finding = { path, line, language, kind, severity ('churn'), snippet, annotated, reason, signature }

const crypto = require('crypto');
const { languageOf, shebangLanguage, isTestPath } = require('./poll-detector.js');

const IO_OK_TOKEN = 'io-ok:';
const KINDS = ['caller-num-ctx', 'finite-keep-alive', 'unload-call', 'direct-model-call'];
// The only files that may name a context size, a keep-alive or the Ollama endpoints: the sources of truth and the shared clients everything else goes through.
const SANCTIONED_PATHS = [
  'src/gpu-capacity.js', 'src/keep-alive.js', 'src/local-client.js', 'src/local-tool-client.js', 'src/model-resident.js', 'src/ollama-http.js',
];
const SCANNED_LANGUAGES = new Set(['js', 'py', 'sh']);
// A keep_alive of at least a year is the accepted never-expire (src/keep-alive.js NEVER_EXPIRE = '8760h').
const NEVER_EXPIRE_SECONDS = 8760 * 3600;
const UNIT_SECONDS = { ms: 0.001, s: 1, m: 60, h: 3600 };

const NUM_CTX_RE = /num_?ctx\w*\\?["']?\s*[:=]\s*\d+/i;
const KEEP_ALIVE_RE = /(?:keep_alive|keepAlive|KEEP_ALIVE)\\?["']?\s*[:=]\s*\\?["']?([^,;"'\\\s)}\]]+)/i;
const UNLOAD_RE = /\bunload(?:Model)?\s*\(|\bollama\s+stop\b/;
const DIRECT_CALL_RE = /\/api\/(?:generate|chat)(?![\/\w-])/;
const ANNOTATION_RE = /(?:\/\/|\/\*|<!--|#)[^]*?\bio-ok:[ \t]*([^\n]*)/;

// Third-party and generated trees are not ours to fix.
const VENDOR_RE = /(?:^|\/)(?:vendor|node_modules|\.venv|venv|dist|build)\//;
const isVendorPath = (file) => VENDOR_RE.test(String(file || '').replace(/\\/g, '/'));

function isSanctionedPath(file) {
  const p = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return SANCTIONED_PATHS.some((s) => p === s || p.endsWith(`/${s}`));
}

function annotationOn(line) {
  const m = ANNOTATION_RE.exec(String(line || ''));
  if (!m) return null;
  const reason = m[1].replace(/\*\/\s*$|-->\s*$/, '').trim();
  return reason || null;
}

function parseAnnotation(lines, index) {
  for (const i of [index, index - 1]) {
    if (i < 0 || i >= lines.length) continue;
    const reason = annotationOn(lines[i]);
    if (reason) return { annotated: true, reason };
  }
  return { annotated: false, reason: null };
}

// The code part of a line: null for a comment-only line, else the line without a trailing comment.
function codeOf(line, language) {
  const text = String(line).replace(/\/\*.*?\*\//g, ' ');   // an inline /* ... */ is prose too
  const lineComment = language === 'js' ? /^\s*(?:\/\/|\/\*|\*)/ : /^\s*#/;
  if (lineComment.test(text)) return null;
  return text.replace(language === 'js' ? /\s\/\/.*$/ : /\s#.*$/, '');
}

// Seconds a keep_alive literal asks for, or null when the value is not a literal (a variable name such as NEVER_EXPIRE is the shared constant and is fine).
function keepAliveSeconds(value) {
  const v = String(value).trim();
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v) < 0 ? Infinity : Number(v);
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(v);
  return m ? Number(m[1]) * UNIT_SECONDS[m[2].toLowerCase()] : null;
}

function kindsOfLine(code) {
  const found = [];
  if (NUM_CTX_RE.test(code)) found.push('caller-num-ctx');
  const ka = KEEP_ALIVE_RE.exec(code);
  if (ka) {
    const seconds = keepAliveSeconds(ka[1]);
    if (seconds === 0) found.push('unload-call');
    else if (seconds !== null && seconds < NEVER_EXPIRE_SECONDS) found.push('finite-keep-alive');
  }
  if (UNLOAD_RE.test(code) && !found.includes('unload-call')) found.push('unload-call');
  if (DIRECT_CALL_RE.test(code)) found.push('direct-model-call');
  return found;
}

function signatureOf(f) {
  const snippet = String(f.snippet || '').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(`${f.path}|${f.kind}|${snippet}`).digest('hex');
}

// Walks the lines tracking prose that is not code: a python docstring (triple quotes) or a js block comment. `starts` = line numbers where a diff hunk begins (the
// state is reset there: a hunk is assumed to start in code). Returns the code part of each line, or null for prose.
const TRIPLE_QUOTE = /"""|'''/g;
const STARTS_WITH_TRIPLE_QUOTE = /^\s*[rRuUbB]?(?:"""|''')/;
function codeLines(lines, language, starts) {
  let inProse = false;
  return lines.map((raw, index) => {
    if (starts && starts.has(index + 1)) inProse = false;
    const text = String(raw);
    if (language === 'py') {
      const odd = (text.match(TRIPLE_QUOTE) || []).length % 2 === 1;
      if (inProse) { if (odd) inProse = false; return null; }
      if (STARTS_WITH_TRIPLE_QUOTE.test(text)) { if (odd) inProse = true; return null; }
      if (odd) inProse = true;
      return codeOf(text, language);
    }
    if (language === 'js') {
      if (inProse) { if (text.includes('*/')) inProse = false; return null; }
      const open = text.indexOf('/*');
      if (open !== -1 && text.indexOf('*/', open + 2) === -1) { inProse = true; return codeOf(text.slice(0, open), language); }
    }
    return codeOf(text, language);
  });
}

// lines: every line of the file (index = line - 1); only those in `only` (a Set of 1-based numbers) are reported.
function scanLines(lines, language, file, only, starts) {
  const out = [];
  const code = codeLines(lines, language, starts);
  lines.forEach((raw, index) => {
    const n = index + 1;
    if (only && !only.has(n)) return;
    if (code[index] === null) return;
    for (const kind of kindsOfLine(code[index])) {
      const note = parseAnnotation(lines, index);
      const f = { path: file, line: n, language, kind, severity: 'churn', snippet: String(raw).trim().slice(0, 200), annotated: note.annotated, reason: note.reason };
      f.signature = signatureOf(f);
      out.push(f);
    }
  });
  return out;
}

function scanText({ language, path: file, text, includeTests = false }) {
  if (!SCANNED_LANGUAGES.has(language) || isSanctionedPath(file) || isVendorPath(file) || (!includeTests && isTestPath(file))) return [];
  return scanLines(String(text).split('\n'), language, file, null, null);
}

// Added lines with their new-file line numbers, plus the context lines (so an annotation on the line above is seen).
function parseDiff(diff) {
  const files = [];
  let cur = null; let n = 0; let prev = '';
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++ ') && prev.startsWith('--- ')) {   // a file header always follows its '--- ' line; an added line "++ x" does not
      const m = /^\+\+\+ (?:b\/)?(.+?)\s*$/.exec(line);
      cur = m && m[1] !== '/dev/null' ? { file: m[1], known: new Map(), added: new Set(), starts: new Set() } : null;
      if (cur) files.push(cur);
      n = 0;
    } else if (cur && line.startsWith('@@')) {
      const m = /\+(\d+)/.exec(line);
      n = m ? Number(m[1]) : 0;
      if (n > 0) cur.starts.add(n);
    } else if (cur && n > 0) {
      if (line.startsWith('+')) { cur.known.set(n, line.slice(1)); cur.added.add(n); n += 1; }
      else if (line.startsWith(' ')) { cur.known.set(n, line.slice(1)); n += 1; }
    }
    prev = line;
  }
  return files;
}

function scanDiff(unifiedDiff, opts = {}) {
  const out = [];
  for (const entry of parseDiff(unifiedDiff)) {
    let language = languageOf(entry.file);
    if (!language && entry.added.has(1)) language = shebangLanguage(entry.known.get(1));
    if (!SCANNED_LANGUAGES.has(language) || isSanctionedPath(entry.file) || isVendorPath(entry.file) || (!opts.includeTests && isTestPath(entry.file))) continue;
    let last = 0;
    for (const [n] of entry.known) last = Math.max(last, n);
    const lines = [];
    for (let n = 1; n <= last; n += 1) lines.push(entry.known.has(n) ? entry.known.get(n) : '');
    out.push(...scanLines(lines, language, entry.file, entry.added, entry.starts));
  }
  return out;
}

module.exports = { IO_OK_TOKEN, KINDS, SANCTIONED_PATHS, parseAnnotation, scanText, scanDiff, isSanctionedPath, signatureOf };
