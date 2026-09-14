'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('./file-decompose-plan-pass.js');
const {
  extractTopLevelSymbols, assignSections, groupBySection, planFromSections, planFromSectionMerge,
  parseMovesJson, bannerLabel, routeFamily, runFileDecomposePlanPass, computeFanOutSymbols,
  computeJsFanOutSymbols, computeRoutelessSections, computeAppHookSymbols, hasNonRouteAppHook, packSections,
} = M;

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
  // No templates/ segment in 'x/index.html' -- appRoot === dir, unchanged from before.
  assert.ok(moves[0].newFile.startsWith('x/static/js/'));

  // too coarse: one section holds 40 of 45
  const coarse = [];
  for (let i = 0; i < 40; i += 1) coarse.push({ name: `big${i}`, line: i + 1, kind: 'fn', section: 'huge' });
  for (const s of ['x', 'y', 'z', 'w', 'v']) coarse.push({ name: s, line: coarse.length + 1, kind: 'fn', section: s });
  assert.equal(planFromSections('x/app.py', coarse), null);
});

// 2026-09-09, root-caused live (file-decompose-hub-autodecomp-adhoc-add-job-stage-
// groups-...): an HTML source under a templates/ directory computed its target as
// dir/static/js/<slug>.js -- nested INSIDE templates/, which doesn't match Flask's real
// convention (static/ is a SIBLING of templates/) and didn't match where this exact
// decomposition's files actually landed once applied.
test('planFromSections: an HTML source under templates/ puts its target in the SIBLING static/js/, not nested inside templates/', () => {
  const clean = [];
  for (const sec of ['aaa', 'bbb', 'ccc', 'ddd']) {
    for (let i = 0; i < 3; i += 1) clean.push({ name: `${sec}${i}`, line: clean.length + 1, kind: 'fn', section: sec });
  }
  const moves = planFromSections('python/dashboard/templates/index.html', clean);
  assert.equal(moves.length, 4);
  for (const m of moves) {
    assert.ok(m.newFile.startsWith('python/dashboard/static/js/'), `expected python/dashboard/static/js/... got ${m.newFile}`);
    assert.doesNotMatch(m.newFile, /templates\/static/, 'must never nest static/ inside templates/');
  }
});

// 2026-09-08, Grimmethy: "Yes, please build it" -- a plain .js source now ALSO gets
// kind:'script-extract' (was 'module-extract', the one category with no deterministic
// apply path at all -- see script-extract.js's own header for the review-task.js
// incident this fixes). Same lib/ path convention module-extract already used.
test('planFromSections: a plain .js source gets kind:\'script-extract\' (deterministic-apply eligible), same lib/ path as module-extract used', () => {
  const clean = [];
  for (const sec of ['aaa', 'bbb', 'ccc', 'ddd']) {
    for (let i = 0; i < 3; i += 1) clean.push({ name: `${sec}${i}`, line: clean.length + 1, kind: 'fn', section: sec });
  }
  const moves = planFromSections('src/review-task.js', clean);
  assert.equal(moves.length, 4);
  for (const m of moves) {
    assert.equal(m.kind, 'script-extract');
    assert.match(m.newFile, /^src\/lib\/.+\.js$/);
  }
});

