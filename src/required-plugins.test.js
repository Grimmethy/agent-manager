'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const rp = require('./required-plugins.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reqplug-'));
const plugin = (root, name, version, files = ['register.js']) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (version !== null) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  for (const f of files) fs.writeFileSync(path.join(dir, f), '// plugin\n');
  return dir;
};

test('parseVersion reads x.y.z with optional pre-release and build tags and refuses anything else', () => {
  assert.deepStrictEqual(rp.parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepStrictEqual(rp.parseVersion('v0.10.0-beta.1+build.5'), [0, 10, 0]);
  for (const bad of ['1.2', '1', 'x.y.z', '01.2.3', '', null, undefined, 'latest']) assert.strictEqual(rp.parseVersion(bad), null, String(bad));
});

test('satisfies: caret, tilde, x-ranges, comparators, AND and OR behave like semver', () => {
  const table = [['0.1.0', '^0.1.0', true], ['0.1.9', '^0.1.0', true], ['0.2.0', '^0.1.0', false], ['1.2.3', '^1.0.0', true], ['2.0.0', '^1.0.0', false],
    ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false], ['1.2.3', '~1.2.0', true], ['1.3.0', '~1.2.0', false], ['1.5.0', '1.x', true], ['2.0.0', '1.x', false],
    ['1.2.9', '1.2', true], ['1.3.0', '1.2', false], ['3.0.0', '*', true], ['1.4.0', '>=1.2.0 <1.5.0', true], ['1.5.0', '>=1.2.0 <1.5.0', false],
    ['0.9.0', '>=1.0.0 || <0.5.0', false], ['0.4.0', '>=1.0.0 || <0.5.0', true], ['1.2.3', '=1.2.3', true], ['1.2.4', '1.2.3', false],
    ['1.2.3-beta.1', '^1.2.0', true], ['1.0.0', '> 0.9.0', true], ['1.0.0', '<=1.0.0', true], ['1.0.1', '<=1.0.0', false], ['1.0.0', '>1.0.0', false]];
  for (const [v, r, want] of table) assert.strictEqual(rp.satisfies(v, r), want, `${v} in ${r}`);
});

test('an unusable range or version never satisfies: a bad range is not a silent pass', () => {
  for (const r of ['', 'garbage', '1.2.3 - 2.0.0', '>=', '^', 'latest', null, undefined]) { assert.strictEqual(rp.validRange(r), false, String(r)); assert.strictEqual(rp.satisfies('1.0.0', r), false, String(r)); }
  assert.strictEqual(rp.satisfies('not-a-version', '*'), false);
  assert.strictEqual(rp.satisfies(undefined, '*'), false);
});

test('loadRequired: the shipped config lists hub-tasks with a valid range and defaults the entry; every defect in a config is a loud RequiredPluginError', () => {
  const shipped = rp.loadRequired();
  assert.ok(shipped.some((e) => e.name === 'agent-manager-hub-tasks'));
  for (const e of shipped) { assert.ok(rp.validRange(e.range), e.name); assert.ok(e.entry); }
  const dir = tmp();
  const write = (obj) => { const f = path.join(dir, `c${Math.random()}.json`); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
  assert.deepStrictEqual(rp.loadRequired(write({ requiredPlugins: [{ name: ' a ', range: '^1.0.0 ' }, { name: 'b', range: '1.x', entry: 'x.js' }] })), [{ name: 'a', range: '^1.0.0', entry: 'register.js' }, { name: 'b', range: '1.x', entry: 'x.js' }]);
  assert.deepStrictEqual(rp.loadRequired(write({ requiredPlugins: [] })), []);
  for (const [cfg, re] of [['{not json', /cannot be read/], [{ nothing: 1 }, /no requiredPlugins array/], [{ requiredPlugins: [{ name: 'a' }] }, /needs a name and a range/],
    [{ requiredPlugins: [{ range: '1.x' }] }, /needs a name and a range/], [{ requiredPlugins: [{ name: 'a', range: '1.x' }, { name: 'a', range: '2.x' }] }, /lists a twice/]]) {
    assert.throws(() => rp.loadRequired(write(cfg)), (e) => e instanceof rp.RequiredPluginError && re.test(e.message), JSON.stringify(cfg));
  }
  assert.throws(() => rp.loadRequired(path.join(dir, 'missing.json')), rp.RequiredPluginError);
});

test('checkRequiredPlugins reports every status with a readable message and ok only when all are met', () => {
  const root = tmp();
  const dirs = { good: plugin(root, 'good', '0.1.4'), old: plugin(root, 'old', '0.0.9'), nover: plugin(root, 'nover', null), badver: plugin(root, 'badver', 'latest'), noentry: plugin(root, 'noentry', '0.1.0', []) };
  const required = [['good', '^0.1.0'], ['old', '^0.1.0'], ['nover', '^0.1.0'], ['badver', '^0.1.0'], ['noentry', '^0.1.0'], ['gone', '^0.1.0'], ['badrange', 'oops']].map(([name, range]) => ({ name, range, entry: 'register.js' }));
  const res = rp.checkRequiredPlugins({ required, resolveRoot: (n) => dirs[n] || (n === 'badrange' ? dirs.good : null) });
  assert.deepStrictEqual(res.results.map((r) => [r.name, r.status]), [['good', 'ok'], ['old', 'OUT_OF_RANGE'], ['nover', 'NO_VERSION'], ['badver', 'NO_VERSION'], ['noentry', 'NO_ENTRY'], ['gone', 'MISSING'], ['badrange', 'INVALID_RANGE']]);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.results[0].found, '0.1.4');
  assert.match(res.results[1].message, /0\.0\.9 is outside \^0\.1\.0/);
  assert.match(res.results[5].message, /not found or not enabled in plugins\.json/);
  assert.ok(res.results.every((r) => rp.STATUSES.includes(r.status)));
  assert.strictEqual(rp.checkRequiredPlugins({ required: [required[0]], resolveRoot: (n) => dirs[n] }).ok, true);
  assert.deepStrictEqual(rp.checkRequiredPlugins({ required: [], resolveRoot: () => null }), { ok: true, results: [] });
});

