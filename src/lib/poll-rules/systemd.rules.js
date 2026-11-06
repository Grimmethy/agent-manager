'use strict';

// systemd.rules.js -- poll rules for systemd units (language 'systemd': .service and .timer files). ADR-0024 "triggers, not polls". Table shape: see ../poll-detector.js.
// 'timer-unit': in a .timer file, `OnCalendar=`, `OnUnitActiveSec=` or `OnUnitInactiveSec=` is periodic work. `OnBootSec=` alone is a one-shot delay and is NOT a finding.
// 'restart-loop': in a .service file with `Type=oneshot`, a `Restart=always` or `Restart=on-success` line is a oneshot restarted forever. A normal service with Restart=always or
// RestartSec= is crash supervision and is NOT a finding. The rule reads the whole file through ctx.lines; every pattern is anchored at the line start, so `#` and `;` comment lines never match.

const TIMER_KEY_RE = /^\s*(?:OnCalendar|OnUnitActiveSec|OnUnitInactiveSec)\s*=\s*\S/;
const RESTART_RE = /^\s*Restart\s*=\s*(?:always|on-success)\b/;
const ONESHOT_RE = /^\s*Type\s*=\s*oneshot\b/;

const isTimerFile = (ctx) => /\.timer$/i.test(String(ctx.path || ''));
const isServiceFile = (ctx) => /\.service$/i.test(String(ctx.path || ''));
const snippetOf = (ctx) => ctx.lines[ctx.index].trim();

const rules = [
  {
    kind: 'timer-unit',
    severity: 'poll',
    test(ctx) {
      const line = ctx.lines[ctx.index];
      return isTimerFile(ctx) && TIMER_KEY_RE.test(line) && snippetOf(ctx);
    },
  },
  {
    kind: 'restart-loop',
    severity: 'poll',
    test(ctx) {
      const line = ctx.lines[ctx.index];
      if (!isServiceFile(ctx) || !RESTART_RE.test(line)) return false;
      return ctx.lines.some((l) => ONESHOT_RE.test(l)) && snippetOf(ctx);
    },
  },
];

module.exports = { languages: ['systemd'], rules };