test('planFromSections: .mjs and .cjs sources also get kind:\'script-extract\'', () => {
  const clean = [];
  for (const sec of ['aaa', 'bbb', 'ccc', 'ddd']) {
    for (let i = 0; i < 3; i += 1) clean.push({ name: `${sec}${i}`, line: clean.length + 1, kind: 'fn', section: sec });
  }
  for (const ext of ['.mjs', '.cjs']) {
    const moves = planFromSections(`src/thing${ext}`, clean);
    assert.equal(moves.length, 4);
    for (const m of moves) assert.equal(m.kind, 'script-extract');
  }
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

// 2026-09-14: this used to be the "too many sections" trigger for Path B (12 sections,
// none oversized) -- Path A's packer now handles that shape deterministically (see the
// FAN-OUT FILTER / packSections header note), so a >8-section file with clean, small,
// self-contained sections no longer reaches the model at all.
test('runFileDecomposePlanPass: Path A now deterministically packs a many-section file (used to require Path B)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const parts = ['<script>'];
  for (let s = 0; s < 12; s += 1) {
    parts.push(`// --- Section ${s} ---`);
    for (let i = 0; i < 3; i += 1) parts.push(`function s${s}f${i}() {}`);
  }
  parts.push('</script>');
  fs.writeFileSync(path.join(dir, 'index.html'), parts.join('\n'));
  let called = false;
  const call = async () => { called = true; return { response: '[]' }; };
  const plan = await runFileDecomposePlanPass('index.html', { repoRoot: dir, call });
  assert.ok(plan);
  assert.equal(called, false, 'deterministic packer took no model call');
  assert.ok(plan.moves.length <= 8, 'packed down to the module ceiling');
  assert.match(plan.planPassNote, /deterministic/);
  const total = plan.moves.reduce((n, m) => n + m.symbols.length, 0);
  assert.equal(total, 36, 'every symbol still lands in exactly one module');
});

// Path B's remaining real trigger: Path A's OWN size-sanity checks reject the section
// structure (too much unsectioned code here), not merely "too many sections" -- that
// case is now handled deterministically, see above.
test('runFileDecomposePlanPass: Path B (model merges sections) when too much of the file is unsectioned for Path A to trust', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  // assignSections assigns each symbol the NEAREST PRECEDING banner, inherited forward
  // until the next one -- so "no section" only actually happens BEFORE the first banner
  // in the file. These loose functions must come first to land in the '' bucket.
  const parts = ['<script>'];
  for (let i = 0; i < 20; i += 1) parts.push(`function loose${i}() {}`); // no banner yet -> unsectioned
  for (let s = 0; s < 3; s += 1) {
    parts.push(`// --- Section ${s} ---`);
    for (let i = 0; i < 2; i += 1) parts.push(`function s${s}f${i}() {}`);
  }
  parts.push('</script>');
  fs.writeFileSync(path.join(dir, 'index.html'), parts.join('\n'));
  const call = async ({ prompt }) => {
    const secs = [...prompt.matchAll(/^  "(.+?)" -- /gm)].map((m) => m[1]);
    return {
      response: JSON.stringify([
        { module: 'm0', sections: secs.slice(0, 2), includeUnsectioned: true },
        { module: 'm1', sections: secs.slice(2) },
      ]),
    };
  };
  const plan = await runFileDecomposePlanPass('index.html', { repoRoot: dir, call });
  assert.ok(plan);
  assert.match(plan.planPassNote, /merged sections/);
  const total = plan.moves.reduce((n, m) => n + m.symbols.length, 0);
  assert.equal(total, 26);
});

test('runFileDecomposePlanPass: null when nothing produces >=2 groups', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  fs.writeFileSync(path.join(dir, 'flat.js'), Array.from({ length: 10 }, (_, i) => `function f${i}(){}`).join('\n'));
  const plan = await runFileDecomposePlanPass('flat.js', { repoRoot: dir, call: async () => ({ response: JSON.stringify([{ newFile: 'lib/all.js', symbols: Array.from({ length: 10 }, (_, i) => `f${i}`) }]) }) });
  assert.equal(plan, null);
});

// --- fan-out filter (2026-09-14) -----------------------------------------------------

function writePy(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
  return path.join(dir, name);
}

test('computeFanOutSymbols: a symbol referenced from another section is flagged; a section-local symbol is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-'));
  const src = [
    '# --- Section A ---',
    'def route_a():',
    '    return shared_helper() + local_helper_a()',
    '',
    'def local_helper_a():',
    '    return 1',
    '',
    '# --- Section B ---',
    'def route_b():',
    '    return shared_helper() + 2',
    '',
    '# --- Shared ---',
    'def shared_helper():',
    '    return 42',
    '',
  ].join('\n');
  writePy(dir, 'app.py', src);

  const symbols = assignSections(src, '.py', extractTopLevelSymbols(src, '.py'));
  const groups = groupBySection(symbols);
  const fanOut = computeFanOutSymbols(dir, 'app.py', groups);
  assert.equal(fanOut.has('shared_helper'), true, 'called from both Section A and B -- cross-cutting');
  assert.equal(fanOut.has('route_a'), false, 'never called from outside its own section');
  assert.equal(fanOut.has('local_helper_a'), false, 'only used within its own section (by route_a)');
  assert.equal(fanOut.has('route_b'), false);
});

