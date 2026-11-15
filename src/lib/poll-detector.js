'use strict';

// poll-detector.js -- one shared, deterministic definition of a "poll" (ADR-0024 "triggers, not polls": docs/adr/0024-triggers-not-polls.md).
//
// FOUNDATION ONLY, no caller yet: a later hub wires the pre-merge gate, the code-generation prompts and the scout lane to this module.
// Node built-ins only and nothing imported from agent-manager except the rule tables under ./poll-rules (listed, not named, so a later piece ADDS a file
// and edits no existing one). The filesystem is an argument, so the module can move into Grimmethy/triggers unchanged, like src/queue-events.js.
//
// What counts as a poll (every rule table follows this): an UNBOUNDED loop that sleeps, a timer that re-arms itself or fires on a schedule. A loop bounded by an
// attempt counter, a sleep outside any loop (a one-shot wait) and test files do NOT count.
//
//   languageOf(path) / shebangLanguage(firstLine) / isTestPath(path)
//   parseAnnotation(lines, index) -> { annotated, reason }     `poll-ok: <reason>` in a comment on line `index` or the line above; an empty reason does not count
//   scanText({ language, path, text, includeTests, tables })   -> Finding[]
//   scanDiff(unifiedDiff, { includeTests, tables })            -> Finding[] for ADDED lines only (new-file line numbers)
//   signatureOf(finding)                                       -> sha1 hex of path|kind|snippet (comments stripped, whitespace collapsed): survives a line move
//   loadRules(fs, { dir, load })                               -> { tables, loadErrors }
// Finding = { path, line, language, kind, severity ('poll' | 'info'), snippet, annotated, reason, signature }

const crypto = require('crypto');
const path = require('path');
const realFs = require('fs');

const RULES_DIR = path.join(__dirname, 'poll-rules');
const CONTEXT_LINES = 40;

const EXT_LANGUAGE = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.html': 'js',
  '.py': 'py', '.sh': 'sh', '.bash': 'sh', '.ps1': 'ps1', '.bat': 'bat', '.cmd': 'bat',
  '.service': 'systemd', '.timer': 'systemd', '.yml': 'yaml', '.yaml': 'yaml', '.sql': 'sql', '.toml': 'config',
};
const CONFIG_NAMES = new Set(['plugins.json', 'task-domains.json', 'package.json']);
const TEST_PATH_RE = /(^|\/)test_[^/]*\.py$|_test\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$|(^|\/)(?:tests?|__tests__)\//;

function languageOf(file) {
  const base = path.posix.basename(String(file || '').replace(/\\/g, '/'));
  if (CONFIG_NAMES.has(base)) return 'config';
  return EXT_LANGUAGE[path.posix.extname(base).toLowerCase()] || null;
}

function shebangLanguage(firstLine) {
  const m = String(firstLine || '').match(/^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?(\S+)/);
  if (!m) return null;
  const prog = path.posix.basename(m[1]).replace(/[0-9.]+$/, '');
  if (['sh', 'bash', 'dash', 'zsh', 'ksh'].includes(prog)) return 'sh';
  if (prog === 'python') return 'py';
  if (['node', 'nodejs'].includes(prog)) return 'js';
  if (['pwsh', 'powershell'].includes(prog)) return 'ps1';
  return null;
}

function isTestPath(file) { return TEST_PATH_RE.test(String(file || '').replace(/\\/g, '/')); }

