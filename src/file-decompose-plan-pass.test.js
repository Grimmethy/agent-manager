'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('./file-decompose-plan-pass.js');
const { extractTopLevelSymbols, assignSections, groupBySection, planFromSections, planFromSectionMerge, parseMovesJson, bannerLabel, routeFamily, runFileDecomposePlanPass } = M;

test('extractTopLevelSymbols: python + html <script> functions, nested excluded', () => {
  const py = 'def a(x):\n    return x\n@app.route("/x")\ndef b():\n    pass\nclass C:\n    def m(self):\n        pass\n';
  assert.deepEqual(extractTopLevelSymbols(py, '.py').map((s) => s.name), ['a', 'b', 'C']);
  const html = '<script>\nfunction f1(){}\n  function f2(){}\n        function nested(){}\n</script>\nfunction outside(){}\n';
  assert.deepEqual(extractTopLevelSymbols(html, '.html').map((s) => s.name), ['f1', 'f2']);
});

test('bannerLabel: only explicit dividers, never JSDoc prose', () => {
  assert.equal(bannerLabel('// --- Discovery tab ---'), 'Discovery tab');
  assert.equal(bannerLabel('# === LAN access ==='), 'LAN access');
  assert.equal(bannerLabel('// Combined view across every saved run -- no perf table'), null);
  assert.equal(bannerLabel('// Which worker lane the Workers tab shows'), null);
});

test('routeFamily: reads the @app.route URL prefix above a def', () => {
  const lines = ['@app.route("/api/reports/<x>")', 'def api_report_detail(x):', '    pass'];
  assert.equal(routeFamily(lines, 1), 'reports');
});

test('assignSections: anchor functions cluster the symbols after them', () => {
  const html = [
    '<script>',
    'function renderJobListTab(){}',
    'function jobRowHelper(){}',
    'function severityForTab(){}',
    'function renderWorkersTab(){}',
    'function workerCard(){}',
    '</script>',
  ].join('\n');
  const syms = assignSections(html, '.html', extractTopLevelSymbols(html, '.html'));
  const byName = Object.fromEntries(syms.map((s) => [s.name, s.section]));
  assert.equal(byName.jobRowHelper, 'job-list');
  assert.equal(byName.severityForTab, 'job-list');
  assert.equal(byName.workerCard, 'workers');
});

test('planFromSections: emits balanced section modules, rejects a too-coarse split', () => {
  // clean: 4 sections of 3 each
  const clean = [];
  for (const sec of ['aaa', 'bbb', 'ccc', 'ddd']) {
    for (let i = 0; i < 3; i += 1) clean.push({ name: `${sec}${i}`, line: clean.length + 1, kind: 'fn', section: sec });
  }
  const moves = planFromSections('x/index.html', clean);
  assert.equal(moves.length, 4);
  assert.ok(moves[0].newFile.endsWith('.js'));

  // too coarse: one section holds 40 of 45
  const coarse = [];
  for (let i = 0; i < 40; i += 1) coarse.push({ name: `big${i}`, line: i + 1, kind: 'fn', section: 'huge' });
  for (const s of ['x', 'y', 'z', 'w', 'v']) coarse.push({ name: s, line: coarse.length + 1, kind: 'fn', section: s });
  assert.equal(planFromSections('x/app.py', coarse), null);
});

test('planFromSectionMerge: expands the model\'s section labels back to symbols', () => {
  const groups = new Map([
    ['Alpha', [{ name: 'a1' }, { name: 'a2' }]],
    ['Beta', [{ name: 'b1' }]],
    ['Gamma', [{ name: 'g1' }, { name: 'g2' }]],
    ['', [{ name: 'orphan' }]],
  ]);
  const resp = JSON.stringify([
    { module: 'ab', sections: ['Alpha', 'Beta'], includeUnsectioned: true },
    { module: 'g', sections: ['Gamma'] },
  ]);
  const moves = planFromSectionMerge('x/index.html', groups, resp);
  assert.equal(moves.length, 2);
  assert.deepEqual(moves[0].symbols.sort(), ['a1', 'a2', 'b1', 'orphan']);
  assert.deepEqual(moves[1].symbols, ['g1', 'g2']);
});