// 2026-09-14: computeFanOutSymbols now dispatches .js/.mjs/.cjs to computeJsFanOutSymbols
// (a REAL check, not a no-op) -- see the dedicated JS fan-out tests further down. Only a
// genuinely unsupported extension (no template, no check at all) is still a no-op.
test('computeFanOutSymbols: a no-op (empty set) for an extension with no fan-out check at all (e.g. .md)', () => {
  const groups = new Map([['A', [{ name: 'x' }]]]);
  assert.deepEqual(computeFanOutSymbols('/nonexistent', 'README.md', groups), new Set());
});

test('runFileDecomposePlanPass: a file-wide Python helper is excluded from every move and left in the source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-plan-'));
  const sections = [];
  for (let s = 0; s < 4; s += 1) {
    sections.push(`# --- Section ${s} ---`);
    // A real @app.route decorator is required -- routeFamily has priority over the banner
    // for section assignment, but more importantly each section must clear the
    // computeRoutelessSections filter (a section with zero routes is excluded entirely).
    sections.push(`@app.route("/${s}/a")`);
    sections.push(`def route_${s}_a():`);
    sections.push(`    return shared_helper() + 1`);
    sections.push(`@app.route("/${s}/b")`);
    sections.push(`def route_${s}_b():`);
    sections.push(`    return 2`);
  }
  sections.push('# --- Shared ---');
  sections.push('def shared_helper():');
  sections.push('    return 42');
  writePy(dir, 'app.py', sections.join('\n'));

  const plan = await runFileDecomposePlanPass('app.py', { repoRoot: dir, call: async () => ({ response: '[]' }) });
  assert.ok(plan);
  assert.match(plan.planPassNote, /shared\/cross-cutting/);
  for (const mv of plan.moves) assert.ok(!mv.symbols.includes('shared_helper'), 'shared_helper must never be claimed by a move');
});

test('packSections: merges the two smallest sections repeatedly down to the cap, never splitting a section', () => {
  const kept = [
    ['a', [{ name: 'a1' }]],
    ['b', [{ name: 'b1' }, { name: 'b2' }]],
    ['c', [{ name: 'c1' }]],
    ['d', [{ name: 'd1' }, { name: 'd2' }, { name: 'd3' }]],
    ['e', [{ name: 'e1' }]],
  ];
  const packed = packSections(kept, 3);
  assert.equal(packed.length, 3);
  const allSyms = packed.flatMap(([, syms]) => syms.map((s) => s.name)).sort();
  assert.deepEqual(allSyms, ['a1', 'b1', 'b2', 'c1', 'd1', 'd2', 'd3', 'e1'].sort(), 'every original symbol still present exactly once');
});

test('packSections: a no-op when already at or under the cap', () => {
  const kept = [['a', [{ name: 'a1' }]], ['b', [{ name: 'b1' }]]];
  const packed = packSections(kept, 8);
  assert.equal(packed.length, 2);
});

// --- routeless-section filter (2026-09-14) -------------------------------------------

test('computeRoutelessSections: every symbol in a section with zero @app.route views is flagged; a section with at least one route is not', () => {
  const src = [
    '# --- Helpers only ---',
    'def _helper_a():',
    '    return 1',
    'def _helper_b():',
    '    return 2',
    '',
    '# --- Has a route ---',
    '@app.route("/x")',
    'def view_x():',
    '    return _shared()',
    'def _shared():',
    '    return 3',
  ].join('\n');
  const symbols = assignSections(src, '.py', extractTopLevelSymbols(src, '.py'));
  const groups = groupBySection(symbols);
  const routeless = computeRoutelessSections('app.py', groups);
  assert.equal(routeless.has('_helper_a'), true);
  assert.equal(routeless.has('_helper_b'), true);
  // view_x's own section is route-family-labeled (routeFamily wins over the banner), not
  // grouped with _shared under "Has a route" -- so _shared (no route in ITS OWN section)
  // is itself routeless, same real-world shape as the app.py incident.
  assert.equal(routeless.has('_shared'), true);
});

test('computeRoutelessSections: a no-op (empty set) for a non-.py source', () => {
  const groups = new Map([['A', [{ name: 'x', isRoute: false }]]]);
  assert.deepEqual(computeRoutelessSections('app.js', groups), new Set());
});

