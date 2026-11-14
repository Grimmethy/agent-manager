'use strict';

// bat.rules.js -- poll rules for Windows batch files, .bat and .cmd (ADR-0024 "triggers, not polls"). Table shape and what counts as a poll: see the header of ../poll-detector.js.
// 'delay-loop': a `timeout /t N` or `ping -n N 127.0.0.1` line that sits between a `:label` and a LATER `goto label` that jumps back to it, with no counter test between the label and
// the goto (a counter test = a `set /a` line AND an `if` that compares a variable). A one-shot delay that no backward goto loops is NOT a poll; neither is text inside a string.
// 'scheduled-task': `schtasks /create`. REM and :: comment lines, echo text and quoted text are blanked before matching.

// Code with comments, echo text and quoted text blanked to spaces (same length), cached per file.
const codeCache = new WeakMap();
function codeLines(lines) {
  if (codeCache.has(lines)) return codeCache.get(lines);
  const out = lines.map((line) => {
    if (/^\s*(?:@\s*)?(?:rem\b|::)/i.test(line) || /^\s*(?:@\s*)?echo\b/i.test(line)) return ' '.repeat(line.length);
    let s = '';
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '"') {
        let j = i + 1;
        while (j < line.length && line[j] !== '"') j += 1;
        s += '"' + ' '.repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? '"' : '');
        i = j;
      } else s += line[i];
    }
    return s;
  });
  codeCache.set(lines, out);
  return out;
}

const DELAY_RES = [
  /\btimeout(?:\.exe)?\s+\/t\b/i,
  /\bping(?:\.exe)?\s+-n\s+\S+\s+(?:127\.0\.0\.1|localhost)\b/i,
  /\bping(?:\.exe)?\s+(?:127\.0\.0\.1|localhost)\s+-n\b/i,
];
const SET_A_RE = /\bset\s+\/a\b/i;
const IF_COMPARE_RE = /\bif\b[^\n]*(?:%\w+%|!\w+!)[^\n]*(?:\b(?:lss|leq|gtr|geq|equ|neq)\b|==)/i;
const SCHEDULED_RE = /\bschtasks(?:\.exe)?\s+\/create\b/i;

// One pass: the lines that hold a delay command between a label and a later backward goto to it, with no counter test between them.
function delayHits(lines) {
  const code = codeLines(lines);
  const labels = [];                                   // { name, line }
  const gotos = [];                                    // { name, line }
  code.forEach((line, index) => {
    const label = line.match(/^\s*:([A-Za-z_][\w.-]*)/);
    if (label) labels.push({ name: label[1].toLowerCase(), line: index });
    const jump = line.match(/\bgoto\s+:?([A-Za-z_][\w.-]*)/i);
    if (jump && jump[1].toLowerCase() !== 'eof') gotos.push({ name: jump[1].toLowerCase(), line: index });
  });
  const hits = new Set();
  code.forEach((line, index) => {
    if (!DELAY_RES.some((re) => re.test(line))) return;
    for (const l of labels) {
      if (l.line >= index) continue;
      for (const g of gotos) {
        if (g.name !== l.name || g.line < index) continue;
        const span = code.slice(l.line, g.line + 1);
        if (span.some((x) => SET_A_RE.test(x)) && span.some((x) => IF_COMPARE_RE.test(x))) continue;     // a counter bounds the loop
        hits.add(index);
        return;
      }
    }
  });
  return hits;
}
const hitsCache = new WeakMap();
const hitsOf = (lines) => { if (!hitsCache.has(lines)) hitsCache.set(lines, delayHits(lines)); return hitsCache.get(lines); };

const snippetOf = (ctx) => ctx.lines[ctx.index].trim();

const rules = [
  {
    kind: 'delay-loop',
    severity: 'poll',
    test(ctx) { return hitsOf(ctx.lines).has(ctx.index) && snippetOf(ctx); },
  },
  {
    kind: 'scheduled-task',
    severity: 'poll',
    test(ctx) { return SCHEDULED_RE.test(codeLines(ctx.lines)[ctx.index]) && snippetOf(ctx); },
  },
];

module.exports = { languages: ['bat'], rules };
