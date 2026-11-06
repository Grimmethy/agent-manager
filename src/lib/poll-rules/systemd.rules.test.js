'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scanText } = require('../poll-detector.js');
const table = require('./systemd.rules.js');

const scan = (text, file, extra = {}) => scanText({ language: 'systemd', path: file, text, tables: [table], ...extra });
const kinds = (text, file) => scan(text, file).map((f) => `${f.kind}:${f.line}`);

// One positive fixture per kind. REAL = a pooled unit file (path cited); SYNTHETIC = written for this test.
const POSITIVE = {
  // REAL postforge deploy/postforge-refresh.timer (read in full): a weekly OnCalendar timer, periodic work.
  'timer-unit': { file: 'deploy/postforge-refresh.timer', text: '[Unit]\nDescription=PostForge weekly token refresh (token lasts 60 days)\n\n[Timer]\nOnCalendar=Sun *-*-* 03:00:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target' },
  // SYNTHETIC: a oneshot service that systemd restarts forever.
  'restart-loop': { file: 'deploy/sync.service', text: '[Service]\nType=oneshot\nExecStart=/usr/bin/sync-inventory\nRestart=always\nRestartSec=30' },
};

test('the table has exactly the two contract kinds, both severity poll, language systemd', () => {
  assert.deepStrictEqual(table.rules.map((r) => r.kind).sort(), Object.keys(POSITIVE).sort());
  assert.ok(table.rules.every((r) => r.severity === 'poll'));
  assert.deepStrictEqual(table.languages, ['systemd']);
});

for (const [kind, { file, text }] of Object.entries(POSITIVE)) {
  test(`rule ${kind} fires on its positive fixture (and the table without it would not)`, () => {
    assert.ok(kinds(text, file).some((k) => k.startsWith(`${kind}:`)), `${kind} did not fire`);
    const without = { languages: table.languages, rules: table.rules.filter((r) => r.kind !== kind) };
    assert.ok(!scanText({ language: 'systemd', path: file, text, tables: [without] }).some((f) => f.kind === kind));
  });
}

test('the real postforge timer is found on the OnCalendar line only', () => {
  assert.deepStrictEqual(kinds(POSITIVE['timer-unit'].text, 'deploy/postforge-refresh.timer'), ['timer-unit:5']);
});

// REAL pf-backend ops/systemd/pf-enrich.service:15-16 (the unit read in full). Decision: `Restart=on-failure` with `RestartSec=15` is crash supervision of a long-running worker (Type
// defaults to simple), NOT a poll.
const PF_ENRICH = '[Unit]\nStartLimitIntervalSec=300\nStartLimitBurst=5\n\n[Service]\nUser=grimmethy\nExecStart=/usr/bin/python3 python_services/worker.py\nRestart=on-failure\nRestartSec=15\nTimeoutStopSec=30\n\n[Install]\nWantedBy=multi-user.target';

// REAL agent-manager scripts/systemd/agent-manager-tailnet-gateway.service:9-18. Decision: `Type=simple` with `Restart=always`, `RestartSec=10` supervises a daemon that exits when tailscaled
// is not up yet: supervision, NOT a poll.
const GATEWAY = '[Service]\nType=simple\nWorkingDirectory=/media/model-cache/github/agent-manager\nExecStart=/usr/bin/env node scripts/tailnet-gateway.js\n# tailscaled may not be up yet at boot: retry until it is\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target';

const NEGATIVE = {
  'a worker supervised with Restart=on-failure (real pf-enrich.service)': { file: 'ops/systemd/pf-enrich.service', text: PF_ENRICH },
  'a daemon supervised with Restart=always (real tailnet gateway service)': { file: 'scripts/systemd/agent-manager-tailnet-gateway.service', text: GATEWAY },
  'OnBootSec alone (a one-shot delay)': { file: 'a.timer', text: '[Timer]\nOnBootSec=5min' },
  'a oneshot service that is not restarted': { file: 'a.service', text: '[Service]\nType=oneshot\nExecStart=/bin/true\nRemainAfterExit=yes' },
  'a oneshot with Restart=on-failure': { file: 'a.service', text: '[Service]\nType=oneshot\nRestart=on-failure' },
  'a commented OnCalendar': { file: 'a.timer', text: '[Timer]\n# OnCalendar=daily\n; OnUnitActiveSec=5min\nOnBootSec=1min' },
  'a commented Restart=always in a oneshot': { file: 'a.service', text: '[Service]\nType=oneshot\n# Restart=always' },
  'OnCalendar written in a .service file': { file: 'a.service', text: '[Service]\nOnCalendar=daily' },
  'Restart=always in a .timer file': { file: 'a.timer', text: '[Timer]\nType=oneshot\nRestart=always' },
  'an empty OnCalendar value': { file: 'a.timer', text: '[Timer]\nOnCalendar=' },
};
for (const [name, { file, text }] of Object.entries(NEGATIVE)) {
  test(`silent on ${name}`, () => {
    assert.deepStrictEqual(kinds(text, file), [], `unexpected finding(s) on: ${text}`);
  });
}

test('every periodic timer key is found; Restart=on-success counts for a oneshot; Type=oneshot may come after the Restart line', () => {
  assert.deepStrictEqual(kinds('[Timer]\nOnUnitActiveSec=15min', 'a.timer'), ['timer-unit:2']);
  assert.deepStrictEqual(kinds('[Timer]\nOnUnitInactiveSec=1h', 'a.timer'), ['timer-unit:2']);
  assert.deepStrictEqual(kinds('[Service]\nType=oneshot\nRestart=on-success', 'a.service'), ['restart-loop:3']);
  assert.deepStrictEqual(kinds('[Service]\nRestart=always\nType=oneshot', 'a.service'), ['restart-loop:2']);
});

test('an annotated finding (# poll-ok: <reason> above it) comes back annotated; an empty reason does not', () => {
  const noted = scan('[Timer]\n# poll-ok: the token expires on a fixed calendar\nOnCalendar=weekly', 'a.timer');
  assert.strictEqual(noted[0].annotated, true);
  assert.strictEqual(noted[0].reason, 'the token expires on a fixed calendar');
  assert.strictEqual(scan('[Timer]\n# poll-ok:\nOnCalendar=weekly', 'a.timer')[0].annotated, false);
});

test('the default loader finds the systemd table', () => {
  const [f] = scanText({ language: 'systemd', path: 'x.timer', text: 'OnCalendar=daily' });
  assert.deepStrictEqual([f.kind, f.line, f.language, f.severity], ['timer-unit', 1, 'systemd', 'poll']);
});