test("moveTemplateFor (via runFileDecomposePlanPass): a multi-word packed .py module name has no hyphen in its import path -- 'from routes.worker-models-1-more import ...' is invalid Python syntax", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-plan-'));
  const sections = [];
  // 9 tiny, oddly-cased, multi-word-labeled sections -- forces packSections' "X + N more"
  // combo-label path, which is what produced the hyphenated module name live.
  for (let s = 0; s < 9; s += 1) {
    sections.push(`# --- Worker Models ${s} ---`);
    sections.push(`@app.route("/w${s}/a")`);
    sections.push(`def w${s}_view_a():`);
    sections.push(`    return 1`);
    sections.push(`@app.route("/w${s}/b")`);
    sections.push(`def w${s}_view_b():`);
    sections.push(`    return 2`);
  }
  writePy(dir, 'app.py', sections.join('\n'));

  const plan = await runFileDecomposePlanPass('app.py', { repoRoot: dir, call: async () => ({ response: '[]' }) });
  assert.ok(plan);
  for (const mv of plan.moves) {
    const base = mv.newFile.split('/').pop().replace(/\.py$/, '');
    assert.doesNotMatch(base, /-/, `${mv.newFile}: a Python module name cannot contain a hyphen`);
  }
});

// --- app-hook filter (2026-09-14, real Flask import failure) ------------------------

test('hasNonRouteAppHook: true for @app.errorhandler/@app.before_request, false for @app.route or a plain function', () => {
  const lines = ['@app.errorhandler(HTTPException)', 'def handle_http_exception(e):', '    pass'];
  assert.equal(hasNonRouteAppHook(lines, 1), true);
  const lines2 = ['@app.before_request', 'def check_auth():', '    pass'];
  assert.equal(hasNonRouteAppHook(lines2, 1), true);
  const lines3 = ['@app.route("/x")', 'def view_x():', '    pass'];
  assert.equal(hasNonRouteAppHook(lines3, 1), false);
  const lines4 = ['def plain():', '    pass'];
  assert.equal(hasNonRouteAppHook(lines4, 0), false);
});

test('hasNonRouteAppHook: true even when @app.route is ALSO stacked above the same def (multiple decorators)', () => {
  const lines = ['@app.errorhandler(404)', '@app.route("/not-a-real-combo")', 'def h(e):', '    pass'];
  assert.equal(hasNonRouteAppHook(lines, 2), true);
});

test('computeAppHookSymbols: flags only the hook-decorated symbols', () => {
  const symbols = [{ name: 'a', isAppHook: true }, { name: 'b', isAppHook: false }, { name: 'c', isAppHook: true }];
  assert.deepEqual(computeAppHookSymbols(symbols), new Set(['a', 'c']));
});

// The exact live incident: a section WITH a real route also contains an unrelated global
// @app.errorhandler as a sibling -- computeRoutelessSections alone would not catch this
// (the section has a route), so the app-hook filter must be a separate, per-symbol check.
test('runFileDecomposePlanPass: a global @app.errorhandler sharing a section with a real route is excluded, the route itself is not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apphook-plan-'));
  const sections = [];
  for (let s = 0; s < 5; s += 1) {
    sections.push(`# --- Section ${s} ---`);
    sections.push(`@app.route("/sec${s}/a")`);
    sections.push(`def sec${s}_view_a():`);
    sections.push(`    return 1`);
    sections.push(`@app.route("/sec${s}/b")`);
    sections.push(`def sec${s}_view_b():`);
    sections.push(`    return 2`);
  }
  sections.push('# --- Errors ---');
  sections.push('@app.errorhandler(HTTPException)');
  sections.push('def handle_http_exception(e):');
  sections.push('    return "err"');
  writePy(dir, 'app.py', sections.join('\n'));

  const plan = await runFileDecomposePlanPass('app.py', { repoRoot: dir, call: async () => ({ response: '[]' }) });
  assert.ok(plan);
  assert.match(plan.planPassNote, /global @app\.\* hook/);
  for (const mv of plan.moves) assert.ok(!mv.symbols.includes('handle_http_exception'), 'the global error handler must never be claimed by a move');
  const allMoved = plan.moves.flatMap((m) => m.symbols);
  assert.ok(allMoved.includes('sec0_view_a'), 'the real routes are still movable');
});

// --- JS fan-out filter (2026-09-14, screaminggoatclubmt: "Build the JS fan-out filter
// now" -- found live: task-sources.js and local-draft.js hit the exact same class of bug
// the .py fan-out filter fixed, with zero protection for non-Python files). ------------

