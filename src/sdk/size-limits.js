'use strict';

// Size limit detection SDK for the agent-manager size ratchet system.
//
// Provides pure helpers to detect files and functions that exceed configurable line
// limits, plus a minimal JS tokenizer and Python function-span detector. Downstream
// callers (the size-ratchet-regen script and hard-fail gate) are responsible for loading
// the allowlist and filtering results; this module reports every violation unconditionally.
//
// Expected allowlist shape (documented for consumers):
//   { files: Record<string, number>, functions: Record<string, number> }
// where keys are `path->lines` and `path::name->lines` respectively.
//
// Env vars (not exported; resolved internally by _resolveLimit):
//   AGENT_MANAGER_MAX_FILE_LINES        (default 500)
//   AGENT_MANAGER_MAX_FUNCTION_LINES    (default 100)

const fs = require('fs');
const path = require('path');

// Directories to skip when scanning for long files (never treated as source).
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.turbo',
]);

// Track whether we've warned about a bad env value (avoid stderr spam).
const _warnedBadValues = new Set();

/**
 * Resolve a size limit from env var or default. Internal helper; not exported.
 *
 * @param {'file'|'function'} kind
 * @returns {number}
 */
function _resolveLimit(kind) {
  const envName = kind === 'file'
    ? 'AGENT_MANAGER_MAX_FILE_LINES'
    : 'AGENT_MANAGER_MAX_FUNCTION_LINES';
  const def = kind === 'file' ? 500 : 100;
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    const key = `${envName}=${raw}`;
    if (!_warnedBadValues.has(key)) {
      _warnedBadValues.add(key);
      process.stderr.write(
        `[size-limits] ignoring non-positive/non-integer ${envName}=${JSON.stringify(raw)}; using default ${def}\n`,
      );
    }
    return def;
  }
  return n;
}

/**
 * Count lines in text. null/undefined → 0. Trailing newline does not add a line.
 *
 * @param {string|null|undefined} text
 * @returns {number}
 */
function countLines(text) {
  if (text == null || text === '') return 0;
  // Strip trailing newline to avoid counting it as an extra line
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n').length;
}

// ----- JS tokenizer -----

const JS_KEYWORDS = new Set([
  'function', 'const', 'let', 'var', 'class', 'return', 'if', 'else',
  'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try',
  'catch', 'finally', 'throw', 'new', 'delete', 'typeof', 'instanceof',
  'import', 'export', 'default', 'from', 'as', 'async', 'await', 'get',
  'set', 'static', 'yield', 'of', 'in', 'void', 'this',
]);

const JS_OPERATORS = new Set([
  '=', '+=', '-=', '*=', '/=', '==', '===', '!=', '!==',
  '<', '>', '<=', '>=', '&&', '||', '??', '?.', '!',
  '+', '-', '*', '/', '%', '**', '&', '|', '^', '~', '<<', '>>', '>>>',
  '=>',
]);

/**
 * Tokenize JS source into a flat array of {type, value, line}.
 *
 * Types: keyword, identifier, string, number, operator, symbol.
 * Skips whitespace and comments (// to EOL, block comments).
 * Line numbers are 1-based.
 *
 * @param {string} text
 * @returns {{type: string, value: string, line: number}[]}
 */
function tokenizeJs(text) {
  const tokens = [];
  let i = 0;
  let line = 1;

  function emit(type, value) {
    tokens.push({ type, value, line });
  }

  while (i < text.length) {
    const ch = text[i];

    // Newline
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }

    // Line comment
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length) {
        if (text[i] === '\n') line++;
        if (text[i] === '*' && text[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    // String (single or double quoted)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') {
          str += text[i];
          i++;
          if (i < text.length) {
            str += text[i];
            i++;
          }
          continue;
        }
        if (text[i] === '\n') line++;
        str += text[i];
        i++;
      }
      if (i < text.length) {
        str += text[i]; // closing quote
        i++;
      }
      emit('string', str);
      continue;
    }

    // Number (integer or float, no leading sign)
    if (ch >= '0' && ch <= '9') {
      let num = ch;
      i++;
      while (i < text.length && text[i] >= '0' && text[i] <= '9') {
        num += text[i];
        i++;
      }
      if (i < text.length && text[i] === '.' && text[i + 1] && text[i + 1] >= '0' && text[i + 1] <= '9') {
        num += '.';
        i++;
        while (i < text.length && text[i] >= '0' && text[i] <= '9') {
          num += text[i];
          i++;
        }
      }
      emit('number', num);
      continue;
    }

    // Identifier or keyword
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') {
      let word = ch;
      i++;
      while (i < text.length && ((text[i] >= 'a' && text[i] <= 'z') || (text[i] >= 'A' && text[i] <= 'Z') || (text[i] >= '0' && text[i] <= '9') || text[i] === '_' || text[i] === '$')) {
        word += text[i];
        i++;
      }
      if (JS_KEYWORDS.has(word)) {
        emit('keyword', word);
      } else {
        emit('identifier', word);
      }
      continue;
    }

    // Multi-char operators (check longest first)
    const two = text.substring(i, i + 2);
    const three = text.substring(i, i + 3);
    if (JS_OPERATORS.has(three)) {
      emit('operator', three);
      i += 3;
      continue;
    }
    if (JS_OPERATORS.has(two)) {
      emit('operator', two);
      i += 2;
      continue;
    }

    // Single-char operators and symbols
    if (JS_OPERATORS.has(ch)) {
      emit('operator', ch);
      i++;
      continue;
    }

    // Symbols: { } ( ) [ ] , ; : .
    if ('{}()[],;:'.includes(ch)) {
      emit('symbol', ch);
      i++;
      continue;
    }

    // Skip anything else (backtick, @, #, etc.)
    i++;
  }

  return tokens;
}

