'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractTopLevelSymbols, parseMovesJson, runFileDecomposePlanPass } = require('./file-decompose-plan-pass.js');

test('extractTopLevelSymbols: python module-level def / class / decorated route', () => {
  const py = [
    'import os',
    'def _helper(x):',
    '    return x',
    '@app.route("/api/thing")',
    'def api_thing():',
    '    return _helper(1)',
    'class Widget:',
    '    def method(self):  # nested -- must NOT be extracted',
    '        pass',
    'async def api_async():',
    '    pass',
  ].join('\n');
  const syms = extractTopLevelSymbols(py, '.py').map((s) => s.name);
  assert.deepEqual(syms, ['_helper', 'api_thing', 'Widget', 'api_async']);
});

test('extractTopLevelSymbols: functions inside a <script> block in an html template', () => {
  const html = [
    '<html><body>',
    '<script>',
    'function renderJobList() { return 1; }',
    '  function renderPipelineMap() {}',
    '        function deeplyNested() {}  // too indented -- skip',
    '</script>',
    'function notInScript() {}',
    '</body></html>',
  ].join('\n');
  const syms = extractTopLevelSymbols(html, '.html').map((s) => s.name);
  assert.deepEqual(syms, ['renderJobList', 'renderPipelineMap']);
});

test('parseMovesJson: keeps only valid, unclaimed symbols and reports the leftovers', () => {
  const validSymbols = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }];
  const response = '```json\n'
    + '[{"newFile":"lib/x.js","kind":"module-extract","symbols":["a","b","ghost"]},'
    + ' {"newFile":"lib/y.js","symbols":["b","c"]},'  // b already claimed -> only c
    + ' {"newFile":"lib/z.js","symbols":["nope"]}]'   // no valid -> dropped
    + '\n```';
  const { moves, dropped, problems } = parseMovesJson(response, { validSymbols, sourceFile: 'app.js' });
  assert.equal(moves.length, 2);
  assert.deepEqual(moves[0].symbols, ['a', 'b']);
  assert.deepEqual(moves[1].symbols, ['c']);
  assert.deepEqual(dropped, ['d']);
  assert.ok(problems.some((p) => /no valid unclaimed/.test(p)));
});

test('parseMovesJson: garbage response yields no moves, not a throw', () => {
  const r = parseMovesJson('the model rambled and produced no json', { validSymbols: ['a'], sourceFile: 'x.js' });
  assert.deepEqual(r.moves, []);
  assert.ok(r.problems.length);
});

test('runFileDecomposePlanPass: end to end with an injected model call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pass-'));
  const rel = 'templates/index.html';
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  const fns = Array.from({ length: 8 }, (_, i) => `function tab${i}() { return ${i}; }`);
  fs.writeFileSync(path.join(dir, rel), `<script>\n${fns.join('\n')}\n</script>\n`);

  const call = async () => ({
    response: JSON.stringify([
      { newFile: 'templates/static/js/tabs-a.js', kind: 'script-extract', symbols: ['tab0', 'tab1', 'tab2', 'tab3'], reason: 'first four tabs' },
      { newFile: 'templates/static/js/tabs-b.js', kind: 'script-extract', symbols: ['tab4', 'tab5', 'tab6', 'tab7'], reason: 'rest' },
    ]),
  });

  const plan = await runFileDecomposePlanPass(rel, { repoRoot: dir, call, requestId: 'autodecomp-x' });
  assert.equal(plan.id, 'autodecomp-x');
  assert.equal(plan.sourceFile, rel);
  assert.equal(plan.moves.length, 2);
  assert.equal(plan.autoAuthored, true);
  assert.deepEqual(plan.moves[0].symbols, ['tab0', 'tab1', 'tab2', 'tab3']);
});

test('runFileDecomposePlanPass: bails when the model only proposes one group (== do not split)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pass-'));
  fs.writeFileSync(path.join(dir, 'a.js'), Array.from({ length: 8 }, (_, i) => `function f${i}(){}`).join('\n'));
  const call = async () => ({ response: JSON.stringify([{ newFile: 'lib/all.js', symbols: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'] }]) });
  assert.equal(await runFileDecomposePlanPass('a.js', { repoRoot: dir, call }), null);
});

test('runFileDecomposePlanPass: bails when too few symbols to split mechanically', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pass-'));
  fs.writeFileSync(path.join(dir, 'small.js'), 'function only() {}\n');
  assert.equal(await runFileDecomposePlanPass('small.js', { repoRoot: dir, call: async () => ({ response: '[]' }) }), null);
});
