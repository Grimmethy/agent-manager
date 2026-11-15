'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scanText } = require('../poll-detector.js');
const table = require('./yaml.rules.js');

const scan = (text, file = 'x.yml', extra = {}) => scanText({ language: 'yaml', path: file, text, tables: [table], ...extra });
const kinds = (text, file) => scan(text, file).map((f) => `${f.kind}:${f.line}`);

// One positive fixture per kind. REAL = an excerpt of a pooled file (path cited); SYNTHETIC = written for this test.
const POSITIVE = {
  // SYNTHETIC: the only GitHub workflow in the pooled repos (annieforge .github/workflows/ci.yml) has NO schedule trigger (it runs on push and pull_request), so the cron fixture is synthetic.
  'cron-schedule': 'name: nightly\n\non:\n  schedule:\n    - cron: "0 3 * * *"\n  workflow_dispatch:\n\njobs:\n  sweep:\n    runs-on: ubuntu-latest',
  // REAL TaxHarvest-Cowork TaxHarvest/docker-compose.yml:26-33 (the db service healthcheck, `interval: 5s`).
  'healthcheck-interval': 'services:\n  db:\n    ports:\n      - "${POSTGRES_HOST_PORT:-5432}:5432"\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U taxharvest -d taxharvest"]\n      interval: 5s\n      timeout: 5s\n      retries: 20',
};

test('the table has exactly the two contract kinds with the contract severities, language yaml', () => {
  assert.deepStrictEqual(table.rules.map((r) => [r.kind, r.severity]).sort(), [['cron-schedule', 'poll'], ['healthcheck-interval', 'info']]);
  assert.deepStrictEqual(Object.keys(POSITIVE).sort(), table.rules.map((r) => r.kind).sort());
  assert.deepStrictEqual(table.languages, ['yaml']);
});

for (const [kind, text] of Object.entries(POSITIVE)) {
  test(`rule ${kind} fires on its positive fixture (and the table without it would not)`, () => {
    assert.ok(kinds(text).some((k) => k.startsWith(`${kind}:`)), `${kind} did not fire`);
    const without = { languages: table.languages, rules: table.rules.filter((r) => r.kind !== kind) };
    assert.ok(!scanText({ language: 'yaml', path: 'x.yml', text, tables: [without] }).some((f) => f.kind === kind));
  });
}

test('findings are on the cron and interval lines, with the contract severity', () => {
  assert.deepStrictEqual(scan(POSITIVE['cron-schedule']).map((f) => [f.kind, f.line, f.severity]), [['cron-schedule', 5, 'poll']]);
  assert.deepStrictEqual(scan(POSITIVE['healthcheck-interval']).map((f) => [f.kind, f.line, f.severity]), [['healthcheck-interval', 7, 'info']]);
});

test('real compose healthchecks: TaxHarvest backend `interval: 10s` (docker-compose.yml:90) and PF-Client-Portal `interval: 5s` (docker-compose.yml:114)', () => {
  const backend = 'services:\n  backend:\n    healthcheck:\n      test: ["CMD-SHELL", "wget -qO- http://localhost:3001/auth/mode > /dev/null || exit 1"]\n      interval: 10s\n      timeout: 5s\n      retries: 20\n      start_period: 30s';
  assert.deepStrictEqual(kinds(backend), ['healthcheck-interval:5']);
  const portal = 'services:\n  db:\n    networks:\n      internal:\n        ipv4_address: 172.22.1.12\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U taxharvest -d taxharvest"]\n      interval: 5s\n      timeout: 5s\n      retries: 30';
  assert.deepStrictEqual(kinds(portal), ['healthcheck-interval:8']);
});

// REAL annieforge .github/workflows/ci.yml:1-20 (read): `on:` holds push and pull_request only, no `schedule:`. NOT a poll.
const CI = 'name: ci\n\non:\n  push:\n  pull_request:\n\njobs:\n  assets:\n    name: asset licence gate\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: python3 scripts/check_assets.py';

const NEGATIVE = {
  'a workflow with push and pull_request triggers (real annieforge ci.yml)': CI,
  'a cron line outside a schedule block': 'jobs:\n  x:\n    with:\n      cron: "0 3 * * *"',
  'a schedule block outside the on key': 'jobs:\n  x:\n    schedule:\n      - cron: "0 3 * * *"',
  'an interval outside a healthcheck block': 'services:\n  db:\n    deploy:\n      interval: 5s',
  'a commented cron line': 'on:\n  schedule:\n    # - cron: "0 3 * * *"\n  push:',
  'a commented interval': 'services:\n  db:\n    healthcheck:\n      # interval: 5s\n      test: x',
  'an empty cron value': 'on:\n  schedule:\n    - cron:',
};
for (const [name, text] of Object.entries(NEGATIVE)) {
  test(`silent on ${name}`, () => {
    assert.deepStrictEqual(kinds(text), [], `unexpected finding(s) on: ${text}`);
  });
}

test('several cron entries and the same-indent sibling keys: each cron line is a finding, a sibling of healthcheck is not', () => {
  assert.deepStrictEqual(kinds('on:\n  schedule:\n    - cron: "0 3 * * *"\n    - cron: "0 9 * * 1"'), ['cron-schedule:3', 'cron-schedule:4']);
  assert.deepStrictEqual(kinds('services:\n  db:\n    healthcheck:\n      test: x\n    interval: 5s'), []);
});

test('parent detection: a column-0 comment inside the block does not end it, a quoted "on" key works, a cron under on but not under schedule is not a schedule', () => {
  assert.deepStrictEqual(kinds('on:\n  schedule:\n# comment at column 0\n    - cron: "0 3 * * *"'), ['cron-schedule:4']);
  assert.deepStrictEqual(kinds('"on":\n  schedule:\n    - cron: "0 3 * * *"'), ['cron-schedule:3']);
  assert.deepStrictEqual(kinds('on:\n  push:\n    - cron: "0 3 * * *"'), []);
  assert.deepStrictEqual(kinds('services:\n  db:\n    healthcheck:\n      options:\n        interval: 5s'), []);
  assert.deepStrictEqual(kinds('services:\n  db:\n    healthcheck:\n      interval:'), []);
  assert.deepStrictEqual(kinds('on:\n  schedule:\n    cron: "0 3 * * *"'), []);
  assert.deepStrictEqual(kinds('on:\n  schedule:\n\n\n    - cron: "0 3 * * *"'), ['cron-schedule:5']);
});

test('an annotated finding (# poll-ok: <reason> above it) comes back annotated; an empty reason does not', () => {
  const noted = scan('on:\n  schedule:\n    # poll-ok: the upstream feed has no webhook\n    - cron: "0 3 * * *"');
  assert.strictEqual(noted[0].annotated, true);
  assert.strictEqual(noted[0].reason, 'the upstream feed has no webhook');
  assert.strictEqual(scan('on:\n  schedule:\n    # poll-ok:\n    - cron: "0 3 * * *"')[0].annotated, false);
});

test('the default loader finds the yaml table', () => {
  const [f] = scanText({ language: 'yaml', path: 'c.yaml', text: 'healthcheck:\n  interval: 5s' });
  assert.deepStrictEqual([f.kind, f.line, f.severity], ['healthcheck-interval', 2, 'info']);
});
