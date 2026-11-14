'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scanText } = require('../poll-detector.js');
const table = require('./sql.rules.js');

const scan = (text, file = 'x.sql', extra = {}) => scanText({ language: 'sql', path: file, text, tables: [table], ...extra });
const kinds = (text, file) => scan(text, file).map((f) => `${f.kind}:${f.line}`);

// ALL FIXTURES IN THIS FILE ARE SYNTHETIC: the survey of the 41 pooled repos found 0 pg_sleep and 0 pg_cron lines, so there is no real example to copy.
const POSITIVE = {
  'sleep-loop': 'DO $$\nBEGIN\n  LOOP\n    PERFORM pg_sleep(5);\n    PERFORM refresh_view();\n  END LOOP;\nEND $$;',
  'cron-schedule': "SELECT cron.schedule('nightly-vacuum', '0 3 * * *', 'VACUUM');",
};

test('the table has exactly the two contract kinds, both severity poll, language sql', () => {
  assert.deepStrictEqual(table.rules.map((r) => r.kind).sort(), Object.keys(POSITIVE).sort());
  assert.ok(table.rules.every((r) => r.severity === 'poll'));
  assert.deepStrictEqual(table.languages, ['sql']);
});

for (const [kind, text] of Object.entries(POSITIVE)) {
  test(`rule ${kind} fires on its positive fixture (and the table without it would not)`, () => {
    assert.ok(kinds(text).some((k) => k.startsWith(`${kind}:`)), `${kind} did not fire`);
    const without = { languages: table.languages, rules: table.rules.filter((r) => r.kind !== kind) };
    assert.ok(!scanText({ language: 'sql', path: 'x.sql', text, tables: [without] }).some((f) => f.kind === kind));
  });
}

test('findings are on the pg_sleep and cron.schedule lines', () => {
  assert.deepStrictEqual(kinds(POSITIVE['sleep-loop']), ['sleep-loop:4']);
  assert.deepStrictEqual(kinds(POSITIVE['cron-schedule']), ['cron-schedule:1']);
});

const NEGATIVE = {
  'a one-shot pg_sleep': 'SELECT pg_sleep(2);',
  'a pg_sleep after the loop closed': 'DO $$ BEGIN\n  LOOP\n    EXIT;\n  END LOOP;\n  PERFORM pg_sleep(1);\nEND $$;',
  'a FOR ... LOOP over a range (bounded)': 'DO $$ BEGIN\n  FOR i IN 1..5 LOOP\n    PERFORM pg_sleep(1);\n  END LOOP;\nEND $$;',
  'a FOR ... LOOP over a query (bounded)': 'DO $$ BEGIN\n  FOR r IN SELECT id FROM jobs LOOP\n    PERFORM pg_sleep(1);\n  END LOOP;\nEND $$;',
  'pg_sleep in a line comment': 'DO $$ BEGIN\n  LOOP\n    -- PERFORM pg_sleep(5);\n    EXIT;\n  END LOOP;\nEND $$;',
  'pg_sleep in a block comment': 'DO $$ BEGIN\n  LOOP\n    /* PERFORM pg_sleep(5); */\n    EXIT;\n  END LOOP;\nEND $$;',
  'cron.schedule in a comment': '-- SELECT cron.schedule(\'x\', \'* * * * *\', \'y\');',
  'cron.schedule in a string literal': "INSERT INTO notes VALUES ('use cron.schedule(...) to schedule it');",
  'a table named cron_schedule': 'SELECT * FROM cron_schedule;',
};
for (const [name, text] of Object.entries(NEGATIVE)) {
  test(`silent on ${name}`, () => {
    assert.deepStrictEqual(kinds(text), [], `unexpected finding(s) on: ${text}`);
  });
}

test('WHILE ... LOOP is unbounded; PERFORM pg_sleep and pg_sleep_for are found; the nearest loop decides when a FOR sits inside LOOP', () => {
  assert.deepStrictEqual(kinds('DO $$ BEGIN\n  WHILE true LOOP\n    PERFORM pg_sleep(1);\n  END LOOP;\nEND $$;'), ['sleep-loop:3']);
  assert.deepStrictEqual(kinds('DO $$ BEGIN\n  LOOP\n    PERFORM pg_sleep_for(\'5 seconds\');\n  END LOOP;\nEND $$;'), ['sleep-loop:3']);
  assert.deepStrictEqual(kinds('DO $$ BEGIN\n  LOOP\n    FOR i IN 1..3 LOOP\n      PERFORM pg_sleep(1);\n    END LOOP;\n  END LOOP;\nEND $$;'), []);
  assert.deepStrictEqual(kinds('DO $$ BEGIN\n  LOOP\n    FOR i IN 1..3 LOOP\n      NULL;\n    END LOOP;\n    PERFORM pg_sleep(1);\n  END LOOP;\nEND $$;'), ['sleep-loop:6']);
});

test('code after a multi-line block comment is scanned again; FOREACH ... LOOP is bounded; a sleep before a LOOP on the same line is outside it', () => {
  assert.deepStrictEqual(kinds("/*\nnote\n*/\nSELECT cron.schedule('a', '* * * * *', 'x');"), ['cron-schedule:4']);
  assert.deepStrictEqual(kinds('DO $$ BEGIN\n  FOREACH x IN ARRAY arr LOOP\n    PERFORM pg_sleep(1);\n  END LOOP;\nEND $$;'), []);
  assert.deepStrictEqual(kinds('DO $$ BEGIN\n  PERFORM pg_sleep(1); LOOP\n    EXIT;\n  END LOOP;\nEND $$;'), []);
});

test('cron.schedule is found with a leading SELECT or alone, and cron.schedule_in_database too', () => {
  assert.deepStrictEqual(kinds("cron.schedule('a', '* * * * *', 'x');"), ['cron-schedule:1']);
  assert.deepStrictEqual(kinds("SELECT cron.schedule_in_database('a', '* * * * *', 'x', 'db');"), ['cron-schedule:1']);
});

test('an annotated finding (-- poll-ok: <reason> above it) comes back annotated; an empty reason does not', () => {
  const noted = scan("-- poll-ok: pg_cron is the only scheduler on this host\nSELECT cron.schedule('a', '* * * * *', 'x');");
  assert.strictEqual(noted[0].annotated, true);
  assert.strictEqual(noted[0].reason, 'pg_cron is the only scheduler on this host');
  assert.strictEqual(scan("-- poll-ok:\nSELECT cron.schedule('a', '* * * * *', 'x');")[0].annotated, false);
});

test('the default loader finds the sql table', () => {
  const [f] = scanText({ language: 'sql', path: 'x.sql', text: "SELECT cron.schedule('a','* * * * *','x');" });
  assert.deepStrictEqual([f.kind, f.line, f.language], ['cron-schedule', 1, 'sql']);
});
