'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scanText } = require('../poll-detector.js');
const table = require('./sh.rules.js');

const scan = (text, file = 'x.sh', extra = {}) => scanText({ language: 'sh', path: file, text, tables: [table], ...extra });
const kinds = (text, file) => scan(text, file).map((f) => `${f.kind}:${f.line}`);

// One positive fixture per kind. REAL = an excerpt of a pooled script (file:line cited, code between the cited lines elided); SYNTHETIC = written for this test.
const POSITIVE = {
  // REAL agent-manager scripts/local-worker.sh:607 and :623 -- the lane's main loop `while :; do` (unbounded) with its switched-off pause `sleep "${...}"` (comment text shortened).
  'sleep-loop': [
    'while :; do                                                                     # forever loop',
    '  did_work=false',
    '  if [[ -n "$switched_off" ]]; then',
    '    sleep "${AGENT_MANAGER_SWITCHED_OFF_PAUSE_S:-${ORC_TICK_SECS:-30}}"',
    '    continue',
    '  fi',
    'done',
  ].join('\n'),
  // SYNTHETIC
  'watch-command': 'watch -n 5 "df -h /media/model-cache"',
};

test('the table has exactly the two contract kinds, all severity poll, language sh', () => {
  assert.deepStrictEqual(table.rules.map((r) => r.kind).sort(), Object.keys(POSITIVE).sort());
  assert.ok(table.rules.every((r) => r.severity === 'poll'));
  assert.deepStrictEqual(table.languages, ['sh']);
});

for (const [kind, text] of Object.entries(POSITIVE)) {
  test(`rule ${kind} fires on its positive fixture (and the table without it would not)`, () => {
    assert.ok(kinds(text).some((k) => k.startsWith(`${kind}:`)), `${kind} did not fire on: ${text}`);
    const without = { languages: table.languages, rules: table.rules.filter((r) => r.kind !== kind) };
    assert.ok(!scanText({ language: 'sh', path: 'x.sh', text, tables: [without] }).some((f) => f.kind === kind));
  });
}

test('the real lane loop fires on the sleep line only (local-worker.sh:623 excerpt)', () => {
  assert.deepStrictEqual(kinds(POSITIVE['sleep-loop']), ['sleep-loop:4']);
});

test('real watchdog loop (agent-manager scripts/queue-watcher.sh:61 and :668): the idle sleep at the end of `while :; do` is a poll', () => {
  const text = ['while :; do', '  write_heartbeat_file "$INSTANCE_ID" "idle"', '  sleep "${ORC_TICK_SECS:-60}"', 'done'].join('\n');
  assert.deepStrictEqual(kinds(text), ['sleep-loop:3']);
});

// REAL agent-manager scripts/agent-manager-common.sh:222-226. Decision after reading the loop: `while kill -0 "$curl_pid"` waits for a child process (curl -m timeout_s bounds it) and its
// condition is not an unbounded form, so the `sleep 1` is a bounded wait, NOT a poll.
const WARMUP_WAIT = [
  '  local curl_pid=$! waited=0',
  '  while kill -0 "$curl_pid" 2>/dev/null; do',
  '    sleep 1',
  '    waited=$((waited + 1))',
  '  done',
].join('\n');

// REAL agent-manager scripts/agent-manager-common.sh:354-367. Decision: `while (( waited < max_wait ))` carries a counter comparison (max_wait defaults to 900), so the `sleep 1` at
// line 366 is a bounded wait, NOT a poll.
const PRIORITY_WAIT = [
  '    local waited=0 fresh_secs=15 max_wait="${DISCUSS_PRIORITY_MAX_WAIT_SEC:-900}"',
  '    while (( waited < max_wait )); do',
  '      local newest_age=99999 now_s f mt',
  '      (( newest_age > fresh_secs )) && break',
  '      sleep 1',
  '      waited=$((waited + 1))',
  '    done',
].join('\n');

