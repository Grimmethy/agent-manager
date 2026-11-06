'use strict';

// sql.rules.js -- poll rules for SQL (language 'sql'). ADR-0024 "triggers, not polls". Table shape: see ../poll-detector.js.
// 'sleep-loop' (poll): `pg_sleep(` (also `PERFORM pg_sleep(`) inside a PL/pgSQL `LOOP ... END LOOP;` or `WHILE ... LOOP`. A `pg_sleep` outside any loop is a one-shot wait.
// 'cron-schedule' (poll): `cron.schedule(` (pg_cron), also as `SELECT cron.schedule(...)`.
// Comments (`--` lines and trailing `-- ...`, `/* */`) and string literals are blanked before matching. A `FOR ... LOOP` is bounded (it iterates a query or a range), so only a bare
// `LOOP` or `WHILE ... LOOP` counts as unbounded.

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
      } else if (c === '-' && line[i + 1] === '-') { s += ' '.repeat(line.length - i); break; }
      else if (c === '/' && line[i + 1] === '*') { inBlock = true; s += '  '; i += 1; }
      else if (c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== "'") j += 1;
        s += "'" + ' '.repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? "'" : '');
        i = j;
      } else s += c;
    }
    return s;
  });
  codeCache.set(lines, out);
  return out;
}

const SLEEP_RE = /\bpg_sleep(?:_for|_until)?\s*\(/i;
const SCHEDULE_RE = /\bcron\.schedule(?:_in_database)?\s*\(/i;

// Loop depth at each line start/at a position: count LOOP openers (bare LOOP, WHILE ... LOOP) and END LOOP closers, ignoring FOR ... LOOP (bounded).
function unboundedDepth(code, index, upto) {
  const stack = [];
  for (let i = 0; i <= index; i += 1) {
    const text = i === index ? code[i].slice(0, upto) : code[i];
    const re = /\bEND\s+LOOP\b|\b(FOR|WHILE|FOREACH)\b[^;]*?\bLOOP\b|\bLOOP\b/gi;
    let m;
    while ((m = re.exec(text))) {
      if (/^END/i.test(m[0])) stack.pop();
      else stack.push(!(m[1] && /^(FOR|FOREACH)$/i.test(m[1])));
    }
  }
  return stack;
}

const snippetOf = (ctx) => ctx.lines[ctx.index].trim();

const rules = [
  {
    kind: 'sleep-loop',
    severity: 'poll',
    test(ctx) {
      const code = codeLines(ctx.lines);
      const m = SLEEP_RE.exec(code[ctx.index]);
      if (!m) return false;
      const stack = unboundedDepth(code, ctx.index, m.index);
      return stack.length > 0 && stack[stack.length - 1] && snippetOf(ctx);
    },
  },
  {
    kind: 'cron-schedule',
    severity: 'poll',
    test(ctx) { return SCHEDULE_RE.test(codeLines(ctx.lines)[ctx.index]) && snippetOf(ctx); },
  },
];

module.exports = { languages: ['sql'], rules };
