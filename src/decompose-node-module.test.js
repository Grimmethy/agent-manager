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

test('topLevelBindingNames: members of a MULTI-LINE destructured require are top-level bindings', () => {
  const src = [
    "'use strict';",
    "const fs = require('fs');",
    'const {',
    '  parseThing,',
    '  ROUTE_TABLE,',
    '  deriveName,',
    "} = require('./helpers.js');",
    '',
    'function use() { return parseThing(ROUTE_TABLE); }',
    '',
    'module.exports = { use };',
    '',
  ].join('\n');
  const names = topLevelBindingNames(src);
  for (const n of ['fs', 'parseThing', 'ROUTE_TABLE', 'deriveName', 'use']) {
    assert.ok(names.has(n), `expected ${n}`);
  }
});

test('allTopLevelRequireStatements + carry: a MULTI-LINE destructured require reached only via spread is carried', () => {
  const { allTopLevelRequireStatements } = require('./decompose-node-module.js');
  const src = [
    "'use strict';",
    "const fs = require('fs');",
    'const {',
    '  listMonths,',
    "} = require('./archive.js');",
    '',
    'function scan(dir) {',
    '  return [',
    '    ...listMonths(dir).map((d) => ({ d })),',
    '  ];',
    '}',
    '',
    'function other() { return fs.readdirSync("."); }',
    '',
    'module.exports = { scan, other };',
    '',
  ].join('\n');
  const all = allTopLevelRequireStatements(src);
  assert.ok(all.some((l) => /archive\.js/.test(l) && /listMonths/.test(l)), 'multi-line require captured');

  // and the extraction carries it into the new module (spread read must count)
  const r = buildNodeModuleExtraction(src, 'src/m.js', 'src/m-scan.js', ['scan']);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.match(r.changes[0].content, /require\('\.\/archive\.js'\)/);
  assert.match(r.changes[0].content, /listMonths/);
});