/**
 * Find function spans from a token stream. Returns spans sorted by startLine.
 *
 * Detects:
 *   - function name(...)
 *   - const/let/var name = function
 *   - arrow functions (identifier => or (params) =>)
 *
 * @param {{type: string, value: string, line: number}[]} tokens
 * @returns {{startLine: number, endLine: number, name?: string, type: string}[]}
 */
function findJsFunctionSpans(tokens) {
  const spans = [];
  const n = tokens.length;

  // Braces are tracked by index into tokens (not character position).
  function balanceBraces(startIdx) {
    let depth = 0;
    let endLine = tokens[startIdx].line;
    for (let j = startIdx; j < n; j++) {
      if (tokens[j].type === 'symbol' && tokens[j].value === '{') depth++;
      else if (tokens[j].type === 'symbol' && tokens[j].value === '}') {
        depth--;
        if (depth === 0) {
          endLine = tokens[j].line;
          return endLine;
        }
      }
    }
    return tokens[n - 1].line;
  }

  for (let i = 0; i < n; i++) {
    const tok = tokens[i];

    // Pattern 1: function name(...)
    if (tok.type === 'keyword' && tok.value === 'function') {
      // Next non-whitespace should be identifier (name) then '('
      let j = i + 1;
      while (j < n && tokens[j].type === 'symbol' && tokens[j].value === '(') j++;
      // Actually, function keyword is followed by optional name
      // Look for: identifier then symbol '('
      let nameTok = null;
      let parenIdx = -1;
      for (let k = i + 1; k < n; k++) {
        if (tokens[k].type === 'identifier') {
          nameTok = tokens[k];
        } else if (tokens[k].type === 'symbol' && tokens[k].value === '(') {
          parenIdx = k;
          break;
        } else if (tokens[k].type === 'symbol' && tokens[k].value === '{') {
          // Anonymous function: function() { ... }
          nameTok = null;
          parenIdx = k - 1; // no paren
          break;
        }
      }
      if (parenIdx >= 0) {
        const startLine = tok.line;
        const endLine = balanceBraces(parenIdx + 1);
        spans.push({ startLine, endLine, name: nameTok ? nameTok.value : undefined, type: 'function' });
        i = parenIdx; // skip ahead
        continue;
      }
    }

    // Pattern 2: const/let/var name = function
    if ((tok.type === 'keyword' && (tok.value === 'const' || tok.value === 'let' || tok.value === 'var')) && i + 4 < n) {
      const nameTok = tokens[i + 1];
      const eqTok = tokens[i + 2];
      const funcTok = tokens[i + 3];
      if (nameTok && nameTok.type === 'identifier' &&
          eqTok && eqTok.type === 'operator' && eqTok.value === '=' &&
          funcTok && funcTok.type === 'keyword' && funcTok.value === 'function') {
        // Find opening paren after 'function'
        let parenIdx = -1;
        for (let k = i + 4; k < n; k++) {
          if (tokens[k].type === 'symbol' && tokens[k].value === '(') {
            parenIdx = k;
            break;
          }
        }
        if (parenIdx >= 0) {
          const startLine = tok.line;
          const endLine = balanceBraces(parenIdx + 1);
          spans.push({ startLine, endLine, name: nameTok.value, type: 'function' });
          i = parenIdx;
          continue;
        }
      }
    }

    // Pattern 3: arrow functions - identifier = (...) => or identifier =>
    if (tok.type === 'identifier' && i + 2 < n) {
      const eqTok = tokens[i + 1];
      if (eqTok && eqTok.type === 'operator' && eqTok.value === '=') {
        // Look for => after =
        for (let k = i + 2; k < n; k++) {
          if (tokens[k].type === 'operator' && tokens[k].value === '=>') {
            const startLine = tok.line;
            // Arrow body: if single expression, span is just this line
            // If block body { ... }, balance braces
            let endLine = startLine;
            if (k + 1 < n && tokens[k + 1].type === 'symbol' && tokens[k + 1].value === '{') {
              endLine = balanceBraces(k + 1);
            }
            spans.push({ startLine, endLine, name: undefined, type: 'arrow' });
            i = k;
            break;
          }
          if (tokens[k].type === 'symbol' && tokens[k].value === '{') {
            // Not an arrow, stop looking
            break;
          }
        }
      }
    }

    // Pattern 4: class methods - identifier(...) { ... } (not preceded by 'function' or '=')
    if (tok.type === 'identifier' && i + 3 < n) {
      const parenTok = tokens[i + 1];
      const closeParenTok = tokens[i + 2];
      const braceTok = tokens[i + 3];
      if (parenTok && parenTok.type === 'symbol' && parenTok.value === '(' &&
          closeParenTok && closeParenTok.type === 'symbol' && closeParenTok.value === ')' &&
          braceTok && braceTok.type === 'symbol' && braceTok.value === '{') {
        // Make sure this isn't part of a function declaration or arrow function
        // (already handled by patterns 1-3)
        const startLine = tok.line;
        const endLine = balanceBraces(i + 3);
        spans.push({ startLine, endLine, name: tok.value, type: 'method' });
        i = i + 3; // skip ahead past the opening brace
        continue;
      }
    }
  }

  return spans.sort((a, b) => a.startLine - b.startLine);
}

