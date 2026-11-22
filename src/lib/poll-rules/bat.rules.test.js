'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scanText } = require('../poll-detector.js');
const table = require('./bat.rules.js');

const scan = (text, file = 'x.bat', extra = {}) => scanText({ language: 'bat', path: file, text, tables: [table], ...extra });
const kinds = (text, file) => scan(text, file).map((f) => `${f.kind}:${f.line}`);

// One positive fixture per kind. REAL = an excerpt of a pooled script (file:line cited); SYNTHETIC = written for this test.
const POSITIVE = {
  // REAL TaxHarvest-Cowork TaxHarvest/upgrade.bat:7-18 (the `:loop` ... `goto loop` retry-forever; RETRY_DELAY seconds between attempts, no counter).
  'delay-loop': [
    ':loop',
    'echo [%DATE% %TIME%] Starting upgrade ... >> "%LOG_FILE%"',
    'call upgrade.sh',
    'set EXITCODE=%ERRORLEVEL%',
    'if "%EXITCODE%"=="0" (',
    '    goto end',
    ')',
    'timeout /t %RETRY_DELAY% /nobreak >nul',
    'goto loop',
    ':end',
  ].join('\n'),
  // SYNTHETIC
  'scheduled-task': 'schtasks /create /tn "sync" /sc minute /mo 5 /tr "C:\\sync.bat"',
};

test('the table has exactly the two contract kinds, all severity poll, language bat', () => {
  assert.deepStrictEqual(table.rules.map((r) => r.kind).sort(), Object.keys(POSITIVE).sort());
  assert.ok(table.rules.every((r) => r.severity === 'poll'));
  assert.deepStrictEqual(table.languages, ['bat']);
});

for (const [kind, text] of Object.entries(POSITIVE)) {
  test(`rule ${kind} fires on its positive fixture (and the table without it would not)`, () => {
    assert.ok(kinds(text).some((k) => k.startsWith(`${kind}:`)), `${kind} did not fire on: ${text}`);
    const without = { languages: table.languages, rules: table.rules.filter((r) => r.kind !== kind) };
    assert.ok(!scanText({ language: 'bat', path: 'x.bat', text, tables: [without] }).some((f) => f.kind === kind));
  });
}

test('the real upgrade.bat retry loop is found on the timeout line only (upgrade.bat:17)', () => {
  assert.deepStrictEqual(kinds(POSITIVE['delay-loop']), ['delay-loop:8']);
});

// REAL pf-backend refresh-national.bat:81-82. Decision after reading it: `timeout /t 60 >nul 2>&1` at the end gives a person a minute to read the report (a `pause` replacement for
// a Scheduled Task). No label, no goto: a one-shot delay, NOT a poll.
const REFRESH_NATIONAL = ['echo Full log: %LOG%', 'echo.', 'REM  pause waits for a keypress a Scheduled Task can never deliver. timeout gives a person a', 'timeout /t 60 >nul 2>&1', 'endlocal'].join('\n');

// REAL agent-manager launch.bat:57. Decision: `ping -n 3 127.0.0.1` is a 2-second delay inside a quoted `cmd /c "..."` string that opens the browser once: a one-shot wait, NOT a poll.
const LAUNCH = '        start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%AGENT_MANAGER_DASHBOARD_PORT%"';

const NEGATIVE = {
  'a one-shot timeout at the end of a script (real refresh-national.bat)': REFRESH_NATIONAL,
  'a ping delay inside a quoted cmd /c string (real launch.bat)': LAUNCH,
  'a one-shot ping delay': 'ping -n 3 127.0.0.1 >nul\nstart http://localhost',
  'a loop bounded by a counter (set /a plus an if compare)': 'set n=0\n:retry\nset /a n+=1\nif %n% GEQ 5 goto done\ntimeout /t 5 /nobreak\ngoto retry\n:done',
  'a delay after the goto that closes the loop': ':l\nwork\ngoto l\ntimeout /t 5',
  'a delay before the label': 'timeout /t 5\n:l\nwork\ngoto l',
  'a goto :eof': 'timeout /t 5\ngoto :eof',
  'a REM comment': ':l\nREM timeout /t 5\ngoto l',
  'a :: comment': ':l\n:: timeout /t 5\ngoto l',
  'echo text naming timeout': ':l\necho timeout /t 5\ngoto l',
  'a label that no goto jumps back to': ':a\ntimeout /t 1\n:b\ngoto b',
  'schtasks /create in a REM line': 'REM schtasks /create /tn x',
  'schtasks /create in echo text': 'echo run schtasks /create to schedule it',
};
for (const [name, text] of Object.entries(NEGATIVE)) {
  test(`silent on ${name}`, () => {
    assert.deepStrictEqual(kinds(text), [], `unexpected finding(s) on: ${text}`);
  });
}