test('planFromSectionMerge: a section the model forgot still becomes its own move', () => {
  const groups = new Map([['A', [{ name: 'a' }]], ['B', [{ name: 'b' }]], ['C', [{ name: 'c' }]]]);
  const moves = planFromSectionMerge('x.js', groups, JSON.stringify([
    { module: 'ab', sections: ['A', 'B'] },
    { module: 'x', sections: ['A'] }, // dup A, no C
  ]));
  // A+B merged, C recovered
  assert.ok(moves.some((m) => m.symbols.includes('c')));
  assert.ok(moves.some((m) => m.symbols.includes('a') && m.symbols.includes('b')));
});

test('parseMovesJson: fenced json, dedups claimed symbols, reports leftovers', () => {
  const r = parseMovesJson('```json\n[{"newFile":"lib/x.js","symbols":["a","b","ghost"]},{"newFile":"lib/y.js","symbols":["b","c"]}]\n```',
    { validSymbols: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(r.moves[0].symbols, ['a', 'b']);
  assert.deepEqual(r.moves[1].symbols, ['c']);
  assert.deepEqual(r.dropped, ['d']);
});

test('runFileDecomposePlanPass: Path A (deterministic) when the file has clean dividers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const parts = [];
  for (const sec of ['Alpha zone', 'Beta zone', 'Gamma zone', 'Delta zone']) {
    parts.push(`// --- ${sec} ---`);
    for (let i = 0; i < 3; i += 1) parts.push(`function ${sec.split(' ')[0].toLowerCase()}${i}() { return ${i}; }`);
  }
  fs.writeFileSync(path.join(dir, 'x.js'), parts.join('\n'));
  let called = false;
  const plan = await runFileDecomposePlanPass('x.js', { repoRoot: dir, call: async () => { called = true; return { response: '[]' }; } });
  assert.ok(plan);
  assert.equal(called, false, 'deterministic path takes no model call');
  assert.equal(plan.moves.length, 4);
  assert.match(plan.planPassNote, /deterministic/);
});

test('runFileDecomposePlanPass: Path B (model merges sections) for a many-section file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const parts = ['<script>'];
  for (let s = 0; s < 12; s += 1) {
    parts.push(`// --- Section ${s} ---`);
    for (let i = 0; i < 3; i += 1) parts.push(`function s${s}f${i}() {}`);
  }
  parts.push('</script>');
  fs.writeFileSync(path.join(dir, 'index.html'), parts.join('\n'));
  const call = async ({ prompt }) => {
    const secs = [...prompt.matchAll(/^  "(.+?)" -- /gm)].map((m) => m[1]);
    const mods = [[], [], []];
    secs.forEach((x, i) => mods[i % 3].push(x));
    return { response: JSON.stringify(mods.map((sc, i) => ({ module: `m${i}`, sections: sc }))) };
  };
  const plan = await runFileDecomposePlanPass('index.html', { repoRoot: dir, call });
  assert.ok(plan);
  assert.equal(plan.moves.length, 3);
  assert.match(plan.planPassNote, /merged sections/);
  const total = plan.moves.reduce((n, m) => n + m.symbols.length, 0);
  assert.equal(total, 36);
});

test('runFileDecomposePlanPass: null when nothing produces >=2 groups', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  fs.writeFileSync(path.join(dir, 'flat.js'), Array.from({ length: 10 }, (_, i) => `function f${i}(){}`).join('\n'));
  const plan = await runFileDecomposePlanPass('flat.js', { repoRoot: dir, call: async () => ({ response: JSON.stringify([{ newFile: 'lib/all.js', symbols: Array.from({ length: 10 }, (_, i) => `f${i}`) }]) }) });
  assert.equal(plan, null);
});
