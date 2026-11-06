'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scanText } = require('../poll-detector.js');
const table = require('./ps1.rules.js');

const scan = (text, file = 'x.ps1', extra = {}) => scanText({ language: 'ps1', path: file, text, tables: [table], ...extra });
const kinds = (text, file) => scan(text, file).map((f) => `${f.kind}:${f.line}`);

// One positive fixture per kind. REAL = an excerpt of a pooled script (file:line cited); SYNTHETIC = written for this test.
const POSITIVE = {
  // REAL agent-manager src/apply-runner.ps1:355-376 (shortened): the apply runner's main `while ($true)` loop; its switch arms sleep 10 min / 2 min / 30 s / 15 s between passes.
  'sleep-loop': [
    'while ($true) {',
    "    Write-Heartbeat -Status 'checking'",
    "    $result = 'error'",
    '    switch ($result) {',
    "        'budget' { Write-Host 'Budget gate: sleeping 10 min.' -ForegroundColor DarkGray; Start-Sleep -Seconds 600 }",
    "        'idle'   { Write-Host 'Queue empty: sleeping 2 min.' -ForegroundColor DarkGray; Start-Sleep -Seconds 120 }",
    '        default  { Start-Sleep -Seconds 15 }',
    '    }',
    '}',
  ].join('\n'),
  // SYNTHETIC
  'scheduled-task': '$trigger = New-ScheduledTaskTrigger -Once -At 3am -RepetitionInterval (New-TimeSpan -Minutes 5)\nRegister-ScheduledTask -TaskName "sync" -Trigger $trigger -Action $action',
};

test('the table has exactly the two contract kinds, all severity poll, language ps1', () => {
  assert.deepStrictEqual(table.rules.map((r) => r.kind).sort(), Object.keys(POSITIVE).sort());
  assert.ok(table.rules.every((r) => r.severity === 'poll'));
  assert.deepStrictEqual(table.languages, ['ps1']);
});

for (const [kind, text] of Object.entries(POSITIVE)) {
  test(`rule ${kind} fires on its positive fixture (and the table without it would not)`, () => {
    assert.ok(kinds(text).some((k) => k.startsWith(`${kind}:`)), `${kind} did not fire on: ${text}`);
    const without = { languages: table.languages, rules: table.rules.filter((r) => r.kind !== kind) };
    assert.ok(!scanText({ language: 'ps1', path: 'x.ps1', text, tables: [without] }).some((f) => f.kind === kind));
  });
}

test('the real apply-runner loop: all four sleeps in the switch arms are found (apply-runner.ps1:371-375)', () => {
  assert.deepStrictEqual(kinds(POSITIVE['sleep-loop']), ['sleep-loop:5', 'sleep-loop:6', 'sleep-loop:7']);
});

// REAL skiptracege owner-enrichment/start-searxng.ps1:22-30. Decision after reading the surrounding lines: `Start-Sleep -Seconds 8` follows `docker run -d` once and there is no loop
// around it: a one-shot wait for the container to come up, NOT a poll.
const SEARXNG = [
  'docker rm -f searxng *> $null 2>&1',
  '',
  'docker run -d --name searxng `',
  '  -p 8888:8080 `',
  '  --restart unless-stopped `',
  '  searxng/searxng | Out-Null',
  '',
  'Start-Sleep -Seconds 8',
  '',
  '# Prove the JSON API answers before declaring success.',
  'try {',
  '  $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8888/search?q=test&format=json" -TimeoutSec 20',
  '}',
].join('\n');

const NEGATIVE = {
  'a one-shot wait after docker run (real start-searxng.ps1)': SEARXNG,
  'a for loop with a counter': 'for ($i = 0; $i -lt 5; $i++) {\n  Start-Sleep -Seconds 1\n}',
  'a foreach loop': 'foreach ($h in $hosts) {\n  Test-Connection $h\n  Start-Sleep -Seconds 2\n}',
  'a while loop with a counter': 'while ($i -lt 10) {\n  Start-Sleep -Seconds 1\n  $i++\n}',
  'a do-while with an attempt counter': 'do {\n  Start-Sleep -Seconds 5\n  $attempt++\n} while ($attempt -lt 5)',
  'a do-until with a counter': 'do {\n  Start-Sleep -Seconds 5\n  $n++\n} until ($n -ge 5)',
  'a pipeline ForEach-Object over a range': 'while ($true) {\n  1..3 | ForEach-Object { Start-Sleep -Seconds 1 }\n}',
  'a Start-Sleep after the loop closed': 'while ($true) {\n  work\n  break\n}\nStart-Sleep -Seconds 5',
  'Start-Sleep in a line comment': 'while ($true) {\n  # Start-Sleep -Seconds 5 was removed\n  break\n}',
  'Start-Sleep in a block comment': 'while ($true) {\n  <# Start-Sleep -Seconds 5 #>\n  break\n}',
  'Start-Sleep in a string': 'while ($true) {\n  Write-Host "Start-Sleep -Seconds 5"\n  break\n}',
  'Start-Sleep in a here-string': 'while ($true) {\n  $x = @"\nStart-Sleep -Seconds 5\n"@\n  break\n}',
  'Register-ScheduledTask named in a string': 'Write-Host "run Register-ScheduledTask and schtasks /create to schedule it"',
  'a trigger without a repetition, daily or weekly': '$t = New-ScheduledTaskTrigger -AtLogOn',
};
for (const [name, text] of Object.entries(NEGATIVE)) {
  test(`silent on ${name}`, () => {
    assert.deepStrictEqual(kinds(text), [], `unexpected finding(s) on: ${text}`);
  });
}