test('computeJsFanOutSymbols: a symbol referenced from another section is flagged; a section-local symbol is not', () => {
  const src = [
    '// --- Section A ---',
    'function routeA() {',
    '  return sharedHelper() + localHelperA();',
    '}',
    'function localHelperA() {',
    '  return 1;',
    '}',
    '',
    '// --- Section B ---',
    'function routeB() {',
    '  return sharedHelper() + 2;',
    '}',
    '',
    '// --- Shared ---',
    'function sharedHelper() {',
    '  return 42;',
    '}',
  ].join('\n');
  const symbols = assignSections(src, '.js', extractTopLevelSymbols(src, '.js'));
  const groups = groupBySection(symbols);
  const fanOut = computeJsFanOutSymbols('x.js', src, symbols, groups);
  assert.equal(fanOut.has('sharedHelper'), true, 'called from both Section A and B -- cross-cutting');
  // routeA/routeB both directly CALL sharedHelper, so the transitive-closure pass (tested
  // in detail below) correctly excludes them too -- decompose-node-module.js has no way
  // to move a function that reads a name staying behind. localHelperA calls nothing
  // outside its own section, so it alone stays movable.
  assert.equal(fanOut.has('routeA'), true, 'calls sharedHelper directly');
  assert.equal(fanOut.has('localHelperA'), false, 'only used within its own section, calls nothing external');
  assert.equal(fanOut.has('routeB'), true, 'calls sharedHelper directly');
});

// The exact live bug: isDependencySatisfied et al. are UNSECTIONED (no preceding banner),
// which used to make the check skip them entirely (mirroring the .py path's `if (!label)
// continue`) -- unsectioned symbols still get swept into a misc/includeUnsectioned move,
// so they need the same cross-reference check as a named section.
test('computeJsFanOutSymbols: an UNSECTIONED symbol referenced from a named section is still flagged', () => {
  const src = [
    'function isDependencySatisfied() {',
    '  return true;',
    '}',
    '',
    '// --- Section A ---',
    'function nextTask() {',
    '  return isDependencySatisfied();',
    '}',
  ].join('\n');
  const symbols = assignSections(src, '.js', extractTopLevelSymbols(src, '.js'));
  const groups = groupBySection(symbols);
  const fanOut = computeJsFanOutSymbols('x.js', src, symbols, groups);
  assert.equal(fanOut.has('isDependencySatisfied'), true);
});

// The transitive-closure bug: decompose-node-module.js's deterministic extractor has NO
// back-import mechanism (unlike the .py flask-blueprint model's lazy `from app import X`),
// so a symbol that itself CALLS an excluded fan-out symbol is exactly as unmovable.
test('computeJsFanOutSymbols: a caller of an excluded fan-out symbol is transitively excluded too', () => {
  const src = [
    'function isDependencySatisfied() {',
    '  return true;',
    '}',
    '',
    '// --- Section A ---',
    'function nextAdhocLikeTask() {',
    '  return isDependencySatisfied();',
    '}',
    'function unrelatedHelperA() {',
    '  return 1;',
    '}',
    '',
    '// --- Section B ---',
    'function otherRoute() {',
    '  return isDependencySatisfied();',
    '}',
  ].join('\n');
  const symbols = assignSections(src, '.js', extractTopLevelSymbols(src, '.js'));
  const groups = groupBySection(symbols);
  const fanOut = computeJsFanOutSymbols('x.js', src, symbols, groups);
  assert.equal(fanOut.has('isDependencySatisfied'), true, 'referenced from two different sections');
  assert.equal(fanOut.has('nextAdhocLikeTask'), true, 'calls the excluded symbol -- can\'t be moved without a back-import decompose-node-module.js does not support');
  assert.equal(fanOut.has('otherRoute'), true, 'same reason, other section');
  assert.equal(fanOut.has('unrelatedHelperA'), false, 'does not call anything excluded -- still safely movable');
});