// REAL pf-backend sweep-sri.sh:10-17. Decision: `for ST in "$@"` iterates the states given on the command line, so the `sleep 5` between SRI requests is a bounded pause, NOT a poll.
const SWEEP_SRI = [
  'for ST in "$@"; do',
  '  echo "=== $ST ==="',
  '  node ingest-sri.js --state "$ST" --write > "sri-$(echo "$ST" | tr \'A-Z\' \'a-z\').log" 2>&1',
  '  sleep 5',
  'done',
  'echo "=== sweep finished ==="',
].join('\n');

// REAL agent-manager scripts/queue-watcher.sh:144-148: `for _ in 1 2 3 4 5` inside the `while :;` watchdog loop. The NEAREST enclosing loop is the bounded for, so the sleep is a retry wait.
const KILL_RETRY = ['while :; do', '  for _ in 1 2 3 4 5; do', '    kill -0 "$action_pid" 2>/dev/null || { kill_confirmed=true; break; }', '    sleep 1', '  done', 'done'].join('\n');

const NEGATIVE = {
  'a child-process wait (real agent-manager-common.sh:222)': WARMUP_WAIT,
  'a counter-bounded wait (real agent-manager-common.sh:354)': PRIORITY_WAIT,
  'a for-over-arguments pause (real pf-backend sweep-sri.sh)': SWEEP_SRI,
  'a for-1-2-3-4-5 retry inside while : (real queue-watcher.sh:144)': KILL_RETRY,
  'a one-shot sleep': 'echo starting\nsleep 3\necho started',
  'a sleep after the matching done': 'while true; do\n  work\n  break\ndone\nsleep 5',
  'a seq-bounded loop': 'for i in $(seq 1 10); do\n  sleep 1\ndone',
  'a brace-range loop': 'for i in {1..5}; do\n  sleep 1\ndone',
  'a C-style for loop': 'for ((i=0;i<5;i++)); do\n  sleep 1\ndone',
  'a while loop with -lt': 'n=0\nwhile [ "$n" -lt 5 ]; do\n  sleep 1\n  n=$((n+1))\ndone',
  'an until loop with a counter test': 'until [ "$n" -ge 5 ]; do\n  sleep 1\n  n=$((n+1))\ndone',
  'a sleep named in a comment': 'while true; do\n  # sleep 5 was removed\n  work\n  break\ndone',
  'a sleep inside a string': 'while true; do\n  echo "sleep 5"\n  break\ndone',
  'a sleep inside a here-doc': 'while true; do\n  cat <<EOF\nsleep 5\nEOF\n  break\ndone',
  'a command that only ends in sleep': 'while true; do\n  nosleep 5\n  break\ndone',
  'a watch word as an argument': 'echo watch me\nkill $watch',
};
for (const [name, text] of Object.entries(NEGATIVE)) {
  test(`silent on ${name}`, () => {
    assert.deepStrictEqual(kinds(text), [], `unexpected finding(s) on: ${text}`);
  });
}

test('the one-line form, while :, while [ 1 ], while sleep and until <command> are all unbounded', () => {
  assert.deepStrictEqual(kinds('while true; do work; sleep 5; done'), ['sleep-loop:1']);
  assert.deepStrictEqual(kinds('while :; do sleep 2; done'), ['sleep-loop:1']);
  assert.deepStrictEqual(kinds('while [ 1 ]; do\n  sleep 2\ndone'), ['sleep-loop:2']);
  assert.deepStrictEqual(kinds('while [[ 1 ]]; do\n  sleep 2\ndone'), ['sleep-loop:2']);
  assert.deepStrictEqual(kinds('while sleep 5; do\n  check\ndone'), ['sleep-loop:1']);
  assert.deepStrictEqual(kinds('until curl -s localhost:8080; do\n  sleep 1\ndone'), ['sleep-loop:2']);
});