// A comment holding `poll-ok:` + a non-empty reason. The marker must come after a comment opener on the same line.
const ANNOTATION_RE = /(?:\/\/|\/\*|<!--|#|\bREM\b|::|--)[^]*?\bpoll-ok:[ \t]*([^\n]*)/;
function annotationOn(line) {
  const m = ANNOTATION_RE.exec(String(line || ''));
  if (!m) return null;
  const reason = m[1].replace(/\*\/\s*$|-->\s*$/, '').trim();
  return reason ? reason : null;
}

function parseAnnotation(lines, index) {
  for (const i of [index, index - 1]) {
    if (i < 0 || i >= lines.length) continue;
    const reason = annotationOn(lines[i]);
    if (reason) return { annotated: true, reason };
  }
  return { annotated: false, reason: null };
}

function stripComments(text, language) {
  let s = String(text).replace(/\/\*.*?\*\//g, ' ');
  s = language === 'js' || language === 'sql' || language === null ? s.replace(/(^|\s)(?:\/\/|--).*$/, '') : s.replace(/(^|\s)#.*$/, '');
  return s;
}

function signatureOf(finding) {
  const snippet = stripComments(finding.snippet, finding.language).replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(`${finding.path}|${finding.kind}|${snippet}`).digest('hex');
}

function validTable(mod) {
  return mod && Array.isArray(mod.languages) && Array.isArray(mod.rules) && mod.rules.every((r) => r && typeof r.kind === 'string' && typeof r.test === 'function');
}

function loadRules(fs = realFs, opts = {}) {
  const dir = opts.dir || RULES_DIR;
  const load = opts.load || require;
  const tables = [];
  const loadErrors = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.rules\.js$/.test(n)).sort(); } catch (e) { loadErrors.push({ file: dir, error: e.message }); }
  for (const name of names) {
    try {
      const mod = load(path.join(dir, name));
      if (!validTable(mod)) throw new TypeError('not a rule table: needs languages[] and rules[{kind,test}]');
      tables.push(mod);
    } catch (e) {
      loadErrors.push({ file: name, error: e.message });
    }
  }
  return { tables, loadErrors };
}

let defaultTables = null;
function tablesFor(opts) {
  if (opts && opts.tables) return opts.tables;
  if (!defaultTables) defaultTables = loadRules(realFs).tables;
  return defaultTables;
}

// Inside which lines of an .html file the JavaScript is: only <script>...</script> text, the tags' own lines blanked of markup.
function htmlScriptLines(lines, startInScript) {
  let inScript = startInScript;
  return lines.map((line) => {
    let out = '';
    let rest = line;
    for (;;) {
      if (inScript) {
        const end = rest.search(/<\/script\s*>/i);
        if (end < 0) { out += rest; break; }
        out += rest.slice(0, end);
        rest = rest.slice(end).replace(/^<\/script\s*>/i, '');
        inScript = false;
      } else {
        const open = rest.match(/<script\b[^>]*>/i);
        if (!open) break;
        rest = rest.slice(open.index + open[0].length);
        inScript = true;
      }
    }
    return out;
  });
}

function scanLines(lines, language, file, tables) {
  const findings = [];
  for (const table of tables) {
    if (!table.languages.includes(language)) continue;
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]) continue;
      for (const rule of table.rules) {
        const snippet = rule.test({ lines, index, language, path: file });
        if (!snippet) continue;
        const note = parseAnnotation(lines, index);
        const finding = { path: file, line: index + 1, language, kind: rule.kind, severity: rule.severity || 'poll', snippet: String(snippet).trim().slice(0, 200), annotated: note.annotated, reason: note.reason };
        finding.signature = signatureOf(finding);
        findings.push(finding);
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

function scanText({ language, path: file, text, includeTests = false, tables } = {}) {
  if (!language || (!includeTests && isTestPath(file))) return [];
  let lines = String(text == null ? '' : text).split('\n');
  const allTables = tablesFor({ tables });
  if (/\.html?$/i.test(String(file))) {
    const scripts = htmlScriptLines(lines, false);
    // rules look at the script text; annotations may sit in an HTML comment on the raw line, so they are read from the raw lines
    const findings = scanLines(scripts, language, file, allTables);
    for (const f of findings) {
      const note = parseAnnotation(lines, f.line - 1);
      f.annotated = note.annotated;
      f.reason = note.reason;
    }
    return findings;
  }
  return scanLines(lines, language, file, allTables);
}

// Unified diff -> files with { added: Set of new-file line numbers, known: Map line -> text } (added and context lines; new-file line numbers).
function parseDiff(diff) {
  const files = [];
  for (const chunk of String(diff || '').split(/^(?=diff --git )/m)) {
    const head = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!head || /^(?:Binary files|GIT binary patch)/m.test(chunk)) continue;
    const first = chunk.search(/^@@ /m);
    const entry = { file: head[2], added: new Set(), known: new Map() };
    if (first >= 0) {
      for (const hunk of chunk.slice(first).split(/^(?=@@ )/m)) {
        const hh = hunk.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (!hh) continue;
        let n = Number(hh[1]);
        for (const line of hunk.split('\n').slice(1)) {
          if (line.startsWith('\\') || line.startsWith('-')) continue;
          if (line.startsWith('+')) { entry.added.add(n); entry.known.set(n, line.slice(1)); n += 1; }
          else if (line.startsWith(' ')) { entry.known.set(n, line.slice(1)); n += 1; }
        }
      }
    }
    files.push(entry);
  }
  return files;
}

function scanDiff(unifiedDiff, opts = {}) {
  const tables = tablesFor(opts);
  const out = [];
  for (const entry of parseDiff(unifiedDiff)) {
    let language = languageOf(entry.file);
    if (!language) { const first = entry.known.get(1); language = entry.added.has(1) ? shebangLanguage(first) : null; }
    if (!language || (!opts.includeTests && isTestPath(entry.file))) continue;
    const added = [...entry.added].sort((a, b) => a - b);
    const lines = [];
    let last = 0;
    for (const [n] of entry.known) last = Math.max(last, n);
    for (let n = 1; n <= last; n += 1) {
      const text = entry.known.get(n);
      if (text === undefined) { lines.push(''); continue; }
      const near = entry.added.has(n) || added.some((a) => Math.abs(a - n) <= CONTEXT_LINES);
      lines.push(near ? text : '');
    }
    let scanLinesIn = lines;
    if (/\.html?$/i.test(entry.file)) {
      const tag = lines.join('\n').match(/<(\/?)script\b/i);
      scanLinesIn = htmlScriptLines(lines, !tag || tag[1] === '/');
    }
    for (const f of scanLines(scanLinesIn, language, entry.file, tables)) {
      if (!entry.added.has(f.line)) continue;
      const note = parseAnnotation(lines, f.line - 1);
      f.annotated = note.annotated;
      f.reason = note.reason;
      out.push(f);
    }
  }
  return out;
}

module.exports = { languageOf, shebangLanguage, isTestPath, parseAnnotation, scanText, scanDiff, signatureOf, loadRules, RULES_DIR };
