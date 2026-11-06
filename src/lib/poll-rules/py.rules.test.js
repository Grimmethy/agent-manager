'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scanText } = require('../poll-detector.js');
const table = require('./py.rules.js');

const scan = (text, file = 'x.py', extra = {}) => scanText({ language: 'py', path: file, text, tables: [table], ...extra });
const kinds = (text, file) => scan(text, file).map((f) => `${f.kind}:${f.line}`);

// One positive fixture per kind. REAL = copied from a pooled repo (file:line cited); SYNTHETIC = written for this test.
const POSITIVE = {
  // REAL /media/model-cache/github/agent-manager python/dashboard/app_settings_helpers.py:208-209 (a daemon thread's sweep loop). Decision: an unbounded `while True:` that sleeps is a poll.
  'sleep-loop': '    while True:\n        time.sleep(60)',
  // SYNTHETIC
  'schedule-every': 'import schedule\nschedule.every(5).minutes.do(sync_inventory)',
  // SYNTHETIC
  'timer-rearm': 'def tick():\n    refresh()\n    threading.Timer(30.0, tick).start()',
  // SYNTHETIC
  'wait-loop': 'def run(stop):\n    while not stop.is_set():\n        refresh()\n        stop.wait(30)',
};

test('the table has exactly the four contract kinds, all severity poll, language py', () => {
  assert.deepStrictEqual(table.rules.map((r) => r.kind).sort(), Object.keys(POSITIVE).sort());
  assert.ok(table.rules.every((r) => r.severity === 'poll'));
  assert.deepStrictEqual(table.languages, ['py']);
});

for (const [kind, text] of Object.entries(POSITIVE)) {
  test(`rule ${kind} fires on its positive fixture (and the table without it would not)`, () => {
    assert.ok(kinds(text).some((k) => k.startsWith(`${kind}:`)), `${kind} did not fire on: ${text}`);
    const without = { languages: table.languages, rules: table.rules.filter((r) => r.kind !== kind) };
    assert.ok(!scanText({ language: 'py', path: 'x.py', text, tables: [without] }).some((f) => f.kind === kind));
  });
}

test('real while True sleep loop in a route module (python/dashboard/routes/internal_chat.py:59-60)', () => {
  assert.deepStrictEqual(kinds('    import single_flight_lock\n    while True:\n        time.sleep(60)'), ['sleep-loop:3']);
});

// REAL llm-tuner/experiments/sweep.py:65-72. Decision after reading the 15 lines around line 71: the sleep(60) sits in `for attempt in range(5):` (an except branch,
// 503 while a pipeline call is in flight). A loop bounded by a range is a retry wait, so this is NOT a poll.
const SWEEP_RETRY = [
  '    for attempt in range(5):  # 503 while a pipeline call is in flight',
  '        try:',
  '            res = post("/api/gpu/acquire", {"owner": "llm-tuner", "workload": "llama-server", "workloadArgs": args})',
  '            break',
  '        except urllib.error.HTTPError as exc:',
  '            print("acquire attempt %d: HTTP %d" % (attempt + 1, exc.code), flush=True)',
  '            time.sleep(60)',
].join('\n');

// REAL llm-tuner/harness/run_harness.py:63-69: the same shape (range(5) acquire retry, sleep(60) in the except branch). NOT a poll.
const HARNESS_RETRY = SWEEP_RETRY.replace('flush=True', 'flush=True').replace('print("acquire attempt %d: HTTP %d" % (attempt + 1, exc.code), flush=True)', 'print("acquire attempt %d: HTTP %d %s" % (attempt + 1, exc.code, exc.read()[:200]), flush=True)');

// REAL python/dashboard/plugin_process_manager.py:221-225: a loop bounded by a deadline. NOT a poll.
const DEADLINE_WAIT = '    deadline = time.time() + wait_s\n    while time.time() < deadline:\n        if not is_running(name):\n            break\n        time.sleep(0.1)';

const NEGATIVE = {
  'a range-bounded acquire retry (real llm-tuner sweep.py)': SWEEP_RETRY,
  'a range-bounded acquire retry (real llm-tuner run_harness.py)': HARNESS_RETRY,
  'a deadline-bounded wait (real plugin_process_manager.py)': DEADLINE_WAIT,
  'a one-shot sleep': 'def settle():\n    time.sleep(3)\n    return check()',
  'a sleep at module level': 'time.sleep(1)',
  'a counter-bounded while loop': 'def f():\n    n = 0\n    while n < 5:\n        n += 1\n        time.sleep(1)',
  'a sleep in a for-in loop over a list': 'for host in hosts:\n    ping(host)\n    time.sleep(2)',
  'a Timer that calls a different function': 'def start():\n    threading.Timer(5, other).start()',
  'a bare Timer without the threading import': 'def tick():\n    Timer(5, tick).start()',
  'a wait with no timeout': 'def run(stop):\n    while True:\n        stop.wait()',
  'a wait with a timeout outside any loop': 'def run(ev):\n    ev.wait(5)',
  'while True named in a comment': 'def f():\n    # while True:\n    time.sleep(1)',
  'while True inside a docstring': 'def f():\n    """\n    while True:\n        time.sleep(1)\n    """\n    return 1',
  'a while True in a sibling function (scope ends at def)': 'def a():\n    while True:\n        work()\n\ndef b():\n    time.sleep(1)',
};
for (const [name, text] of Object.entries(NEGATIVE)) {
  test(`silent on ${name}`, () => {
    assert.deepStrictEqual(kinds(text), [], `unexpected finding(s) on: ${text}`);
  });
}

