'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  buildNodeModuleExtraction,
  buildNodeModuleOnePassChanges,
  planIsFullyMechanicalNodeModule,
  topLevelBindingNames,
  locallyBoundNames,
  bindingNamesFromPattern,
  firstRuntimeError,
  splitRequirePrelude,
} = require('./decompose-node-module.js');

const SRC = [
  "'use strict';",
  '',
  '// A module with a require prelude, a shared helper, a self-contained cluster,',
  '// a module.exports block, and a CLI tail that calls a moved function.',
  "const fs = require('fs');",
  "const path = require('path');",
  "const { inspect } = require('util');",
  '',
  'const ROOT = process.cwd();',
  '',
  'function fmt(n) {',
  '  return `${n.toFixed(2)}`;',
  '}',
  '',
  'function readThing(name) {',
  '  return fs.readFileSync(path.resolve(name), "utf8");',
  '}',
  '',
  'function computeA(xs) {',
  '  const total = xs.reduce((s, x) => s + x, 0);',
  '  return { total, dump: inspect(xs) };',
  '}',
  '',
  'function computeB(xs) {',
  '  return computeA(xs).total * 2;',
  '}',
  '',
  'function summarize(xs) {',
  '  return `A=${computeA(xs).total} B=${computeB(xs)} first=${readThing("x")}`;',
  '}',
  '',
  'module.exports = { fmt, readThing, computeA, computeB, summarize, ROOT };',
  '',
  'if (require.main === module) {',
  '  console.log(computeB([1, 2, 3]));',
  '}',
  '',
].join('\n');

test('splitRequirePrelude: prelude is the top require cluster; body starts at the first real code', () => {
  const { prelude, body } = splitRequirePrelude(SRC);
  assert.match(prelude, /require\('util'\)/);
  assert.doesNotMatch(prelude, /function fmt/);
  assert.doesNotMatch(prelude, /const ROOT/); // a non-require const == real code, ends the prelude
  assert.match(body, /^\s*const ROOT = process\.cwd\(\)/);
});

test('splitRequirePrelude: a require() that sits AFTER real code is NOT swallowed into the prelude', () => {
  const src = [
    "'use strict';",
    "const fs = require('fs');",
    '',
    'const CONST_A = 1;',
    '',
    'function early() { return CONST_A; }',
    '',
    '// lazy import, deliberately mid-file',
    "const { helper } = require('./util-helper.js');",
    '',
    'function late() { return helper(); }',
    '',
    'module.exports = { early, late };',
    '',
  ].join('\n');
  const { prelude, body } = splitRequirePrelude(src);
  assert.match(prelude, /require\('fs'\)/);
  assert.doesNotMatch(prelude, /util-helper/); // the mid-file require stays in the body
  assert.doesNotMatch(prelude, /const CONST_A/);
  assert.match(body, /^\s*const CONST_A = 1;/);
});

test('buildNodeModuleExtraction: a moved fn that uses a MID-FILE require binding still resolves (whole-source require scan)', () => {
  const src = [
    "'use strict';",
    "const fs = require('fs');",
    '',
    'function unrelated() { return fs.existsSync("x"); }',
    '',
    "const { transform } = require('./transform.js');", // mid-file, after real code
    '',
    'function usesTransform(x) { return transform(x) + 1; }',
    '',
    'module.exports = { unrelated, usesTransform };',
    '',
  ].join('\n');
  const r = buildNodeModuleExtraction(src, 'src/m.js', 'src/m-transform.js', ['usesTransform']);
  assert.equal(r.ok, true, r.ok ? '' : r.reason); // `transform` is require-bound, not an external module-scope ref
  assert.match(r.changes[0].content, /require\('\.\/transform\.js'\)/); // and the new module gets that require
});

test('firstNodeCheckError: null for a parseable change set, a `<file>: <error>` string for a broken one', () => {
  const { firstNodeCheckError } = require('./decompose-node-module.js');
  assert.equal(firstNodeCheckError([
    { mode: 'create', file: 'src/ok.js', content: "'use strict';\nfunction a() { return 1; }\nmodule.exports = { a };\n" },
    { mode: 'edit', file: 'src/src.js', find: 'x', replace: "'use strict';\nconst { a } = require('./ok.js');\nmodule.exports = { a };\n" },
  ]), null);
  const err = firstNodeCheckError([
    { mode: 'create', file: 'src/bad.js', content: "'use strict';\nfunction a( { return 1; }\n" }, // syntax error
  ]);
  assert.ok(err && err.startsWith('src/bad.js: '), err);
  assert.match(err, /SyntaxError|Error/);
});

