'use strict';

// yaml.rules.js -- poll rules for YAML (language 'yaml': .yml and .yaml). ADR-0024 "triggers, not polls". Table shape: see ../poll-detector.js.
// 'cron-schedule' (poll): under a GitHub Actions `on:` key, a `schedule:` block holding `- cron: '...'`. The finding is the cron line.
// 'healthcheck-interval' (severity 'info', listed but never fails a gate): under a compose `healthcheck:` key, an `interval:` line.
// Indentation decides the block: the nearest earlier line with LESS indentation is the parent. Comment lines are skipped.

const indentOf = (line) => line.match(/^[ \t]*/)[0].length;
const isBlank = (line) => !line.trim() || /^\s*#/.test(line);

// The chain of parent keys of line `index` (nearest first), e.g. ['schedule', 'on'].
function parentKeys(lines, index) {
  const keys = [];
  let threshold = indentOf(lines[index]);
  for (let i = index - 1; i >= 0; i -= 1) {
    if (isBlank(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind >= threshold) continue;
    threshold = ind;
    const key = lines[i].match(/^\s*["']?([\w.-]+)["']?\s*:/);
    if (key) keys.push(key[1]);
  }
  return keys;
}

const CRON_RE = /^\s*-\s*cron\s*:\s*\S/;
const INTERVAL_RE = /^\s*interval\s*:\s*\S/;
const snippetOf = (ctx) => ctx.lines[ctx.index].trim();

const rules = [
  {
    kind: 'cron-schedule',
    severity: 'poll',
    test(ctx) {
      const line = ctx.lines[ctx.index];
      if (!CRON_RE.test(line)) return false;
      const parents = parentKeys(ctx.lines, ctx.index);
      return parents.includes('schedule') && parents.includes('on') && snippetOf(ctx);
    },
  },
  {
    kind: 'healthcheck-interval',
    severity: 'info',
    test(ctx) {
      const line = ctx.lines[ctx.index];
      return INTERVAL_RE.test(line) && parentKeys(ctx.lines, ctx.index)[0] === 'healthcheck' && snippetOf(ctx);
    },
  },
];

module.exports = { languages: ['yaml'], rules };
