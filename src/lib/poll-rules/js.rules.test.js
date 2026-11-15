'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scanText } = require('../poll-detector.js');
const table = require('./js.rules.js');

const kindsIn = (text, file = 'x.js') => scanText({ language: 'js', path: file, text, tables: [table] }).map((f) => `${f.kind}:${f.line}`);

// One positive example per rule kind. REAL = a line copied from a pooled repo (file:line cited); SYNTHETIC = written for this test.
const POSITIVE = {
  // REAL python/dashboard/static/js/brain-dump-and-second-brain.js:1015
  'set-interval': '  brainDumpEntriesInterval = setInterval(refreshBrainDumpEntries, 5000);',
  // SYNTHETIC
  'self-rearming-timeout': 'function tick() {\n  doWork();\n  setTimeout(tick, 5000);\n}',
  // SYNTHETIC
  'sleep-loop': 'async function run() {\n  while (true) {\n    await check();\n    await sleep(1000);\n  }\n}',
  // SYNTHETIC
  'listing-in-tick': 'function scan() {\n  const names = fs.readdirSync(dir);\n}\nsetInterval(scan, 1000);',
};

test('the table has exactly the four contract kinds, all severity poll', () => {
  assert.deepStrictEqual(table.rules.map((r) => r.kind).sort(), Object.keys(POSITIVE).sort());
  assert.ok(table.rules.every((r) => r.severity === 'poll'));
  assert.deepStrictEqual(table.languages, ['js']);
});

for (const [kind, text] of Object.entries(POSITIVE)) {
  test(`rule ${kind} fires on its positive example (and the table without it would not)`, () => {
    assert.ok(kindsIn(text).some((k) => k.startsWith(`${kind}:`)), `${kind} did not fire on: ${text}`);
    const without = { languages: table.languages, rules: table.rules.filter((r) => r.kind !== kind) };
    assert.ok(!scanText({ language: 'js', path: 'x.js', text, tables: [without] }).some((f) => f.kind === kind));
  });
}

test('real production example: the branches tab poll timer (python/dashboard/static/js/branches-joblist-hardware-tabs.js:219)', () => {
  assert.deepStrictEqual(kindsIn('  branchesPollTimer = setInterval(refreshBranchesTab, 15000);'), ['set-interval:1']);
});

test('real test-file example gives nothing by default and set-interval with includeTests (agent-manager-pipeline-ops src/branch-hold.test.js:65)', () => {
  const text = '  const keepAlive = setInterval(() => {}, 1000);      // AbortSignal.timeout does not keep the event loop alive';
  assert.deepStrictEqual(scanText({ language: 'js', path: 'src/branch-hold.test.js', text, tables: [table] }), []);
  assert.deepStrictEqual(scanText({ language: 'js', path: 'src/branch-hold.test.js', text, tables: [table], includeTests: true }).map((f) => f.kind), ['set-interval']);
});

test('self-rearming-timeout also sees the arrow form and a const-arrow function', () => {
  assert.deepStrictEqual(kindsIn('const poll = async () => {\n  await load();\n  setTimeout(() => poll(), 3000);\n};'), ['self-rearming-timeout:3']);
});

test('sleep-loop also sees a braceless body, an inline loop and the Promise form', () => {
  assert.deepStrictEqual(kindsIn('for (;;)\n  await delay(500);'), ['sleep-loop:2']);
  assert.deepStrictEqual(kindsIn('while (true) await sleep(10);'), ['sleep-loop:1']);
  assert.deepStrictEqual(kindsIn('while (1) {\n  await new Promise(r => setTimeout(r, 200));\n}'), ['sleep-loop:2']);
});

test('listing-in-tick sees git fetch inside a setInterval callback', () => {
  assert.deepStrictEqual(kindsIn('setInterval(() => {\n  execFileSync("git", ["fetch", "origin"]);\n}, 9000);'), ['set-interval:1', 'listing-in-tick:2']);
});

const NEGATIVE = {
  'a one-shot setTimeout (debounce)': 'input.onchange = () => { clearTimeout(t); t = setTimeout(save, 300); };',
  'a one-shot setTimeout that is not its own function': 'function save() { x(); }\nfunction go() { setTimeout(save, 300); }',
  'a bounded retry loop that sleeps': 'for (let i = 0; i < 5; i++) {\n  await sleep(1000);\n}',
  'a sleep outside any loop': 'async function once() {\n  await sleep(1000);\n  done();\n}',
  'setInterval named in a line comment': '// setInterval(tick, 1000) was removed',
  'setInterval named in a block comment': '/* old: setInterval(tick, 1000)\n   still here */',
  'setInterval inside a string literal': 'const s = "setInterval(tick, 1000)";',
  'a directory listing that no timer schedules': 'function once() {\n  return fs.readdirSync(dir);\n}',
  'a readdir mention in a comment inside a scheduled function': 'function scan() {\n  // fs.readdirSync(dir)\n}\nsetInterval(scan, 1000);',
  'a while (cond) loop that sleeps': 'while (!done) {\n  await sleep(100);\n}',
};
for (const [name, text] of Object.entries(NEGATIVE)) {
  test(`silent on ${name}`, () => {
    const found = kindsIn(text).filter((k) => !(name.includes('scheduled function') && k.startsWith('set-interval')));
    assert.deepStrictEqual(found, [], `unexpected finding(s) on: ${text}`);
  });
}

test('findings carry the snippet of the offending line', () => {
  const [f] = scanText({ language: 'js', path: 'x.js', text: '\n\n  setInterval(a, 1);', tables: [table] });
  assert.strictEqual(f.line, 3);
  assert.strictEqual(f.snippet, 'setInterval(a, 1);');
});