// The THIRD live gap: extractTopLevelSymbols only recognizes const/let/var bound to a
// FUNCTION value -- a plain data constant is invisible to it and never becomes a
// candidate `symbol`, so it can't be flagged by the section-level check at all. A symbol
// that references one must still be excluded (topLevelBindingNames sees it; the closure
// pass is seeded with names it finds that extractTopLevelSymbols missed).
test('computeJsFanOutSymbols: a symbol referencing a plain (non-function) top-level constant extractTopLevelSymbols never even saw is excluded', () => {
  const src = [
    'const PERIODIC_REATTEMPT_INTERVAL_MS = 60000;',
    '',
    '// --- Section A ---',
    'function checkReattempt() {',
    '  return Date.now() > PERIODIC_REATTEMPT_INTERVAL_MS;',
    '}',
    'function unrelatedHelperB() {',
    '  return 2;',
    '}',
  ].join('\n');
  const symbols = assignSections(src, '.js', extractTopLevelSymbols(src, '.js'));
  assert.ok(!symbols.some((s) => s.name === 'PERIODIC_REATTEMPT_INTERVAL_MS'), 'sanity: the plain constant really is invisible to extractTopLevelSymbols');
  const groups = groupBySection(symbols);
  const fanOut = computeJsFanOutSymbols('x.js', src, symbols, groups);
  assert.equal(fanOut.has('checkReattempt'), true);
  assert.equal(fanOut.has('unrelatedHelperB'), false);
});

// A require()-bound name is carried over automatically by decompose-node-module.js --
// referencing one must NOT trigger exclusion (it's not "left behind", it's imported).
test('computeJsFanOutSymbols: a symbol referencing a require()-bound top-level name is NOT excluded', () => {
  const src = [
    "const { readJsonSafe } = require('./util.js');",
    '',
    '// --- Section A ---',
    'function loadThing() {',
    '  return readJsonSafe("x.json");',
    '}',
  ].join('\n');
  const symbols = assignSections(src, '.js', extractTopLevelSymbols(src, '.js'));
  const groups = groupBySection(symbols);
  const fanOut = computeJsFanOutSymbols('x.js', src, symbols, groups);
  assert.equal(fanOut.has('loadThing'), false, 'require()-bound names are carried over, not a fan-out problem');
});

test('computeJsFanOutSymbols: a no-op for a non-.js/.mjs/.cjs source', () => {
  assert.deepEqual(computeJsFanOutSymbols('app.py', 'x', [], new Map()), new Set());
});

// End-to-end: the actual live incident, condensed -- runFileDecomposePlanPass must
// produce a plan that never claims isDependencySatisfied or its caller.
test('runFileDecomposePlanPass: a shared JS helper AND its caller are both excluded, still leaving other symbols movable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'js-fanout-plan-'));
  const parts = [
    'function isDependencySatisfied() {',
    '  return true;',
    '}',
    '',
  ];
  for (let s = 0; s < 4; s += 1) {
    parts.push(`// --- Section ${s} ---`);
    parts.push(`function nextTaskFor${s}() {`);
    parts.push(`  return isDependencySatisfied();`);
    parts.push('}');
    // Two independent helpers per section (not one) -- Path A's planFromSections merges
    // any section left with only a single surviving symbol into the misc bucket, and a
    // >=3-non-singleton-section requirement then fails with only 1 real symbol/section
    // left after exclusion, forcing a fallback to the model tiers this test's fake `call`
    // deliberately can't satisfy (that fallback path is exercised by other tests already).
    parts.push(`function plainHelper${s}a() {`);
    parts.push('  return 1;');
    parts.push('}');
    parts.push(`function plainHelper${s}b() {`);
    parts.push('  return 2;');
    parts.push('}');
  }
  writeJsFile(dir, 'src/task-sources.js', parts.join('\n'));

  const plan = await runFileDecomposePlanPass('src/task-sources.js', { repoRoot: dir, call: async () => ({ response: '[]' }) });
  assert.ok(plan);
  assert.match(plan.planPassNote, /deterministic/, 'enough non-singleton sections survive exclusion for Path A -- no model call needed');
  const allMoved = plan.moves.flatMap((m) => m.symbols);
  assert.ok(!allMoved.includes('isDependencySatisfied'));
  for (let s = 0; s < 4; s += 1) assert.ok(!allMoved.includes(`nextTaskFor${s}`), `nextTaskFor${s} calls the excluded helper`);
  for (let s = 0; s < 4; s += 1) {
    assert.ok(allMoved.includes(`plainHelper${s}a`), `plainHelper${s}a is independently movable`);
    assert.ok(allMoved.includes(`plainHelper${s}b`), `plainHelper${s}b is independently movable`);
  }
});

function writeJsFile(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