test('buildNodeModuleOnePassChanges: the node --check guard runs on a real plan (stays ok)', () => {
  const good = buildNodeModuleOnePassChanges(SRC, 'src/thing.js', [{ newFile: 'src/thing-c.js', symbols: ['computeA', 'computeB'] }]);
  assert.equal(good.ok, true, good.ok ? '' : good.reason);
});

test('topLevelBindingNames: functions, consts, and destructured requires; column-0 only', () => {
  const names = topLevelBindingNames(SRC);
  for (const n of ['fs', 'path', 'inspect', 'ROOT', 'fmt', 'readThing', 'computeA', 'computeB', 'summarize']) {
    assert.ok(names.has(n), `expected ${n}`);
  }
  assert.ok(!names.has('total'), 'a local inside a function body is not top-level');
});

test('buildNodeModuleExtraction: a self-contained cluster (computeA+computeB) extracts cleanly', () => {
  const r = buildNodeModuleExtraction(SRC, 'src/thing.js', 'src/thing-compute.js', ['computeA', 'computeB']);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.equal(r.changes.length, 2);

  const [create, edit] = r.changes;
  assert.equal(create.mode, 'create');
  assert.equal(create.file, 'src/thing-compute.js');
  // new file: use strict + the require prelude it needs + both fns + an exports line
  assert.match(create.content, /^'use strict';/);
  assert.match(create.content, /require\('util'\)/);           // inspect is used by computeA
  assert.match(create.content, /function computeA/);
  assert.match(create.content, /function computeB/);
  assert.match(create.content, /module\.exports = \{ computeA, computeB \};/);

  // reduced source: fns gone, back-require added, module.exports UNCHANGED, CLI tail intact
  assert.equal(edit.mode, 'edit');
  assert.equal(edit.find, SRC);
  assert.doesNotMatch(edit.replace, /function computeA/);
  assert.doesNotMatch(edit.replace, /function computeB/);
  assert.match(edit.replace, /const \{ computeA, computeB \} = require\('\.\/thing-compute\.js'\);/);
  assert.match(edit.replace, /module\.exports = \{ fmt, readThing, computeA, computeB, summarize, ROOT \};/);
  assert.match(edit.replace, /if \(require\.main === module\) \{/);
  assert.match(edit.replace, /function summarize/); // summarize stays and still calls computeA/computeB (now imported)
});

test('buildNodeModuleExtraction: new file + reduced source both parse as scripts (vm oracle)', () => {
  const r = buildNodeModuleExtraction(SRC, 'src/thing.js', 'src/thing-compute.js', ['computeA', 'computeB']);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.doesNotThrow(() => new vm.Script(r.newContent, { filename: 'thing-compute.js' }));
  assert.doesNotThrow(() => new vm.Script(r.reduced, { filename: 'thing.js' }));
});

test('buildNodeModuleExtraction: BLOCKS a non-self-contained move (summarize calls non-moved computeA/computeB/readThing)', () => {
  const r = buildNodeModuleExtraction(SRC, 'src/thing.js', 'src/thing-sum.js', ['summarize']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a self-contained move/);
  assert.deepEqual(r.externalRefs, ['computeA', 'computeB', 'readThing']);
});

test('buildNodeModuleExtraction: a move that DROPS the dependency in with it is fine (summarize + its deps)', () => {
  const r = buildNodeModuleExtraction(SRC, 'src/thing.js', 'src/thing-sum.js', ['summarize', 'computeA', 'computeB', 'readThing']);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.match(r.changes[0].content, /module\.exports = \{ summarize, computeA, computeB, readThing \};/);
  assert.match(r.changes[1].replace, /const \{ summarize, computeA, computeB, readThing \} = require\('\.\/thing-sum\.js'\);/);
});

test('buildNodeModuleExtraction: bails when a symbol is not a top-level function declaration', () => {
  const r = buildNodeModuleExtraction(SRC, 'src/thing.js', 'src/x.js', ['computeA', 'ROOT']); // ROOT is a const, not a fn
  assert.equal(r.ok, false);
  assert.match(r.reason, /resolve|ROOT/i);
});

test('buildNodeModuleExtraction: rejects a non-.js source or target', () => {
  assert.equal(buildNodeModuleExtraction(SRC, 'src/app.py', 'src/x.js', ['computeA']).ok, false);
  assert.equal(buildNodeModuleExtraction(SRC, 'src/thing.js', 'src/x.py', ['computeA']).ok, false);
  assert.equal(buildNodeModuleExtraction(SRC, 'src/thing.js', 'src/x.js', []).ok, false);
});

test('buildNodeModuleExtraction: a local var sharing a name with a source binding does NOT trip the self-containment check', () => {
  const src = [
    "'use strict';",
    "const fs = require('fs');",
    'const cache = new Map();',
    '',
    'function usesCache() { return cache.get("k"); }',
    '',
    'function independent(xs) {',
    '  const cache = xs.slice();', // shadows the module-scope `cache`
    '  return cache.length;',
    '}',
    '',
    'module.exports = { usesCache, independent };',
    '',
  ].join('\n');
  const r = buildNodeModuleExtraction(src, 'src/m.js', 'src/m-independent.js', ['independent']);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
});

test('planIsFullyMechanicalNodeModule: needs a .js source and every move nodeModuleApplyOk', () => {
  const req = { sourceFile: 'src/a.js', moves: [{ kind: 'module-extract' }, { kind: 'module-extract' }] };
  const okVal = { moveMeta: [{ nodeModuleApplyOk: true }, { nodeModuleApplyOk: true }] };
  assert.equal(planIsFullyMechanicalNodeModule(req, okVal), true);
  assert.equal(planIsFullyMechanicalNodeModule({ ...req, sourceFile: 'a/index.html' }, okVal), false);
  assert.equal(planIsFullyMechanicalNodeModule(req, { moveMeta: [{ nodeModuleApplyOk: true }, {}] }), false);
  const prev = process.env.AGENT_MANAGER_DECOMPOSE_NODE_MODULE;
  process.env.AGENT_MANAGER_DECOMPOSE_NODE_MODULE = 'false';
  try { assert.equal(planIsFullyMechanicalNodeModule(req, okVal), false); }
  finally { if (prev === undefined) delete process.env.AGENT_MANAGER_DECOMPOSE_NODE_MODULE; else process.env.AGENT_MANAGER_DECOMPOSE_NODE_MODULE = prev; }
});

test('buildNodeModuleOnePassChanges: two chained moves -> 2 creates + 1 edit, both back-requires in the source', () => {
  const r = buildNodeModuleOnePassChanges(SRC, 'src/thing.js', [
    { newFile: 'src/thing-compute.js', symbols: ['computeA', 'computeB'] },
    { newFile: 'src/thing-format.js', symbols: ['fmt'] },
  ]);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.deepEqual(r.changes.map((c) => [c.mode, c.file]), [
    ['create', 'src/thing-compute.js'],
    ['create', 'src/thing-format.js'],
    ['edit', 'src/thing.js'],
  ]);
  const edit = r.changes[2];
  assert.equal(edit.find, SRC);
  assert.match(edit.replace, /const \{ computeA, computeB \} = require\('\.\/thing-compute\.js'\);/);
  assert.match(edit.replace, /const \{ fmt \} = require\('\.\/thing-format\.js'\);/);
  assert.doesNotMatch(edit.replace, /function computeA/);
  assert.doesNotMatch(edit.replace, /^function fmt/m);
  // module.exports still lists everything, untouched
  assert.match(edit.replace, /module\.exports = \{ fmt, readThing, computeA, computeB, summarize, ROOT \};/);
  assert.doesNotThrow(() => new vm.Script(edit.replace));
  for (const c of r.changes.slice(0, 2)) assert.doesNotThrow(() => new vm.Script(c.content));
});

test('buildNodeModuleOnePassChanges: bails on the offending move when one is not self-contained', () => {
  const r = buildNodeModuleOnePassChanges(SRC, 'src/thing.js', [
    { newFile: 'src/thing-compute.js', symbols: ['computeA', 'computeB'] },
    { newFile: 'src/thing-sum.js', symbols: ['summarize'] }, // needs readThing (not moved)
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /thing-sum\.js.*not a self-contained move|readThing/);
});

test('buildNodeModuleOnePassChanges: new file drops the source prose header, keeps requires', () => {
  const src = [
    "'use strict';",
    '// This whole doc comment describes the SOURCE module and its history in great detail.',
    '// It should NOT be copied verbatim into every extracted slice.',
    "const fs = require('fs');",
    '',
    'function helper() { return fs.existsSync("x"); }',
    '',
    'module.exports = { helper };',
    '',
  ].join('\n');
  const r = buildNodeModuleOnePassChanges(src, 'src/s.js', [{ newFile: 'src/s-helper.js', symbols: ['helper'] }]);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  const created = r.changes[0].content;
  assert.match(created, /^'use strict';/);
  assert.match(created, /require\('fs'\)/);
  assert.doesNotMatch(created, /describes the SOURCE module/);
  assert.match(created, /extracted from src\/s\.js/);
});

test('locallyBoundNames: params, destructures, nested fns', () => {
  const names = locallyBoundNames('function f(a, b = 2, { c, d: e }) { const g = 1; let [h] = x; return a; }');
  for (const n of ['f', 'a', 'b', 'c', 'e', 'g', 'h']) assert.ok(names.has(n), `expected ${n}`);
});

test('locallyBoundNames: a param DEFAULT-VALUE expression is NOT treated as a local binding (2026-09-09 regression)', () => {
  const names = locallyBoundNames('function isStale(task, now, thresholdMs = stalenessThresholdMs()) { return lastActivityTs(task) < now - thresholdMs; }');
  assert.ok(names.has('task') && names.has('now') && names.has('thresholdMs') && names.has('isStale'));
  assert.ok(!names.has('stalenessThresholdMs'), 'the helper in the default value is a DEPENDENCY, not a local');
  assert.ok(!names.has('lastActivityTs'), 'a call in the body is a dependency');
});

test('locallyBoundNames: object-literal keys in a destructure are not bindings; nested defaults are excluded', () => {
  const names = locallyBoundNames('const { alpha, beta: b2, gamma = helper(), delta: { deep } = fallback() } = x;');
  for (const n of ['alpha', 'b2', 'gamma', 'deep']) assert.ok(names.has(n), `expected ${n}`);
  assert.ok(!names.has('beta'), 'beta is a key, b2 is the binding');
  assert.ok(!names.has('helper') && !names.has('fallback'), 'default-value calls are not bindings');
});

test('bindingNamesFromPattern: strips defaults + keys, keeps rest', () => {
  assert.deepEqual([...bindingNamesFromPattern('a = f()')], ['a']);
  assert.deepEqual([...bindingNamesFromPattern('...rest')], ['rest']);
  assert.deepEqual([...bindingNamesFromPattern('{ x, y: z }')].sort(), ['x', 'z']);
});

test('buildNodeModuleExtraction: BLOCKS a move whose fn needs a helper only via a default param', () => {
  const src = [
    "'use strict';",
    "const fs = require('fs');",
    '',
    'function THRESH() { return 5; }',
    '',
    'function alpha(x, n = THRESH()) { return x + n; }',
    '',
    'function beta(x) { return alpha(x) * 2; }',
    '',
    'module.exports = { THRESH, alpha, beta };',
    '',
  ].join('\n');
  const r = buildNodeModuleExtraction(src, 'src/m.js', 'src/m-ab.js', ['alpha', 'beta']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a self-contained move.*THRESH/);
});

test('firstRuntimeError: null for a self-contained split that require()s + calls cleanly; catches a ReferenceError', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-test-'));
  const srcDir = path.join(repo, 'src');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'sib.js'), "module.exports = { two: () => 2 };\n");

  const goodChanges = [
    { mode: 'create', file: 'src/m-pure.js', content: "'use strict';\nfunction pure(x) { return x + 1; }\nmodule.exports = { pure };\n" },
    { mode: 'edit', file: 'src/m.js', find: 'x', replace: "'use strict';\nconst { two } = require('./sib.js');\nconst { pure } = require('./m-pure.js');\nfunction other() { return pure(two()); }\nmodule.exports = { pure, other };\n" },
  ];
  assert.equal(firstRuntimeError(goodChanges, 'src/m.js', repo), null);

  // broken: a moved fn references a name that no longer exists once relocated
  const badChanges = [
    { mode: 'create', file: 'src/m-pure.js', content: "'use strict';\nfunction pure(x) { return x + GONE; }\nmodule.exports = { pure };\n" },
    { mode: 'edit', file: 'src/m.js', find: 'x', replace: "'use strict';\nconst { pure } = require('./m-pure.js');\nmodule.exports = { pure };\n" },
  ];
  const err = firstRuntimeError(badChanges, 'src/m.js', repo);
  assert.ok(err && /GONE|not defined|ReferenceError/.test(err), String(err));
});
