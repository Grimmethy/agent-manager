'use strict';

// js.rules.js -- poll rules for JavaScript, TypeScript, TSX, MJS and the <script> blocks of .html (poll-detector.js scans only the script text of an .html file).
// A rule table is { languages, rules: [{ kind, severity, test(ctx) }] }, ctx = { lines, index, language, path }; test returns false or a snippet.
// What is NOT a poll: a setTimeout used once (debounce, timeout), a `for (let i = 0; i < N; i++)` retry loop that sleeps, mentions in comments or string literals.

// The code of each line with comments and string contents blanked to spaces (same length, so match offsets still point into the real line). Cached per file.
const codeCache = new WeakMap();
function codeLines(lines) {
  if (codeCache.has(lines)) return codeCache.get(lines);
  let inBlock = false;
  const out = lines.map((line) => {
    let s = '';
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (inBlock) {
        if (c === '*' && line[i + 1] === '/') { inBlock = false; s += '  '; i += 1; } else s += ' ';
      } else if (c === '/' && line[i + 1] === '/') { s += ' '.repeat(line.length - i); break; }
      else if (c === '/' && line[i + 1] === '*') { inBlock = true; s += '  '; i += 1; }
      else if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
        s += c + ' '.repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? c : '');
        i = j;
      } else s += c;
    }
    return s;
  });
  codeCache.set(lines, out);
  return out;
}

// The text before each `{` that is still open at (index, upto): "while (true)", "function tick()", "setInterval(() =>" ... outermost first.
function enclosingHeaders(lines, index, upto) {
  const code = codeLines(lines);
  const stack = [];
  let previous = '';
  for (let i = 0; i <= index; i += 1) {
    const line = code[i];
    const end = i === index ? upto : line.length;
    for (let p = 0; p < end; p += 1) {
      if (line[p] === '{') stack.push((line.slice(0, p).trim() || previous).trim());
      else if (line[p] === '}') stack.pop();
    }
    if (line.trim()) previous = line;
  }
  return stack;
}

const UNBOUNDED_LOOP_RE = /\bwhile\s*\(\s*(?:true|1|!0)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/;
const FUNCTION_NAME_RES = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)$/,
];
function functionName(header) {
  for (const re of FUNCTION_NAME_RES) { const m = header.match(re); if (m && !/^(?:if|for|while|switch|catch|function)$/.test(m[1])) return m[1]; }
  return null;
}

function fileSchedules(lines, name) {
  const re = new RegExp(`\\bset(?:Interval|Timeout)\\s*\\(\\s*${name.replace(/\$/g, '\\$')}\\b`);
  return codeLines(lines).some((l) => re.test(l));
}

const SLEEP_RE = /\bawait\s+(?:[\w$.]*\.)?(?:sleep|delay|wait)\w*\s*\(|\bawait\s+new\s+Promise\s*\([^)]*setTimeout\s*\(/;
const REARM_RES = [
  /\bsetTimeout\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/,
  /\bsetTimeout\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{?\s*([A-Za-z_$][\w$]*)\s*\(/,
];
const LISTING_RE = /\breaddir(?:Sync)?\s*\(|\b(?:execFileSync|spawnSync|execSync|execFile|spawn)\s*\(\s*['"`]git['"`]\s*,\s*\[[^\]]*['"`]fetch['"`]|\bexecSync\s*\(\s*['"`]git fetch/;

const snippetOf = (ctx) => ctx.lines[ctx.index].trim();

const rules = [
  {
    kind: 'set-interval',
    severity: 'poll',
    test(ctx) { return /\bsetInterval\s*\(/.test(codeLines(ctx.lines)[ctx.index]) && snippetOf(ctx); },
  },
  {
    kind: 'self-rearming-timeout',
    severity: 'poll',
    test(ctx) {
      const code = codeLines(ctx.lines)[ctx.index];
      for (const re of REARM_RES) {
        const m = re.exec(code);
        if (!m) continue;
        if (enclosingHeaders(ctx.lines, ctx.index, m.index).some((h) => functionName(h) === m[1])) return snippetOf(ctx);
      }
      return false;
    },
  },
  {
    kind: 'sleep-loop',
    severity: 'poll',
    test(ctx) {
      const code = codeLines(ctx.lines);
      const m = SLEEP_RE.exec(code[ctx.index]);
      if (!m) return false;
      if (enclosingHeaders(ctx.lines, ctx.index, m.index).some((h) => UNBOUNDED_LOOP_RE.test(h))) return snippetOf(ctx);
      if (UNBOUNDED_LOOP_RE.test(code[ctx.index].slice(0, m.index))) return snippetOf(ctx);      // `while (true) await sleep(1);`
      let p = ctx.index - 1;
      while (p >= 0 && !code[p].trim()) p -= 1;
      return p >= 0 && UNBOUNDED_LOOP_RE.test(code[p]) && snippetOf(ctx);   // braceless body on the next line
    },
  },
  {
    kind: 'listing-in-tick',
    severity: 'poll',
    test(ctx) {
      const raw = ctx.lines[ctx.index];
      const code = codeLines(ctx.lines)[ctx.index];
      const m = LISTING_RE.exec(raw);
      if (!m || code.slice(m.index, m.index + 5) !== raw.slice(m.index, m.index + 5)) return false;   // the call itself must be code, not a comment or a string
      const headers = enclosingHeaders(ctx.lines, ctx.index, m.index);
      const scheduled = headers.some((h) => /\bsetInterval\s*\(/.test(h) || (functionName(h) && fileSchedules(ctx.lines, functionName(h))));
      return scheduled && snippetOf(ctx);
    },
  },
];

module.exports = { languages: ['js'], rules };