// ----- Python function span detection -----

const PY_DEF_RE = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const PY_CLASS_RE = /^\s*class\s+/;

/**
 * Find Python function (def) spans from split lines.
 *
 * @param {string[]} lines
 * @returns {{startLine: number, endLine: number, name: string}[]}
 */
function findPyFunctionSpans(lines) {
  const spans = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PY_DEF_RE);
    if (!m) continue;

    const name = m[1];
    const startLine = i + 1; // 1-based
    const defIndent = lines[i].search(/\S/); // leading whitespace count

    // Find end: first line after start that has indent < defIndent (or is blank at same indent)
    let endLine = startLine;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') {
        endLine = j + 1;
        continue;
      }
      const indent = line.search(/\S/);
      if (indent < defIndent) {
        break;
      }
      endLine = j + 1;
    }

    // Back up to last non-blank line (don't include trailing blank lines)
    while (endLine > startLine && lines[endLine - 1].trim() === '') {
      endLine--;
    }

    spans.push({ startLine, endLine, name });
  }

  return spans;
}

// ----- File scanning -----

/**
 * Recursively find files exceeding maxLines in repoRoot.
 *
 * @param {string} repoRoot
 * @param {{maxLines?: number}} [opts]
 * @returns {{path: string, lines: number, maxLines: number}[]}
 */
function findLongFiles(repoRoot, opts = {}) {
  const maxLines = opts.maxLines !== undefined ? opts.maxLines : _resolveLimit('file');
  const violations = [];

  function scan(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        scan(full);
      } else if (entry.isFile()) {
        try {
          const text = fs.readFileSync(full, 'utf8');
          const lines = countLines(text);
          if (lines > maxLines) {
            violations.push({
              path: path.relative(repoRoot, full),
              lines,
              maxLines,
            });
          }
        } catch {
          // Skip unreadable (binary, permission denied)
        }
      }
    }
  }

  scan(repoRoot);
  return violations;
}

// ----- Public API -----

/**
 * Detect functions exceeding maxLines in text, language-detected from relPath.
 *
 * JS/TS: .js, .jsx, .ts, .tsx
 * Python: .py
 *
 * @param {string} text
 * @param {string} relPath
 * @param {{maxLines?: number}} [opts]
 * @returns {{path: string, name: string|undefined, startLine: number, endLine: number, lines: number, maxLines: number}[]}
 */
function findLongFunctions(text, relPath, opts = {}) {
  const maxLines = opts.maxLines !== undefined ? opts.maxLines : _resolveLimit('function');
  const ext = path.extname(relPath).toLowerCase();

  const isJs = ['.js', '.jsx', '.ts', '.tsx'].includes(ext);
  const isPy = ext === '.py';

  if (!isJs && !isPy) return [];

  let spans;
  if (isJs) {
    const tokens = tokenizeJs(text);
    spans = findJsFunctionSpans(tokens);
  } else {
    const lines = text.split('\n');
    spans = findPyFunctionSpans(lines);
  }

  const violations = [];
  for (const span of spans) {
    const fnLines = span.endLine - span.startLine + 1;
    if (fnLines > maxLines) {
      violations.push({
        path: relPath,
        name: span.name,
        startLine: span.startLine,
        endLine: span.endLine,
        lines: fnLines,
        maxLines,
      });
    }
  }

  return violations;
}

module.exports = {
  findLongFiles,
  findLongFunctions,
  countLines,
  tokenizeJs,
  findJsFunctionSpans,
  findPyFunctionSpans,
};
