'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkerFor, isModuleFormatAmbiguity, summarizeSyntaxError, resolvePython, PY_CHECK_SCRIPT } = require('./syntax-check.js');

test('checkerFor picks node for js/mjs/cjs, python for py, an in-process parse for json, and nothing for everything else', () => {
  assert.deepEqual(checkerFor('src/a.js'), { kind: 'node', bin: 'node', args: ['--check', 'src/a.js'] });
  assert.equal(checkerFor('a.mjs').kind, 'node');
  assert.equal(checkerFor('a.CJS').kind, 'node');
  const py = checkerFor('python_services/x.py');
  assert.equal(py.kind, 'python');
  assert.equal(py.bin, 'python');
  assert.deepEqual(py.args, ['-c', PY_CHECK_SCRIPT, 'python_services/x.py']);
  assert.equal(checkerFor('package.json').kind, 'json');
  for (const f of ['a.ts', 'a.tsx', 'a.jsx', 'README.md', 'run.sh', 'noext', '', null, undefined]) assert.equal(checkerFor(f), null, String(f));
});

test('the python check compiles without writing a .pyc and catches a return outside a function (py_compile semantics)', () => {
  assert.ok(PY_CHECK_SCRIPT.includes('compile('));
  assert.ok(!PY_CHECK_SCRIPT.includes('py_compile'));
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-py-'));
  const run = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return spawnSync('python3', ['-c', PY_CHECK_SCRIPT, f], { encoding: 'utf8' }); };
  assert.equal(run('ok.py', 'def f():\n    return 1\n').status, 0);
  assert.notEqual(run('bad.py', 'from a import\nfrom b import X (\n    y,\n)\n').status, 0);
  assert.notEqual(run('ret.py', 'return 1\n').status, 0, 'compile() rejects a top-level return, which ast.parse alone would accept');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['bad.py', 'ok.py', 'ret.py'], 'no __pycache__ or .pyc was written');
});

test('isModuleFormatAmbiguity recognises the node module-system messages and nothing else', () => {
  assert.equal(isModuleFormatAmbiguity("SyntaxError: Cannot use import statement outside a module"), true);
  assert.equal(isModuleFormatAmbiguity("SyntaxError: Unexpected token 'export'"), true);
  assert.equal(isModuleFormatAmbiguity("SyntaxError: Unexpected identifier 'x'"), false);
  assert.equal(isModuleFormatAmbiguity(''), false);
});

test('summarizeSyntaxError names the file, the line and the error for node and python output, bounded', () => {
  const node = '/w/src/a.js:12\n  const x = ;\n            ^\n\nSyntaxError: Unexpected token \';\'\n    at wrapSafe';
  assert.equal(summarizeSyntaxError(node, 'src/a.js'), "src/a.js:12 SyntaxError: Unexpected token ';'");
  const py = '  File "cadastral_image.py", line 12\n    from cadastral_utils import\n                               ^\nSyntaxError: invalid syntax\n';
  assert.equal(summarizeSyntaxError(py, 'cadastral_image.py'), 'cadastral_image.py:12 SyntaxError: invalid syntax');
  const pyTraceback = 'Traceback (most recent call last):\n  File "<string>", line 2, in <module>\n  File "cadastral_image.py", line 12\n    from cadastral_utils import\n                               ^\nSyntaxError: invalid syntax\n';
  assert.equal(summarizeSyntaxError(pyTraceback, 'cadastral_image.py'), 'cadastral_image.py:12 SyntaxError: invalid syntax', 'the real location, not the checker script\'s own frame');
  assert.equal(summarizeSyntaxError('', 'x.js'), 'x.js syntax error');
  assert.ok(summarizeSyntaxError(`SyntaxError: ${'y'.repeat(1000)}`, 'x.js').length <= 300);
});

test('resolvePython prefers explicit, then the repo .venv, then AGENT_MANAGER_PYTHON, then the system python3, else null', () => {
  const present = (set) => (p) => set.includes(p);
  assert.equal(resolvePython({ explicit: '/opt/py', repoRoot: '/r', env: {}, exists: present(['/opt/py', '/r/.venv/bin/python', '/usr/bin/python3']) }), '/opt/py');
  assert.equal(resolvePython({ repoRoot: '/r', env: {}, exists: present(['/r/.venv/bin/python', '/usr/bin/python3']) }), '/r/.venv/bin/python');
  assert.equal(resolvePython({ repoRoot: '/r', env: { AGENT_MANAGER_PYTHON: '/custom/py' }, exists: present(['/custom/py', '/usr/bin/python3']) }), '/custom/py');
  assert.equal(resolvePython({ repoRoot: '/r', env: {}, exists: present(['/usr/bin/python3']) }), '/usr/bin/python3');
  assert.equal(resolvePython({ repoRoot: '/r', env: {}, exists: present(['/usr/local/bin/python3']) }), '/usr/local/bin/python3');
  assert.equal(resolvePython({ repoRoot: '/r', env: {}, exists: present([]) }), null);
  assert.equal(resolvePython({ env: {}, exists: () => { throw new Error('boom'); } }), null, 'a throwing existence check never throws');
});
