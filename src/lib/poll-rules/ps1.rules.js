'use strict';

// ps1.rules.js -- poll rules for PowerShell (ADR-0024 "triggers, not polls"). Table shape and what counts as a poll: see the header of ../poll-detector.js.
// A `Start-Sleep` whose NEAREST enclosing loop is unbounded is a poll. Unbounded: `while ($true)`, `while (1)`, `for (;;)`, `do { } while ($true)`, `do { } until (<condition without a counter>)`.
// Bounded (NOT a poll): `for ($i = 0; $i -lt N; $i++)`, `foreach`, `ForEach-Object`, `while ($i -lt N)`, `do { } while ($attempt -lt N)`; a Start-Sleep outside any loop is a one-shot wait.
// Also a poll: a scheduled job (`Register-ScheduledTask`, `schtasks /create`, `New-ScheduledTaskTrigger` with -RepetitionInterval, -Daily or -Weekly).

// Code with comments, string contents and here-string bodies blanked to spaces (same length), cached per file.
const codeCache = new WeakMap();
function codeLines(lines) {
  if (codeCache.has(lines)) return codeCache.get(lines);
  let inBlock = false;
  let here = null;
  const out = lines.map((line) => {
    if (here) {
      if (line.startsWith(here)) here = null;
      return ' '.repeat(line.length);
    }
    let s = '';
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (inBlock) {
        if (c === '#' && line[i + 1] === '>') { inBlock = false; s += '  '; i += 1; } else s += ' ';
      } else if (c === '<' && line[i + 1] === '#') { inBlock = true; s += '  '; i += 1; }
      else if (c === '#') { s += ' '.repeat(line.length - i); break; }
      else if (c === '@' && (line[i + 1] === '"' || line[i + 1] === "'") && line.slice(i + 2).trim() === '') { here = line[i + 1] + '@'; s += ' '.repeat(line.length - i); break; }
      else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length) {
          if (c === '"' && line[j] === '`') { j += 2; continue; }
          if (line[j] === c) break;
          j += 1;
        }
        s += c + ' '.repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? c : '');
        i = j;
      } else s += c;
    }
    return s;
  });
  codeCache.set(lines, out);
  return out;
}

const COUNTER_RE = /-(?:lt|le|gt|ge)\b/i;
const UNBOUNDED_WHILE_RE = /^\(\s*(?:\$true|1)\s*\)$/i;
const FOR_FOREVER_RE = /^\(\s*;\s*;\s*\)$/;
const SLEEP_RE = /\bStart-Sleep\b/ig;

// Classify the text before a `{`: a loop kind, or null for any other block (if, else, switch, try, script block ...).
function blockKind(header) {
  const h = header.trim();
  if (/^do$/i.test(h)) return { loop: 'do' };
  const w = h.match(/(?:^|[\s;(])while\s*(\(.*\))$/i);
  if (w) return { loop: 'while', unbounded: UNBOUNDED_WHILE_RE.test(w[1]) };
  const f = h.match(/(?:^|[\s;(])for\s*(\(.*\))$/i);
  if (f) return { loop: 'for', unbounded: FOR_FOREVER_RE.test(f[1]) };
  if (/(?:^|[\s;(])foreach\s*\(.*\)$/i.test(h) || /\bForEach-Object\b|(?:^|\|)\s*%$/i.test(h)) return { loop: 'foreach', unbounded: false };
  return null;
}

// After a do-block's closing brace: `while (cond)` or `until (cond)` (on the same line or the next code line).
function doCondition(code, index, afterCol) {
  let rest = code[index].slice(afterCol).trim();
  for (let i = index + 1; !rest && i < code.length; i += 1) rest = code[i].trim();
  const m = rest.match(/^(while|until)\s*(\(.*\))/i);
  if (!m) return false;
  return m[1].toLowerCase() === 'while' ? UNBOUNDED_WHILE_RE.test(m[2]) : !COUNTER_RE.test(m[2]);
}

// One pass: the lines holding a Start-Sleep whose nearest enclosing loop is unbounded.
function sleepHits(lines) {
  const code = codeLines(lines);
  const hits = new Set();
  const stack = [];
  let previous = '';
  code.forEach((line, index) => {
    const events = [];
    for (let p = 0; p < line.length; p += 1) if (line[p] === '{' || line[p] === '}') events.push({ p, brace: line[p] });
    SLEEP_RE.lastIndex = 0;
    let m;
    while ((m = SLEEP_RE.exec(line))) events.push({ p: m.index, sleep: true });
    events.sort((a, b) => a.p - b.p);
    for (const e of events) {
      if (e.brace === '{') {
        const header = line.slice(0, e.p).trim() || previous.trim();
        stack.push({ kind: blockKind(header), sleeps: [] });
      } else if (e.brace === '}') {
        const closed = stack.pop();
        if (closed && closed.kind && closed.kind.loop === 'do' && closed.sleeps.length && doCondition(code, index, e.p + 1)) closed.sleeps.forEach((l) => hits.add(l));
      } else {
        for (let k = stack.length - 1; k >= 0; k -= 1) {
          const kind = stack[k].kind;
          if (!kind) continue;
          if (kind.loop === 'do') stack[k].sleeps.push(index);
          else if (kind.unbounded) hits.add(index);
          break;
        }
      }
    }
    if (line.trim()) previous = line;
  });
  return hits;
}
const hitsCache = new WeakMap();
const hitsOf = (lines) => { if (!hitsCache.has(lines)) hitsCache.set(lines, sleepHits(lines)); return hitsCache.get(lines); };

const SCHEDULED_RES = [
  /\bRegister-ScheduledTask\b/i,
  /\bschtasks(?:\.exe)?\s+\/create\b/i,
  /\bNew-ScheduledTaskTrigger\b[^\n]*-(?:RepetitionInterval|Daily|Weekly)\b/i,
];

const snippetOf = (ctx) => ctx.lines[ctx.index].trim();

const rules = [
  {
    kind: 'sleep-loop',
    severity: 'poll',
    test(ctx) { return hitsOf(ctx.lines).has(ctx.index) && snippetOf(ctx); },
  },
  {
    kind: 'scheduled-task',
    severity: 'poll',
    test(ctx) { const code = codeLines(ctx.lines)[ctx.index]; return SCHEDULED_RES.some((re) => re.test(code)) && snippetOf(ctx); },
  },
];

module.exports = { languages: ['ps1'], rules };
