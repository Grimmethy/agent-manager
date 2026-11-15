'use strict';

// sh.rules.js -- poll rules for shell scripts (language 'sh': .sh/.bash files and extensionless files whose shebang says bash/sh). ADR-0024 "triggers, not polls".
// Table shape and what counts as a poll: see the header of ../poll-detector.js.
// A `sleep` whose NEAREST enclosing loop is unbounded is a poll. Unbounded loops: `while true`, `while :`, `while [ 1 ]`, `while sleep N`, and `until <command>`.
// Bounded (NOT a poll): `for` and `select` loops (a list, `seq`, a brace range, `for ((i=0;i<N;i++))`), `while read`, `while kill -0 <pid>` (waits for a child), any loop whose
// condition holds a counter comparison (-lt -le -gt -ge, (( i < N ))). Also not polls: a sleep outside any loop or after the matching `done`, comments, strings, here-doc text.

// Code with comments, string contents and here-doc bodies blanked to spaces (same length), cached per file.
const codeCache = new WeakMap();
function codeLines(lines) {
  if (codeCache.has(lines)) return codeCache.get(lines);
  let heredoc = null;
  const out = lines.map((line) => {
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = null;
      return ' '.repeat(line.length);
    }
    let s = '';
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === '#' && (i === 0 || /[\s;&|(){}]/.test(line[i - 1]))) { s += ' '.repeat(line.length - i); break; }
      if (c === '\\') { s += '  '; i += 1; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += c === '"' && line[j] === '\\' ? 2 : 1;
        s += c + ' '.repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? c : '');
        i = j;
      } else s += c;
    }
    const doc = s.match(/<<-?\s*\\?['"]?([A-Za-z_][\w]*)['"]?/);
    if (doc && !/<<</.test(s)) heredoc = doc[1];
    return s;
  });
  codeCache.set(lines, out);
  return out;
}

const WORD_RE = /\b(while|until|for|select|do|done|sleep|watch)\b(?![\w./=:-])/g;
const PREFIX_KEYWORD_RE = /(?:^|[\s;&|(){}!])(?:then|do|else|elif|if|while|until|time|exec|sudo|nohup)\s*$/;
const COUNTER_RE = /\s-(?:lt|le|gt|ge)\s|\(\(.*[<>]/;
const UNBOUNDED_START_RE = /^(?:true\b|:(?=[\s;]|$)|\[\[?\s*1\s*\]\]?|\(\(\s*1\s*\)\)|sleep\b)/;

function atCommandPosition(code, at) {
  const before = code.slice(0, at).trimEnd();
  if (!before) return true;
  if (/[;&|({!]$/.test(before)) return true;
  return PREFIX_KEYWORD_RE.test(before);
}

// One pass over the file: which lines hold a `sleep` command whose nearest enclosing loop is unbounded, and which lines run `watch`.
function analyze(lines) {
  const code = codeLines(lines);
  const sleepHits = new Set();
  const watchHits = new Set();
  const stack = [];
  code.forEach((line, index) => {
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(line))) {
      if (!atCommandPosition(line, m.index)) continue;
      const word = m[1];
      if (word === 'while' || word === 'until' || word === 'for' || word === 'select') {
        const rest = line.slice(m.index + word.length).split(/\bdo\b/)[0].replace(/[;\s]+$/, '').trim();
        const starts = word === 'while' ? UNBOUNDED_START_RE.test(rest) : word === 'until';
        stack.push(starts && !COUNTER_RE.test(` ${rest} `));
      } else if (word === 'done') stack.pop();
      else if (word === 'sleep') { if (stack.length && stack[stack.length - 1]) sleepHits.add(index); }
      else if (word === 'watch') { if (/^\s+[^\s;&|)]/.test(line.slice(m.index + 5))) watchHits.add(index); }
    }
  });
  const cached = { sleepHits, watchHits };
  analysisCache.set(lines, cached);
  return cached;
}
const analysisCache = new WeakMap();
const analysisOf = (lines) => analysisCache.get(lines) || analyze(lines);

const snippetOf = (ctx) => ctx.lines[ctx.index].trim();

const rules = [
  {
    kind: 'sleep-loop',
    severity: 'poll',
    test(ctx) { return analysisOf(ctx.lines).sleepHits.has(ctx.index) && snippetOf(ctx); },
  },
  {
    kind: 'watch-command',
    severity: 'poll',
    test(ctx) { return analysisOf(ctx.lines).watchHits.has(ctx.index) && snippetOf(ctx); },
  },
];

module.exports = { languages: ['sh'], rules };
