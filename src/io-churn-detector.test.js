'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const detector = require('./lib/io-churn-detector.js');
const cli = require('./io-churn-detector.js');

// A unified diff that adds `lines` to `file` (new file, line numbers from 1).
function diffAdding(file, lines) {
  return [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n') + '\n';
}
const kindsOf = (file, lines) => detector.scanDiff(diffAdding(file, lines)).map((f) => f.kind);

test('the contract names are exported', () => {
  assert.strictEqual(detector.IO_OK_TOKEN, 'io-ok:');
  assert.deepStrictEqual(detector.KINDS, ['caller-num-ctx', 'finite-keep-alive', 'unload-call', 'direct-model-call']);
  assert.ok(detector.SANCTIONED_PATHS.includes('src/local-client.js'));
  assert.strictEqual(detector.isSanctionedPath('src/gpu-capacity.js'), true);
  assert.strictEqual(detector.isSanctionedPath('src/other.js'), false);
});

test('caller-num-ctx: js and py literals flag, reading the pinned value does not', () => {
  assert.deepStrictEqual(kindsOf('src/a.js', ['const CHECK_NUM_CTX = 8192;']), ['caller-num-ctx']);
  assert.deepStrictEqual(kindsOf('src/a.js', ['call({ prompt, numCtx: 8192 });']), ['caller-num-ctx']);
  assert.deepStrictEqual(kindsOf('python/a.py', ['body = {"options": {"num_ctx": 8192}}']), ['caller-num-ctx']);
  assert.deepStrictEqual(kindsOf('python/a.py', ['generate(prompt, num_ctx=4096)']), ['caller-num-ctx']);
  assert.deepStrictEqual(kindsOf('src/a.js', ['call({ numCtx: pinned });', 'if (numCtx === 8192) return;']), []);
});

test('finite-keep-alive: a duration or a short number flags, never-expire values and the shared constant do not', () => {
  assert.deepStrictEqual(kindsOf('src/a.js', ["const KEEP_ALIVE = '30m';"]), ['finite-keep-alive']);
  assert.deepStrictEqual(kindsOf('src/a.js', ['body.keep_alive = 600;']), ['finite-keep-alive']);
  assert.deepStrictEqual(kindsOf('python/a.py', ['payload = {"keep_alive": "10m"}']), ['finite-keep-alive']);
  assert.deepStrictEqual(kindsOf('src/a.js', ["const a = { keep_alive: '8760h' };", 'const b = { keep_alive: -1 };', 'const c = { keep_alive: NEVER_EXPIRE };']), []);
});

test('unload-call: keep_alive 0 and an unload call flag', () => {
  assert.deepStrictEqual(kindsOf('src/a.js', ['await post({ model, keep_alive: 0 });']), ['unload-call']);
  assert.deepStrictEqual(kindsOf('python/a.py', ['requests.post(u, json={"keep_alive": "0"})']), ['unload-call']);
  assert.deepStrictEqual(kindsOf('scripts/a.sh', ['ollama stop "$MODEL"']), ['unload-call']);
  assert.deepStrictEqual(kindsOf('src/a.js', ['await unloadModel(name);']), ['unload-call']);
});

test('direct-model-call: the generate and chat endpoints flag, dashboard /api/chat/* routes and comments do not', () => {
  assert.deepStrictEqual(kindsOf('src/a.js', ["fetch(`${url}/api/generate`, { method: 'POST' });"]), ['direct-model-call']);
  assert.deepStrictEqual(kindsOf('python/a.py', ['urllib.request.Request(f"{u}/api/chat", data=b)']), ['direct-model-call']);
  assert.deepStrictEqual(kindsOf('scripts/a.sh', ['curl -s "$URL/api/generate" -d "$BODY"']), ['direct-model-call']);
  assert.deepStrictEqual(kindsOf('python/a.py', ['@bp.route("/api/chat/inject", methods=["POST"])', '@bp.route("/api/chat/new")']), []);
  assert.deepStrictEqual(kindsOf('src/a.js', ['// posts to /api/generate (see local-client.js)', '/* /api/chat */', ' * /api/generate']), []);
  assert.deepStrictEqual(kindsOf('python/a.py', ['# POSTs to /api/generate']), []);
});

test('io-ok with a reason annotates the same line or the line above; an empty reason does not', () => {
  const same = detector.scanDiff(diffAdding('src/a.js', ["const KEEP_ALIVE = '5m'; // io-ok: a one-shot probe on the scratch endpoint"]));
  assert.strictEqual(same[0].annotated, true);
  assert.match(same[0].reason, /one-shot probe/);
  const above = detector.scanDiff(diffAdding('python/a.py', ['# io-ok: scratch endpoint, never the resident model', 'body = {"num_ctx": 2048}']));
  assert.strictEqual(above[0].annotated, true);
  const empty = detector.scanDiff(diffAdding('src/a.js', ["const KEEP_ALIVE = '5m'; // io-ok:"]));
  assert.strictEqual(empty[0].annotated, false);
});

test('test files and sanctioned files are skipped; includeTests brings tests back', () => {
  const lines = ['const x = { numCtx: 8192 };'];
  assert.deepStrictEqual(kindsOf('src/a.test.js', lines), []);
  assert.deepStrictEqual(kindsOf('python/test_a.py', ['x = {"num_ctx": 8192}']), []);
  assert.deepStrictEqual(kindsOf('src/gpu-capacity.js', lines), []);
  assert.deepStrictEqual(kindsOf('src/local-client.js', ["fetch(`${u}/api/generate`)"]), []);
  assert.deepStrictEqual(detector.scanDiff(diffAdding('src/a.test.js', lines), { includeTests: true }).map((f) => f.kind), ['caller-num-ctx']);
});

test('only ADDED lines are reported, with new-file line numbers', () => {
  const diff = ['diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -10,3 +10,4 @@', " const old = { numCtx: 8192 };", '+const fresh = { numCtx: 4096 };', ' const tail = 1;', ' const end = 2;'].join('\n') + '\n';
  const found = detector.scanDiff(diff);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].line, 11);
  assert.match(found[0].snippet, /4096/);
  assert.strictEqual(found[0].severity, 'churn');
});