test('referencedIdentifiers via spread: `...name(x)` reads `name` (not treated as member access)', () => {
  const { referencedIdentifiers } = require('./decompose-node-module.js');
  const refs = referencedIdentifiers('const y = [ ...expand(a), b.c ]; f(...rest);');
  assert.ok(refs.has('expand'), 'spread callee is a read');
  assert.ok(refs.has('rest'), 'spread of a plain identifier is a read');
  assert.ok(!refs.has('c'), 'a genuine member access is still not a read');
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

test('buildNodeModuleExtraction: relocates a plain top-level const requested alongside a function', () => {
  // ROOT is `const ROOT = process.cwd();` -- a simple, self-contained declaration
  // (process is a JS global). It rides with computeA verbatim.
  const r = buildNodeModuleExtraction(SRC, 'src/thing.js', 'src/x.js', ['computeA', 'ROOT']);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.match(r.changes[0].content, /const ROOT = process\.cwd\(\);/);
  assert.match(r.changes[0].content, /module\.exports = \{ computeA, ROOT \};/);
  // removed from the source; back-require covers it
  assert.doesNotMatch(r.changes[1].replace, /^const ROOT = process\.cwd\(\)/m);
  assert.match(r.changes[1].replace, /const \{ computeA, ROOT \} = require\('\.\/x\.js'\);/);
});

test('buildNodeModuleExtraction: a fn cluster carries the module const it reads (self-containment passes)', () => {
  const src = [
    "'use strict';",
    "const path = require('path');",
    '',
    'const LIMIT_MS = 5000;',
    'const TABLE = { a: 1, b: 2 };',
    '',
    'function isSlow(ms) { return ms > LIMIT_MS; }',
    '',
    'function lookup(k) { return TABLE[k] || 0; }',
    '',
    'function untouched() { return path.sep; }',
    '',
    'module.exports = { isSlow, lookup, untouched, LIMIT_MS, TABLE };',
    '',
  ].join('\n');
  const r = buildNodeModuleExtraction(src, 'src/m.js', 'src/m-timing.js', ['isSlow', 'lookup', 'LIMIT_MS', 'TABLE']);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.match(r.changes[0].content, /const LIMIT_MS = 5000;/);
  assert.match(r.changes[0].content, /const TABLE = \{ a: 1, b: 2 \};/);
  assert.match(r.changes[0].content, /module\.exports = \{ isSlow, lookup, LIMIT_MS, TABLE \};/);
  // source keeps `untouched`, loses the consts + moved fns, gains one back-require
  assert.match(r.changes[1].replace, /function untouched\(\)/);
  assert.doesNotMatch(r.changes[1].replace, /^const LIMIT_MS = 5000;/m);
  assert.match(r.changes[1].replace, /const \{ isSlow, lookup, LIMIT_MS, TABLE \} = require\('\.\/m-timing\.js'\);/);
});

test('buildNodeModuleExtraction: bails when a symbol is neither a top-level function nor a simple const', () => {
  const r = buildNodeModuleExtraction(SRC, 'src/thing.js', 'src/x.js', ['computeA', 'nonexistentThing']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /nonexistentThing|top-level function or simple const/i);
});

test('buildNodeModuleExtraction: a relocated const whose RHS reads a non-moved module fn is rejected', () => {
  const src = [
    "'use strict';",
    "const fs = require('fs');",
    '',
    'function helperConst() { return 7; }',
    '',
    'const DERIVED = helperConst();', // RHS calls a module fn NOT in the moved set
    '',
    'function useDerived() { return DERIVED + 1; }',
    '',
    'module.exports = { helperConst, useDerived, DERIVED };',
    '',
  ].join('\n');
  const r = buildNodeModuleExtraction(src, 'src/m.js', 'src/m-x.js', ['useDerived', 'DERIVED']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /helperConst|self-contained/i);
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

// 2026-09-14, screaminggoatclubmt: "fix the runtime probe bug too" -- found live against
// task-sources.js's REAL exports: nextDeepDiveTask spawns real python3 subprocesses
// against real external repo clones as a side effect of being called with zero args
// (this pipeline's own dominant `next<X>Task()` task-source shape, which the risky-name
// denylist never anticipated) -- the probe hit its timeout mid-spawn and the generic
// fallback mislabeled that as "module failed to load". `next` is now in the denylist, so
// this never gets called at all; the export just goes unverified by this pass, same as
// any other risky-named export already does (verified some other way, or trusted).
test('firstRuntimeError: never calls a `next*` export (task-source poller shape) -- would misreport a slow/side-effecting call as a runtime error otherwise', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-next-test-'));
  fs.mkdirSync(path.join(repo, 'src'));
  const changes = [
    {
      mode: 'edit',
      file: 'src/m.js',
      find: 'x',
      // Would hang for 30s (past any sane probe timeout) if actually called -- proves the
      // risky-name skip, not merely a fast synchronous throw, is what prevents the false
      // positive here.
      replace: "'use strict';\nfunction nextDeepDiveTask() { const start = Date.now(); while (Date.now() - start < 30000) {} return null; }\nmodule.exports = { nextDeepDiveTask };\n",
    },
  ];
  assert.equal(firstRuntimeError(changes, 'src/m.js', repo), null);
});

// 2026-09-14, screaminggoatclubmt: "dig into the new bug too" -- found live against
// local-draft.js's own real exports: callImplementModel is `async function`. Calling
// `v()` on it never throws synchronously (an async function always returns a Promise),
// so the destructuring failure from a missing options argument became a REJECTED
// promise instead -- invisible to the `try{v()}catch` here, and the resulting unhandled
// rejection crashed the WHOLE probe process (exit code 1, no RTE/output), which the
// generic fallback then misreported as "module failed to load". Not name-pattern-
// specific like next*/onboard/clone: ANY async export with a required parameter hits
// this, no denylist entry can cover it -- needs the global unhandledRejection net.
test('firstRuntimeError: an async export whose destructured parameter throws does not crash the whole probe (the ORIGINAL false positive), and a genuine async ReferenceError is still caught', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-async-test-'));
  fs.mkdirSync(path.join(repo, 'src'));

  const benignChanges = [
    {
      mode: 'edit',
      file: 'src/m.js',
      find: 'x',
      replace: "'use strict';\nasync function callImplementModel(task, ctx, { recordModelCall, implPrompt }) {\n  return recordModelCall(implPrompt);\n}\nmodule.exports = { callImplementModel };\n",
    },
  ];
  assert.equal(firstRuntimeError(benignChanges, 'src/m.js', repo), null, 'calling with no args throws inside the async fn -- a rejected promise, not a real dropped dependency -- must not fail the probe');

  // A GENUINE dropped dependency inside an async export must still be caught, just via
  // the rejection path instead of a synchronous throw.
  const badChanges = [
    {
      mode: 'edit',
      file: 'src/m.js',
      find: 'x',
      replace: "'use strict';\nasync function callImplementModel() {\n  return GONE_ASYNC_DEPENDENCY;\n}\nmodule.exports = { callImplementModel };\n",
    },
  ];
  const err = firstRuntimeError(badChanges, 'src/m.js', repo);
  assert.ok(err && /GONE_ASYNC_DEPENDENCY|not defined|ReferenceError/.test(err), String(err));
});

// 2026-09-13 regression: a move whose newFile sits in a SUBDIRECTORY of sourceFile's own
// directory (e.g. sdk/candidate-fulfillment.js -> sdk/lib/candidate-lifecycle.js) used to
// carry every require() path -- both top-level and lazily called inside a moved function
// body -- over verbatim, and the back-require spliced into the reduced source always used
// a bare './<newBase>.js' with no subdirectory prefix. Both silently pointed at the wrong
// file the instant newFile's directory differed from sourceFile's. Root-caused live via
// src/sdk/candidate-fulfillment.js -> src/sdk/lib/candidate-lifecycle.js: `require('../config.js')`
// (correct from sdk/) copied unchanged into sdk/lib/ resolved to sdk/config.js, and
// firstRuntimeError's own tmp copy scope (sourceFile's directory only) couldn't have found
// the real target either way, since it never copies anything above that.
test('buildNodeModuleOnePassChanges: newFile a directory deeper than sourceFile -- top-level AND lazy require() paths get depth-corrected, back-require gets the subdirectory prefix', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-depth-test-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'config.js'), "module.exports = { getConfig: () => ({ ok: true }) };\n");
  fs.writeFileSync(path.join(repo, 'src', 'task-sources.js'), "module.exports = { helper: () => 'h' };\n");

  const src = [
    "'use strict';",
    "const { getConfig } = require('../config.js');",
    '',
    'function useConfig() {',
    "  const { helper } = require('../task-sources.js'); // lazy, inside the moved fn body",
    '  return getConfig().ok && helper();',
    '}',
    '',
    'module.exports = { useConfig };',
    '',
  ].join('\n');
  fs.mkdirSync(path.join(repo, 'src', 'sdk'), { recursive: true });

  const r = buildNodeModuleOnePassChanges(src, 'src/sdk/thing.js', [
    { newFile: 'src/sdk/lib/thing-use.js', symbols: ['useConfig'] },
  ], repo);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);

  const created = r.changes.find((c) => c.file === 'src/sdk/lib/thing-use.js').content;
  assert.match(created, /require\('\.\.\/\.\.\/config\.js'\)/, 'top-level require depth-corrected');
  assert.match(created, /require\('\.\.\/\.\.\/task-sources\.js'\)/, 'lazy in-body require depth-corrected too');
  assert.doesNotThrow(() => new vm.Script(created));

  const edit = r.changes.find((c) => c.mode === 'edit');
  assert.match(edit.replace, /require\('\.\/lib\/thing-use\.js'\)/, 'back-require carries the lib/ subdirectory prefix');
});