test('a sleep in an if inside an unbounded loop is found; the loop ends at its own done', () => {
  assert.deepStrictEqual(kinds('while true; do\n  if x; then sleep 3; fi\ndone\nsleep 9'), ['sleep-loop:2']);
  assert.deepStrictEqual(kinds('while true; do\n  for f in a b; do\n    echo $f\n  done\n  sleep 4\ndone'), ['sleep-loop:5']);
});

test('the nearest loop decides: a for inside while : is not reported', () => {
  assert.deepStrictEqual(kinds('while :; do\n  for i in 1 2; do\n    sleep 1\n  done\ndone'), []);
});

test('((1)) is unbounded; a counter comparison in (( )) bounds an until or a while true &&', () => {
  assert.deepStrictEqual(kinds('while (( 1 )); do\n  sleep 2\ndone'), ['sleep-loop:2']);
  assert.deepStrictEqual(kinds('until (( n >= 5 )); do\n  sleep 1\n  n=$((n+1))\ndone'), []);
  assert.deepStrictEqual(kinds('while true && [ "$n" -lt 5 ]; do\n  sleep 1\ndone'), []);
});

test('only the loop HEADER (up to do) is judged: a counter test in the body does not bound the loop', () => {
  assert.deepStrictEqual(kinds('while true; do if (( n < 5 )); then sleep 1; fi; done'), ['sleep-loop:1']);
});

test('comments, strings and escapes: a command-looking sleep inside them is not code, an escaped quote does not open a string', () => {
  assert.deepStrictEqual(kinds('while true; do\n  work # ; sleep 5\n  break\ndone'), []);
  assert.deepStrictEqual(kinds('while true; do\n  echo "x; sleep 5"\n  break\ndone'), []);
  assert.deepStrictEqual(kinds("while true; do\n  echo 'x; sleep 5'\n  break\ndone"), []);
  assert.deepStrictEqual(kinds('while true; do\n  echo \\" ; sleep 5 ; echo \\"\ndone'), ['sleep-loop:2']);
});

test('a command that merely starts with sleep or watch is another command', () => {
  assert.deepStrictEqual(kinds('while true; do\n  sleep-until-ready 5\n  break\ndone'), []);
  assert.deepStrictEqual(kinds('watch-dog start'), []);
  assert.deepStrictEqual(kinds('while true; do\n  ./sleep.sh\n  break\ndone'), []);
});

test('watch-command: at command position only, with an argument', () => {
  assert.deepStrictEqual(kinds('echo hi; watch -n 2 ls'), ['watch-command:1']);
  assert.deepStrictEqual(kinds('sudo watch -n 2 ls'), ['watch-command:1']);
  assert.deepStrictEqual(kinds('watch'), []);
  assert.deepStrictEqual(kinds('# watch -n 2 ls'), []);
});

test('an extensionless script goes through scanText with language sh and a path with no extension', () => {
  const found = scan('#!/bin/bash\nwhile :; do\n  sleep 1\ndone', 'scripts/run-forever');
  assert.deepStrictEqual(found.map((f) => [f.path, f.line, f.kind]), [['scripts/run-forever', 3, 'sleep-loop']]);
});

test('an annotated loop returns annotated true; an empty reason does not', () => {
  const noted = scan('while :; do\n  # poll-ok: no event source exists for this device\n  sleep 5\ndone');
  assert.strictEqual(noted[0].annotated, true);
  assert.strictEqual(noted[0].reason, 'no event source exists for this device');
  assert.strictEqual(scan('while :; do\n  # poll-ok:\n  sleep 5\ndone')[0].annotated, false);
  assert.strictEqual(scan('while :; do\n  sleep 5  # poll-ok: slow device\ndone')[0].annotated, true);
});

test('the default loader finds the sh table; findings carry the snippet and line', () => {
  const [f] = scanText({ language: 'sh', path: 'x.sh', text: 'echo a\nwatch -n 1 date' });
  assert.deepStrictEqual([f.kind, f.line, f.snippet, f.language], ['watch-command', 2, 'watch -n 1 date', 'sh']);
});
