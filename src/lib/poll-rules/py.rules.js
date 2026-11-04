'use strict';

// py.rules.js -- poll rules for Python (ADR-0024 "triggers, not polls"). Table shape and what counts as a poll: see the header of ../poll-detector.js.
// A sleep inside an UNBOUNDED loop (`while True:`, `while 1:`, `while not <name>.is_set():`) is a poll. A sleep in a loop bounded by a range, an attempt counter or a
// deadline is a retry wait and is NOT; neither is a sleep outside any loop. The loop is found by indentation: the nearest earlier line with LESS indentation that is a loop header,
// not looking past the enclosing `def` or `class`.

// The code of each line with comments and string contents blanked to spaces (same length). Triple-quoted strings span lines. Cached per file.
const codeCache = new WeakMap();
function codeLines(lines) {
  if (codeCache.has(lines)) return codeCache.get(lines);
  let triple = null;
  const out = lines.map((line) => {
    let s = '';
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (triple) {
        if (line.startsWith(triple, i)) { s += '   '; i += 2; triple = null; } else s += ' ';
      } else if (c === '#') { s += ' '.repeat(line.length - i); break; }
      else if ((c === '"' || c === "'") && line.startsWith(c.repeat(3), i)) { triple = c.repeat(3); s += '   '; i += 2; }
      else if (c === '"' || c === "'") {
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

const indentOf = (line) => line.match(/^[ \t]*/)[0].replace(/\t/g, '        ').length;
const UNBOUNDED_HEADER_RE = /^\s*while\s+(?:True|1|not\s+[\w.]+\.is_set\(\))\s*:/;
const LOOP_HEADER_RE = /^\s*(?:async\s+)?(?:for|while)\b/;
const SCOPE_RE = /^\s*(?:async\s+)?(?:def|class)\b/;

// true when the nearest enclosing loop of the line at `index` is unbounded; false for a bounded loop or no loop.
function inUnboundedLoop(lines, index) {
  const code = codeLines(lines);
  if (UNBOUNDED_HEADER_RE.test(code[index])) return true;   // `while True: time.sleep(1)` on one line
  let threshold = indentOf(code[index]);
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!code[i].trim()) continue;
    const ind = indentOf(code[i]);
    if (ind >= threshold) continue;
    threshold = ind;
    if (LOOP_HEADER_RE.test(code[i])) return UNBOUNDED_HEADER_RE.test(code[i]);
    if (SCOPE_RE.test(code[i])) return false;
  }
  return false;
}

function enclosingFunction(lines, index) {
  const code = codeLines(lines);
  let threshold = indentOf(code[index]);
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!code[i].trim()) continue;
    const ind = indentOf(code[i]);
    if (ind >= threshold) continue;
    threshold = ind;
    const m = code[i].match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/);
    if (m) return m[1];
    if (/^\s*class\b/.test(code[i])) return null;
  }
  return null;
}

const SLEEP_RE = /\b(?:time|asyncio)\.sleep\s*\(/;
const SCHEDULE_RE = /\bschedule\.every\s*\(/;
const TIMER_RE = /\b(?:threading\.)?Timer\s*\(\s*[^,()]+,\s*([\w.]+)\s*[,)]/;
const TIMER_IMPORT_RE = /^\s*from\s+threading\s+import\b[^\n]*\bTimer\b/m;
const WAIT_RE = /\.wait\s*\(\s*(?:timeout\s*=\s*)?[^)\s][^)]*\)/;

const snippetOf = (ctx) => ctx.lines[ctx.index].trim();

const rules = [
  {
    kind: 'sleep-loop',
    severity: 'poll',
    test(ctx) { return SLEEP_RE.test(codeLines(ctx.lines)[ctx.index]) && inUnboundedLoop(ctx.lines, ctx.index) && snippetOf(ctx); },
  },
  {
    kind: 'schedule-every',
    severity: 'poll',
    test(ctx) { return SCHEDULE_RE.test(codeLines(ctx.lines)[ctx.index]) && snippetOf(ctx); },
  },
  {
    kind: 'timer-rearm',
    severity: 'poll',
    test(ctx) {
      const code = codeLines(ctx.lines)[ctx.index];
      const m = TIMER_RE.exec(code);
      if (!m) return false;
      if (!/\bthreading\.Timer\b/.test(code) && !TIMER_IMPORT_RE.test(ctx.lines.join('\n'))) return false;
      const callback = m[1].split('.').pop();
      return callback === enclosingFunction(ctx.lines, ctx.index) && snippetOf(ctx);
    },
  },
  {
    kind: 'wait-loop',
    severity: 'poll',
    test(ctx) { return WAIT_RE.test(codeLines(ctx.lines)[ctx.index]) && inUnboundedLoop(ctx.lines, ctx.index) && snippetOf(ctx); },
  },
];

module.exports = { languages: ['py'], rules };