test('delay forms: ping -n N localhost, ping 127.0.0.1 -n N, timeout.exe /t, a goto :label with a colon, case-insensitive', () => {
  assert.deepStrictEqual(kinds(':l\nping -n 5 127.0.0.1 >nul\ngoto l'), ['delay-loop:2']);
  assert.deepStrictEqual(kinds(':l\nPING -n 5 localhost >nul\nGOTO l'), ['delay-loop:2']);
  assert.deepStrictEqual(kinds(':l\nping 127.0.0.1 -n 5 >nul\ngoto :l'), ['delay-loop:2']);
  assert.deepStrictEqual(kinds(':Loop\ntimeout.exe /T 5\nGoTo LOOP'), ['delay-loop:2']);
});

test('a set /a without an if compare is not a counter test', () => {
  assert.deepStrictEqual(kinds('set n=0\n:l\nset /a n+=1\ntimeout /t 5\ngoto l'), ['delay-loop:4']);
});

test('a quoted delay inside a real loop is text, not a command; goto :eof is not a loop even when an :eof label exists', () => {
  assert.deepStrictEqual(kinds(':l\nstart "" cmd /c "ping -n 3 127.0.0.1 >nul"\ngoto l'), []);
  assert.deepStrictEqual(kinds(':eof\ntimeout /t 5\ngoto :eof'), []);
});

test('the counter test needs BOTH a set /a and an if compare, in any compare form, and the goto line itself is searched', () => {
  assert.deepStrictEqual(kinds(':l\nif %state% == ready goto done\ntimeout /t 5\ngoto l\n:done'), ['delay-loop:3']);
  assert.deepStrictEqual(kinds(':l\nset /a n+=1\nif %n%==5 goto done\ntimeout /t 5\ngoto l\n:done'), []);
  assert.deepStrictEqual(kinds(':retry\nset /a n+=1\ntimeout /t 5\nif %n% LSS 5 goto retry'), []);
  assert.deepStrictEqual(kinds('set /a n+=1\n:retry\ntimeout /t 5\nif %n% LSS 5 goto retry'), ['delay-loop:3']);
});

test('two labels in a row: a delay between the inner label and its goto is found', () => {
  assert.deepStrictEqual(kinds(':outer\n:inner\ntimeout /t 2\ngoto inner'), ['delay-loop:3']);
});

test('schtasks /create is a scheduled-task; an annotated one comes back annotated (REM and :: forms); an empty reason does not', () => {
  assert.deepStrictEqual(kinds('SCHTASKS.EXE /Create /tn x'), ['scheduled-task:1']);
  const rem = scan('REM poll-ok: nightly refresh has no event source\nschtasks /create /tn x');
  assert.strictEqual(rem[0].annotated, true);
  assert.strictEqual(rem[0].reason, 'nightly refresh has no event source');
  assert.strictEqual(scan(':: poll-ok: nightly refresh\nschtasks /create /tn x')[0].annotated, true);
  assert.strictEqual(scan('REM poll-ok:\nschtasks /create /tn x')[0].annotated, false);
  const loop = scan(':l\nREM poll-ok: waits for the share\ntimeout /t 5\ngoto l');
  assert.strictEqual(loop[0].annotated, true);
});

test('.cmd paths work the same and the default loader finds the bat table', () => {
  const [f] = scanText({ language: 'bat', path: 'x.cmd', text: 'schtasks /create /tn x' });
  assert.deepStrictEqual([f.kind, f.line, f.language], ['scheduled-task', 1, 'bat']);
});
