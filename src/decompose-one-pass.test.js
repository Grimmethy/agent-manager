'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOnePassGroupBChanges, spliceScriptTags, scriptTagFor, planIsFullyMechanicalHtml } = require('./decompose-one-pass.js');

const HTML = [
  '<html><head></head><body>',
  '  <div>page</div>',
  '  <script>',
  'function alpha(){ return 1; }',
  'function beta(){ return 2; }',
  'function gamma(){ return alpha() + beta(); }',
  'function keepMe(){ return 9; }',
  '  </script>',
  '  </body>',
  '</html>',
  '',
].join('\n');

test('buildOnePassGroupBChanges: extracts every module + reduces source + splices <script> tags', () => {
  const r = buildOnePassGroupBChanges(HTML, 'python/dashboard/templates/index.html', [
    { newFile: 'python/dashboard/static/js/ab.js', symbols: ['alpha', 'beta'] },
    { newFile: 'python/dashboard/static/js/g.js', symbols: ['gamma'] },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.changes.length, 3); // 2 creates + 1 edit
  assert.deepEqual(r.changes.slice(0, 2).map((c) => [c.mode, c.file]), [
    ['create', 'python/dashboard/static/js/ab.js'],
    ['create', 'python/dashboard/static/js/g.js'],
  ]);
  assert.match(r.changes[0].content, /function alpha\(\)/);
  assert.match(r.changes[0].content, /function beta\(\)/);
  assert.match(r.changes[1].content, /function gamma\(\)/);

  const edit = r.changes[2];
  assert.equal(edit.mode, 'edit');
  assert.equal(edit.find, HTML);
  assert.doesNotMatch(edit.replace, /function alpha/);
  assert.doesNotMatch(edit.replace, /function gamma/);
  assert.match(edit.replace, /function keepMe/);
  // tags spliced before </body>, in move order
  const abIdx = edit.replace.indexOf('js/ab.js');
  const gIdx = edit.replace.indexOf('js/g.js');
  const bodyIdx = edit.replace.indexOf('</body>');
  assert.ok(abIdx > 0 && gIdx > abIdx && bodyIdx > gIdx, 'both tags precede </body>, ab before g');
});

test('buildOnePassGroupBChanges: bails (ok:false + problems) when a symbol no longer resolves', () => {
  const r = buildOnePassGroupBChanges(HTML, 'x/index.html', [
    { newFile: 'a.js', symbols: ['alpha'] },
    { newFile: 'b.js', symbols: ['doesNotExist'] },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /doesNotExist/);
});

test('buildOnePassGroupBChanges: rejects a non-HTML source and a <2-move plan', () => {
  assert.equal(buildOnePassGroupBChanges('x', 'src/app.py', [{ newFile: 'a.js', symbols: ['x'] }, { newFile: 'b.js', symbols: ['y'] }]).ok, false);
  assert.equal(buildOnePassGroupBChanges(HTML, 'x/index.html', [{ newFile: 'a.js', symbols: ['alpha'] }]).ok, false);
});

test('spliceScriptTags: inserts a block before the final </body>, preserving indentation; appends when there is none', () => {
  const out = spliceScriptTags('  <body>\n  x\n  </body>\n', [{ newFile: 'p/q/one.js' }, { newFile: 'two.js' }]);
  assert.match(out, /<script src="\/static\/js\/one\.js"><\/script>\n<script src="\/static\/js\/two\.js"><\/script>\n  <\/body>/);
  const noBody = spliceScriptTags('just text', [{ newFile: 'one.js' }]);
  assert.match(noBody, /just text\n<script src="\/static\/js\/one\.js"><\/script>\n/);
});

test('scriptTagFor: basename only, /static/js/ path', () => {
  assert.equal(scriptTagFor('python/dashboard/static/js/core-ui.js'), '<script src="/static/js/core-ui.js"></script>');
});

test('planIsFullyMechanicalHtml: true only for an all-script-extract HTML plan with every move deterministicApplyOk', () => {
  const req = { sourceFile: 'a/index.html', moves: [{ kind: 'script-extract' }, { kind: 'script-extract' }] };
  const okVal = { moveMeta: [{ deterministicApplyOk: true }, { deterministicApplyOk: true }] };
  assert.equal(planIsFullyMechanicalHtml(req, okVal), true);
  assert.equal(planIsFullyMechanicalHtml({ ...req, sourceFile: 'a/app.py' }, okVal), false);
  assert.equal(planIsFullyMechanicalHtml({ ...req, moves: [{ kind: 'script-extract' }, { kind: 'module-extract' }] }, okVal), false);
  assert.equal(planIsFullyMechanicalHtml(req, { moveMeta: [{ deterministicApplyOk: true }, {}] }), false);
});

test('planIsFullyMechanicalHtml: AGENT_MANAGER_DECOMPOSE_ONE_PASS=false forces false', () => {
  const req = { sourceFile: 'a/index.html', moves: [{ kind: 'script-extract' }, { kind: 'script-extract' }] };
  const okVal = { moveMeta: [{ deterministicApplyOk: true }, { deterministicApplyOk: true }] };
  const prev = process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS;
  process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS = 'false';
  try { assert.equal(planIsFullyMechanicalHtml(req, okVal), false); }
  finally { if (prev === undefined) delete process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS; else process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS = prev; }
});
