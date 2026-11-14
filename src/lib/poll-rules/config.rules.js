'use strict';

// config.rules.js -- interval-like keys in CONFIG files (language 'config': plugins.json, task-domains.json, package.json, *.toml; poll-detector.js's languageOf returns null for data and
// queue JSON, so they never reach this table). ADR-0024 "triggers, not polls". Table shape: see ../poll-detector.js. Both rules are severity 'info': listed, never fail a gate.
// 'config-interval': a key whose name contains interval, poll, refresh, period or every (case-insensitive) with a POSITIVE numeric value, in JSON (`"intervalMs": 5000`),
// TOML (`poll_seconds = 30`) or YAML-style config (`refreshSeconds: 60`).
// 'watch-script': in package.json, a `scripts` entry whose command contains `--watch`, `nodemon` or `watch ` (a long-running file watcher).

const KEY_RE = /^\s*["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*,?\s*(?:[#;].*)?$/;
const NAME_RE = /(?:interval|poll|refresh|period|every)/i;
const SCRIPT_LINE_RE = /^\s*"[^"]+"\s*:\s*"([^"]*)"/;
const WATCH_RE = /--watch\b|\bnodemon\b|(?:^|[\s&;|])watch\s/;

// True when the line sits inside the top-level "scripts" object of a package.json.
function inScripts(lines, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (/^\s*"scripts"\s*:\s*\{/.test(lines[i])) {
      for (let j = i + 1; j < index; j += 1) if (/^\s*\}/.test(lines[j])) return false;
      return true;
    }
  }
  return false;
}

const snippetOf = (ctx) => ctx.lines[ctx.index].trim();

const rules = [
  {
    kind: 'config-interval',
    severity: 'info',
    test(ctx) {
      const m = KEY_RE.exec(ctx.lines[ctx.index]);
      return !!m && NAME_RE.test(m[1]) && Number(m[2]) > 0 && snippetOf(ctx);
    },
  },
  {
    kind: 'watch-script',
    severity: 'info',
    test(ctx) {
      if (!/package\.json$/i.test(String(ctx.path || ''))) return false;
      const m = SCRIPT_LINE_RE.exec(ctx.lines[ctx.index]);
      return !!m && WATCH_RE.test(m[1]) && inScripts(ctx.lines, ctx.index) && snippetOf(ctx);
    },
  },
];

module.exports = { languages: ['config'], rules };