test('every unbounded loop form is found: while ($true), while (1), for (;;), do-while ($true), do-until without a counter, one-line and Allman style', () => {
  assert.deepStrictEqual(kinds('while ($true) {\n  Start-Sleep 5\n}'), ['sleep-loop:2']);
  assert.deepStrictEqual(kinds('while (1) {\n  Start-Sleep 5\n}'), ['sleep-loop:2']);
  assert.deepStrictEqual(kinds('for (;;) {\n  Start-Sleep 5\n}'), ['sleep-loop:2']);
  assert.deepStrictEqual(kinds('do {\n  Start-Sleep 5\n} while ($true)'), ['sleep-loop:2']);
  assert.deepStrictEqual(kinds('do {\n  Start-Sleep 5\n} until ($ok)'), ['sleep-loop:2']);
  assert.deepStrictEqual(kinds('do {\n  Start-Sleep 5\n}\nwhile ($True)'), ['sleep-loop:2']);
  assert.deepStrictEqual(kinds('while ($true) { Start-Sleep 5 }'), ['sleep-loop:1']);
  assert.deepStrictEqual(kinds('while ($true)\n{\n  Start-Sleep 5\n}'), ['sleep-loop:3']);
});

test('the nearest loop decides: a bounded loop inside while ($true) is not reported, and an if inside the unbounded loop is', () => {
  assert.deepStrictEqual(kinds('while ($true) {\n  for ($i = 0; $i -lt 3; $i++) {\n    Start-Sleep 1\n  }\n}'), []);
  assert.deepStrictEqual(kinds('while ($true) {\n  if ($x) {\n    Start-Sleep 1\n  }\n}'), ['sleep-loop:3']);
});

test('code after a multi-line block comment and after a here-string is scanned again; a backtick-escaped quote does not end a string', () => {
  assert.deepStrictEqual(kinds('<#\nnote\n#>\nwhile ($true) {\n  Start-Sleep 1\n}'), ['sleep-loop:5']);
  assert.deepStrictEqual(kinds('$x = @"\ntext\n"@\nwhile ($true) {\n  Start-Sleep 1\n}'), ['sleep-loop:5']);
  assert.deepStrictEqual(kinds('while ($true) {\n  Write-Host "say `\"hi`\" Start-Sleep 5"\n  break\n}'), []);
  assert.deepStrictEqual(kinds('while ($true) {\n  Write-Host "a`\" Start-Sleep 5"\n  break\n}'), []);
  assert.deepStrictEqual(kinds('while ($true) {\n  $x = @"\nline one\nStart-Sleep -Seconds 5\n"@\n  break\n}'), []);
});

test('scheduled-task: schtasks /create, daily and weekly triggers', () => {
  assert.deepStrictEqual(kinds('schtasks /create /tn "x" /sc daily /tr y'), ['scheduled-task:1']);
  assert.deepStrictEqual(kinds('& schtasks.exe /create /tn x'), ['scheduled-task:1']);
  assert.deepStrictEqual(kinds('$t = New-ScheduledTaskTrigger -Daily -At 3am'), ['scheduled-task:1']);
  assert.deepStrictEqual(kinds('$t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday'), ['scheduled-task:1']);
});

test('an annotated sleep (# poll-ok: <reason> above it) comes back annotated; an empty reason does not; test paths are skipped', () => {
  const noted = scan('while ($true) {\n  # poll-ok: the budget monitor has no event\n  Start-Sleep -Seconds 600\n}');
  assert.strictEqual(noted[0].annotated, true);
  assert.strictEqual(noted[0].reason, 'the budget monitor has no event');
  assert.strictEqual(scan('while ($true) {\n  # poll-ok:\n  Start-Sleep -Seconds 600\n}')[0].annotated, false);
  assert.deepStrictEqual(scan('while ($true) { Start-Sleep 1 }', 'tests/a.ps1'), []);
});

test('the default loader finds the ps1 table', () => {
  const [f] = scanText({ language: 'ps1', path: 'x.ps1', text: 'schtasks /create /tn x' });
  assert.deepStrictEqual([f.kind, f.line, f.language], ['scheduled-task', 1, 'ps1']);
});
