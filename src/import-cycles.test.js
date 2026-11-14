'use strict';

// The import-cycle ratchet (scripts/import-cycles.js): a new cycle, a grown cycle and any static cycle fail; a shrunk cycle must be recorded with --shrink so the
// allowlist only gets smaller. The scenarios run on temporary trees; the last test runs the real check on this repository.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildGraph, findCycles, checkCycles, currentCycles, requireCalls, repoRoot } = require('../scripts/import-cycles.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'import-cycles.js');

class Fx {
  static tree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-cycles-'));
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
  }

  static lazyPair() {
    return {
      'src/a.js': "function f() { return require('./b.js'); }\nmodule.exports = { f };\n",
      'src/b.js': "function g() { return require('./a.js'); }\nmodule.exports = { g };\n",
    };
  }

  static run(root, args) {
    const env = { ...process.env, AGENT_MANAGER_IMPORT_CYCLES_ROOT: root };
    delete env.AGENT_MANAGER_IMPORT_CYCLES_ALLOWLIST;
    return spawnSync('node', [SCRIPT, ...args], { env, encoding: 'utf8' });
  }
}

const A_B = ['src/a.js', 'src/b.js'];

test('a lazy-only two-file cycle is found and is not static', () => {
  const root = Fx.tree(Fx.lazyPair());
  const cycles = currentCycles(root);
  assert.deepEqual(cycles.all, [A_B]);
  assert.deepEqual(cycles.static, []);
});

test('a new cycle that is not on the allowlist fails', () => {
  const problems = checkCycles(currentCycles(Fx.tree(Fx.lazyPair())), { cycles: [] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /new or grew beyond the allowlist: 2 files/);
});

test('a cycle that grew beyond its allowlisted entry fails', () => {
  const files = {
    ...Fx.lazyPair(),
    'src/b.js': "function g() { return [require('./a.js'), require('./c.js')]; }\n",
    'src/c.js': "function h() { return require('./b.js'); }\n",
  };
  files['src/a.js'] = "function f() { return require('./b.js'); }\nfunction k() { return require('./c.js'); }\n";
  const problems = checkCycles(currentCycles(Fx.tree(files)), { cycles: [A_B] });
  assert.ok(problems.some((p) => /new or grew beyond the allowlist: 3 files/.test(p)), problems.join('|'));
});

test('a cycle that shrank leaves a stale allowlist entry that must be shrunk', () => {
  const root = Fx.tree({ 'src/a.js': "function f() { return require('./b.js'); }\n", 'src/b.js': 'module.exports = {};\n' });
  const problems = checkCycles(currentCycles(root), { cycles: [A_B] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /stale .*--shrink/);
});

test('a static cycle fails even when it is allowlisted', () => {
  const root = Fx.tree({
    'src/a.js': "const b = require('./b.js');\nmodule.exports = { b };\n",
    'src/b.js': "const a = require('./a.js');\nmodule.exports = { a };\n",
  });
  const problems = checkCycles(currentCycles(root), { cycles: [A_B] });
  assert.ok(problems.some((p) => /static import cycle/.test(p)), problems.join('|'));
});

test('a require inside a comment or a string is not an edge', () => {
  const root = Fx.tree({
    'src/a.js': "// const b = require('./b.js');\nconst s = \"require('./b.js')\";\nmodule.exports = { s };\n",
    'src/b.js': "function g() { return require('./a.js'); }\n",
  });
  assert.deepEqual(currentCycles(root).all, []);
});

test('non-relative, non-literal and test-file requires are ignored', () => {
  assert.deepEqual(requireCalls("require('node:fs'); require(name); function f() { require('./x.js'); }").map((c) => [c.spec, c.depth]), [['node:fs', 0], ['./x.js', 1]]);
  const root = Fx.tree({
    'src/a.js': "const fs = require('node:fs'); function f() { return require('./a.test.js'); }\n",
    'src/a.test.js': "require('./a.js');\n",
  });
  assert.deepEqual(buildGraph(root).all, { 'src/a.js': [] });
});

test('findCycles lists components largest first with sorted members', () => {
  const adjacency = { z: ['y'], y: ['z'], a: ['b'], b: ['c'], c: ['a'], lone: [] };
  assert.deepEqual(findCycles(adjacency), [['a', 'b', 'c'], ['y', 'z']]);
});

test('--init writes the allowlist, the check then passes, --shrink refuses growth and accepts a shrink', () => {
  const root = Fx.tree(Fx.lazyPair());
  assert.equal(Fx.run(root, []).status, 1);
  assert.equal(Fx.run(root, ['--init']).status, 0);
  const file = path.join(root, 'config', 'import-cycles-allowlist.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { cycles: [A_B] });
  assert.equal(Fx.run(root, []).status, 0);
  fs.writeFileSync(path.join(root, 'src/c.js'), "function h() { return require('./a.js'); }\n");
  fs.writeFileSync(path.join(root, 'src/a.js'), "function f() { return [require('./b.js'), require('./c.js')]; }\n");
  assert.equal(Fx.run(root, []).status, 1);
  const refused = Fx.run(root, ['--shrink']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to shrink/);
  fs.unlinkSync(path.join(root, 'src/c.js'));
  fs.writeFileSync(path.join(root, 'src/a.js'), "function f() { return 1; }\n");
  assert.equal(Fx.run(root, []).status, 1);
  assert.equal(Fx.run(root, ['--shrink']).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { cycles: [] });
  assert.equal(Fx.run(root, []).status, 0);
});

test('this repository: no static cycle, no new or grown cycle, no stale allowlist entry', () => {
  const root = repoRoot();
  const allowlist = JSON.parse(fs.readFileSync(path.join(root, 'config', 'import-cycles-allowlist.json'), 'utf8'));
  const problems = checkCycles(currentCycles(root), allowlist);
  assert.deepEqual(problems, [], `import cycle violations (cut the edge, or run node scripts/import-cycles.js --shrink after a cycle shrank; never grow the allowlist):\n  ${problems.join('\n  ')}`);
});