test('failureText names every unmet plugin and is empty when all are met; assertRequiredPlugins throws it', () => {
  const root = tmp();
  const dirs = { good: plugin(root, 'good', '0.1.0'), old: plugin(root, 'old', '2.0.0') };
  const required = [{ name: 'good', range: '^0.1.0', entry: 'register.js' }, { name: 'old', range: '^0.1.0', entry: 'register.js' }, { name: 'gone', range: '1.x', entry: 'register.js' }];
  const res = rp.checkRequiredPlugins({ required, resolveRoot: (n) => dirs[n] });
  const text = rp.failureText(res.results);
  assert.match(text, /^\[required-plugins\] ERROR: 2 required plugin\(s\) unmet/);
  assert.match(text, /\[OUT_OF_RANGE\] old: version 2\.0\.0 is outside \^0\.1\.0/);
  assert.match(text, /\[MISSING\] gone:/);
  assert.ok(!/good/.test(text));
  assert.strictEqual(rp.failureText(rp.checkRequiredPlugins({ required: [required[0]], resolveRoot: (n) => dirs[n] }).results), '');
  assert.throws(() => rp.assertRequiredPlugins({ required, resolveRoot: (n) => dirs[n] }), (e) => e instanceof rp.RequiredPluginError && e.results.length === 3 && /unmet/.test(e.message));
  assert.strictEqual(rp.assertRequiredPlugins({ required: [required[0]], resolveRoot: (n) => dirs[n] }).ok, true);
});

test('the real CLI: a missing plugin, an out-of-range plugin and an unusable config exit nonzero with a readable error; a met set exits 0', () => {
  const root = tmp();
  const manifest = path.join(root, 'plugins.json');
  const cfg = path.join(root, 'required.json');
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'required-plugins.js'), ...args], { encoding: 'utf8', env: { ...process.env, AGENT_MANAGER_PLUGINS_MANIFEST: manifest } });
  fs.writeFileSync(cfg, JSON.stringify({ requiredPlugins: [{ name: 'fix-plugin', range: '^0.1.0' }] }));
  // 1. the plugin is not in the manifest
  fs.writeFileSync(manifest, '[]');
  let r = run('--config', cfg);
  assert.strictEqual(r.status, 3);
  assert.match(r.stderr, /\[required-plugins\] ERROR: 1 required plugin\(s\) unmet/);
  assert.match(r.stderr, /\[MISSING\] fix-plugin: not found or not enabled/);
  // 2. present but outside the range
  const dir = plugin(root, 'fix-plugin', '0.3.0');
  fs.writeFileSync(manifest, JSON.stringify([{ name: 'fix-plugin', registerPath: path.join(dir, 'register.js'), enabled: true }]));
  r = run('--config', cfg);
  assert.strictEqual(r.status, 3);
  assert.match(r.stderr, /\[OUT_OF_RANGE\] fix-plugin: version 0\.3\.0 is outside \^0\.1\.0/);
  // 3. disabled counts as missing
  fs.writeFileSync(manifest, JSON.stringify([{ name: 'fix-plugin', registerPath: path.join(dir, 'register.js'), enabled: false }]));
  assert.match(run('--config', cfg).stderr, /\[MISSING\]/);
  // 4. a met set exits 0 and prints the status; --json prints the result object
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.2' }));
  fs.writeFileSync(manifest, JSON.stringify([{ name: 'fix-plugin', registerPath: path.join(dir, 'register.js'), enabled: true }]));
  r = run('--config', cfg);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /fix-plugin 0\.1\.2 satisfies \^0\.1\.0/);
  assert.strictEqual(r.stderr, '');
  const j = JSON.parse(run('--config', cfg, '--json').stdout);
  assert.deepStrictEqual([j.ok, j.results[0].status, j.results[0].found], [true, 'ok', '0.1.2']);
  // 5. an unusable config is exit 2, never a pass
  r = run('--config', path.join(root, 'nope.json'));
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /cannot be read/);
});

test('main uses the injected resolver and writers and returns the exit code', () => {
  const lines = []; const errs = [];
  const cfg = path.join(tmp(), 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ requiredPlugins: [{ name: 'p', range: '^1.0.0' }] }));
  const code = rp.main(['--config', cfg], { out: (s) => lines.push(s), err: (s) => errs.push(s), resolveRoot: () => null });
  assert.strictEqual(code, 3);
  assert.ok(lines[0].startsWith('MISSING'));
  assert.match(errs[0], /unmet/);
});