test('a sleep inside try inside an unbounded loop is still found; asyncio.sleep and await asyncio.sleep too; a one-line loop too', () => {
  assert.deepStrictEqual(kinds('def f():\n    while 1:\n        try:\n            go()\n        except E:\n            pass\n        time.sleep(5)'), ['sleep-loop:7']);
  assert.deepStrictEqual(kinds('async def f():\n    while True:\n        await asyncio.sleep(5)'), ['sleep-loop:3']);
  assert.deepStrictEqual(kinds('while True: time.sleep(1)'), ['sleep-loop:1']);
});

test('the NEAREST enclosing loop decides: a range-bounded loop inside while True is not reported', () => {
  assert.deepStrictEqual(kinds('def f():\n    while True:\n        for i in range(3):\n            time.sleep(1)'), []);
});

test('the search stops at an enclosing def: a function defined inside a loop is not "in" the loop', () => {
  assert.deepStrictEqual(kinds('while True:\n    def helper():\n        time.sleep(1)\n    helper()'), []);
});

test('a loop header at the SAME indentation as the sleep does not enclose it', () => {
  assert.deepStrictEqual(kinds('while True:\n    pass\ntime.sleep(1)'), []);
});

test('comments and string literals are blanked: sleep and schedule inside them are not code', () => {
  assert.deepStrictEqual(kinds('while True:\n    work()  # time.sleep(5)'), []);
  assert.deepStrictEqual(kinds('while True:\n    log("time.sleep(5)")'), []);
  assert.deepStrictEqual(kinds('# schedule.every(5).minutes.do(job)'), []);
  assert.deepStrictEqual(kinds('x = "schedule.every(5)"'), []);
});

test('code after a multi-line docstring is scanned again (the docstring ends)', () => {
  assert.deepStrictEqual(kinds('"""\nnote\n"""\nwhile True:\n    time.sleep(1)'), ['sleep-loop:5']);
});

test('a tab counts as 8 columns of indentation', () => {
  assert.deepStrictEqual(kinds('  while True:\n\ttime.sleep(1)'), ['sleep-loop:2']);
});

test('a Timer imported from threading is recognised as a re-arming timer', () => {
  assert.deepStrictEqual(kinds('from threading import Timer\n\ndef tick():\n    Timer(5, tick).start()'), ['timer-rearm:4']);
  assert.deepStrictEqual(kinds('class W:\n    def tick(self):\n        threading.Timer(5, self.tick).start()'), ['timer-rearm:3']);
});

test('test paths are skipped by default and scanned with includeTests', () => {
  const text = POSITIVE['sleep-loop'];
  assert.deepStrictEqual(scan(text, 'tests/test_a.py'), []);
  assert.deepStrictEqual(scan(text, 'dashboard/foo_test.py'), []);
  assert.deepStrictEqual(scan(text, 'tests/test_a.py', { includeTests: true }).map((f) => f.kind), ['sleep-loop']);
});

test('an annotated finding (# poll-ok: <reason> above the sleep) comes back annotated; an empty reason does not', () => {
  const noted = scan('def f():\n    while True:\n        # poll-ok: no event exists for the chat idle timeout\n        time.sleep(60)');
  assert.strictEqual(noted.length, 1);
  assert.strictEqual(noted[0].annotated, true);
  assert.strictEqual(noted[0].reason, 'no event exists for the chat idle timeout');
  const empty = scan('def f():\n    while True:\n        # poll-ok:\n        time.sleep(60)');
  assert.strictEqual(empty[0].annotated, false);
});

test('findings carry the snippet and the 1-based line', () => {
  const [f] = scan('import time\n\nschedule.every(3).seconds.do(x)');
  assert.strictEqual(f.line, 3);
  assert.strictEqual(f.snippet, 'schedule.every(3).seconds.do(x)');
  assert.strictEqual(f.language, 'py');
});

test('the default loader finds the py table next to the js table', () => {
  const found = scanText({ language: 'py', path: 'x.py', text: POSITIVE['sleep-loop'] });
  assert.deepStrictEqual(found.map((f) => f.kind), ['sleep-loop']);
});
