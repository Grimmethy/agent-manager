'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scanText } = require('../poll-detector.js');
const table = require('./config.rules.js');

const scan = (text, file = 'plugins.json', extra = {}) => scanText({ language: 'config', path: file, text, tables: [table], ...extra });
const kinds = (text, file) => scan(text, file).map((f) => `${f.kind}:${f.line}`);

// FIXTURES: the three config files named in the task (agent-manager plugins.json, task-domains.json, package.json) hold NO interval-like key with a positive number and no watch script
// (checked with grep -nEi on all three), and the other tracked config JSON files have none either, so every POSITIVE fixture is SYNTHETIC. The negatives marked REAL come from them.
const POSITIVE = {
  'config-interval': '{\n  "name": "demo",\n  "intervalMs": 5000\n}',
  'watch-script': '{\n  "scripts": {\n    "dev": "nodemon src/server.js",\n    "test": "node --test"\n  }\n}',
};

test('the table has exactly the two contract kinds, both severity info, language config', () => {
  assert.deepStrictEqual(table.rules.map((r) => r.kind).sort(), Object.keys(POSITIVE).sort());
  assert.ok(table.rules.every((r) => r.severity === 'info'));
  assert.deepStrictEqual(table.languages, ['config']);
});

for (const [kind, text] of Object.entries(POSITIVE)) {
  test(`rule ${kind} fires on its positive fixture (and the table without it would not)`, () => {
    const file = kind === 'watch-script' ? 'package.json' : 'plugins.json';
    assert.ok(kinds(text, file).some((k) => k.startsWith(`${kind}:`)), `${kind} did not fire`);
    const without = { languages: table.languages, rules: table.rules.filter((r) => r.kind !== kind) };
    assert.ok(!scanText({ language: 'config', path: file, text, tables: [without] }).some((f) => f.kind === kind));
  });
}

test('findings are on the key line with severity info', () => {
  assert.deepStrictEqual(scan(POSITIVE['config-interval']).map((f) => [f.kind, f.line, f.severity]), [['config-interval', 3, 'info']]);
  assert.deepStrictEqual(scan(POSITIVE['watch-script'], 'package.json').map((f) => [f.kind, f.line, f.severity]), [['watch-script', 3, 'info']]);
});

// REAL agent-manager package.json:16-17: scripts.test runs node --test once (no --watch, no nodemon, no `watch `). NOT a watch script.
const REAL_PACKAGE = '{\n  "scripts": {\n    "test": "node scripts/with-test-tmp.js node --test src/*.test.js src/**/*.test.js scripts/*.test.js test/*.test.js *.test.js"\n  }\n}';

const NEGATIVE = {
  'the real agent-manager test script': { file: 'package.json', text: REAL_PACKAGE },
  'a data key such as "total": 3': { file: 'plugins.json', text: '{\n  "total": 3,\n  "count": 12\n}' },
  'an interval key with value 0': { file: 'plugins.json', text: '{\n  "pollMs": 0\n}' },
  'an interval key with a string value': { file: 'plugins.json', text: '{\n  "interval": "5s"\n}' },
  'a numeric key without an interval-like name': { file: 'plugins.json', text: '{\n  "port": 7420,\n  "timeoutMs": 3000\n}' },
  'a negative interval': { file: 'plugins.json', text: '{\n  "intervalMs": -1\n}' },
  'a watch word in a non-scripts key': { file: 'package.json', text: '{\n  "description": "nodemon is not used here",\n  "scripts": {\n    "test": "node --test"\n  }\n}' },
  'a watch script outside package.json': { file: 'plugins.json', text: '{\n  "scripts": {\n    "dev": "nodemon app.js"\n  }\n}' },
  'a --watch word after the scripts block closed': { file: 'package.json', text: '{\n  "scripts": {\n    "test": "node --test"\n  },\n  "dev": "nodemon app.js"\n}' },
  'a key that only contains "every" inside a comment': { file: 'x.toml', text: '# every = 5\nname = "x"' },
};
for (const [name, { file, text }] of Object.entries(NEGATIVE)) {
  test(`silent on ${name}`, () => {
    assert.deepStrictEqual(kinds(text, file), [], `unexpected finding(s) on: ${text}`);
  });
}

test('key name forms: interval, poll, refresh, period and every, in any case, with integers and decimals', () => {
  for (const key of ['intervalMs', 'pollMs', 'refreshSeconds', 'everyMinutes', 'check_period', 'POLL_SECONDS', 'Interval']) {
    assert.deepStrictEqual(kinds(`{\n  "${key}": 30\n}`), ['config-interval:2'], key);
  }
  assert.deepStrictEqual(kinds('{\n  "intervalSec": 0.5\n}'), ['config-interval:2']);
});

test('TOML and YAML-style config lines: key = number and key: number, with a trailing comment', () => {
  assert.deepStrictEqual(kinds('[sync]\npoll_seconds = 30\nname = "x"', 'settings.toml'), ['config-interval:2']);
  assert.deepStrictEqual(kinds('refreshSeconds: 60  # per minute', 'app.yaml'), ['config-interval:1']);
  assert.deepStrictEqual(kinds('{\n  "intervalMs": 5000,\n  "x": 1\n}'), ['config-interval:2']);
});

test('watch-script forms: --watch, nodemon, and a `watch ` command inside scripts', () => {
  assert.deepStrictEqual(kinds('{\n  "scripts": {\n    "t": "node --test --watch src"\n  }\n}', 'package.json'), ['watch-script:3']);
  assert.deepStrictEqual(kinds('{\n  "scripts": {\n    "w": "watch -n 5 ls"\n  }\n}', 'package.json'), ['watch-script:3']);
  assert.deepStrictEqual(kinds('{\n  "scripts": {\n    "a": "npm run build && watch tsc"\n  }\n}', 'package.json'), ['watch-script:3']);
  assert.deepStrictEqual(kinds('{\n  "scripts": {\n    "n": "stopwatch go"\n  }\n}', 'package.json'), []);
});

test('an annotated finding (# poll-ok: <reason> in a toml file above it) comes back annotated; an empty reason does not', () => {
  const noted = scan('# poll-ok: upstream has no push channel\npoll_seconds = 30', 'settings.toml');
  assert.strictEqual(noted[0].annotated, true);
  assert.strictEqual(noted[0].reason, 'upstream has no push channel');
  assert.strictEqual(scan('# poll-ok:\npoll_seconds = 30', 'settings.toml')[0].annotated, false);
});

test('the default loader finds the config table, and data JSON never reaches it (languageOf is null for it)', () => {
  const [f] = scanText({ language: 'config', path: 'task-domains.json', text: '{\n  "refreshMs": 1000\n}' });
  assert.deepStrictEqual([f.kind, f.line, f.language, f.severity], ['config-interval', 2, 'config', 'info']);
  const { languageOf } = require('../poll-detector.js');
  assert.strictEqual(languageOf('vendor/tokenfold/core/assets/tokenizers/deepseek3.json'), null);
  assert.deepStrictEqual(scanText({ language: languageOf('queue/done/x.json'), path: 'queue/done/x.json', text: '{ "intervalMs": 5 }' }), []);
});