test('an added line that starts with ++ is not mistaken for a file header', () => {
  const diff = ['diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,1 +1,3 @@', ' const a = 1;', '+++ not a header', '+const k = { numCtx: 9000 };'].join('\n') + '\n';
  const found = detector.scanDiff(diff);
  assert.deepStrictEqual(found.map((f) => f.line), [3]);
  assert.strictEqual(found[0].path, 'src/a.js');
});

test('a finding signature survives a line move', () => {
  const a = detector.scanDiff(diffAdding('src/a.js', ['const x = { numCtx: 8192 };']))[0];
  const b = detector.scanDiff(diffAdding('src/a.js', ['', '', 'const x = { numCtx: 8192 };']))[0];
  assert.notStrictEqual(a.line, b.line);
  assert.strictEqual(a.signature, b.signature);
});

function runCli(args) {
  let out = ''; let err = '';
  const code = cli.main(args, { stdout: { write: (t) => { out += t; } }, stderr: { write: (t) => { err += t; } } });
  return { code, out, err };
}

test('CLI scan --diff prints { new, known, annotated }; --fail-on-new exits 1 for a new finding and 0 when clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-churn-'));
  const dirty = path.join(dir, 'dirty.diff'); const clean = path.join(dir, 'clean.diff'); const noted = path.join(dir, 'noted.diff');
  fs.writeFileSync(dirty, diffAdding('src/a.js', ['const x = { numCtx: 8192 };']));
  fs.writeFileSync(clean, diffAdding('src/a.js', ['const x = { numCtx: pinned };']));
  fs.writeFileSync(noted, diffAdding('src/a.js', ['const x = { numCtx: 8192 }; // io-ok: scratch endpoint']));
  const r = runCli(['scan', '--diff', dirty, '--fail-on-new']);
  assert.strictEqual(r.code, 1);
  const parsed = JSON.parse(r.out);
  assert.strictEqual(parsed.new.length, 1);
  assert.deepStrictEqual(parsed.known, []);
  assert.strictEqual(runCli(['scan', '--diff', clean, '--fail-on-new']).code, 0);
  const n = runCli(['scan', '--diff', noted, '--fail-on-new']);
  assert.strictEqual(n.code, 0);
  assert.strictEqual(JSON.parse(n.out).annotated.length, 1);
  assert.strictEqual(runCli(['scan']).code, 2);
  assert.strictEqual(runCli(['scan', '--diff', path.join(dir, 'missing.diff')]).code, 2);
});

test('the detector modules themselves never send a keep_alive of 0 or a request', () => {
  for (const f of ['lib/io-churn-detector.js', 'io-churn-detector.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/keep_alive\s*:\s*0/.test(src), `${f} must not unload`);
    assert.ok(!/fetch\(|http\.request|urlopen/.test(src), `${f} must not make requests`);
  }
});

test('prose is not code: python docstrings and js block comments are skipped, the code after them is not', () => {
  const py = ['"""Module doc.', "POSTs to Ollama's /api/generate with num_ctx: 8192", '"""', 'x = {"num_ctx": 8192}', '"""one-line doc about /api/chat"""'];
  assert.deepStrictEqual(detector.scanText({ language: 'py', path: 'python/a.py', text: py.join('\n') }).map((f) => [f.line, f.kind]), [[4, 'caller-num-ctx']]);
  const js = ['/* the old call posted to /api/generate', '   with keep_alive: 0 */', 'const a = { numCtx: 4096 };', 'const b = 1; /* keep_alive: 0 */ const c = 2;'];
  assert.deepStrictEqual(detector.scanText({ language: 'js', path: 'src/a.js', text: js.join('\n') }).map((f) => [f.line, f.kind]), [[3, 'caller-num-ctx']]);
});

test('an unrelated keepalive name (an SSE heartbeat) is not a model keep_alive', () => {
  assert.deepStrictEqual(kindsOf('python/a.py', ['KEEPALIVE_S = 15.0', 'keepalive_interval = 30']), []);
  assert.deepStrictEqual(kindsOf('python/a.py', ['LOCAL_KEEP_ALIVE = "5m"']), ['finite-keep-alive']);
});

test('vendored trees are skipped', () => {
  assert.deepStrictEqual(kindsOf('vendor/lib/x.py', ['r = post(f"{u}/api/generate")']), []);
  assert.deepStrictEqual(kindsOf('node_modules/x/y.js', ['const k = { numCtx: 1 };']), []);
});
