'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { listWatchdogScripts, checkScript } = require('./plugin-watchdog-scripts.js');

const ROOT = '/plugins/demo';
const entry = (over = {}) => ({ name: 'demo', registerPath: ROOT + '/register.js', enabled: true, watchdogScripts: ['harness/trigger.js'], ...over });

test('an enabled entry with a relative .js script is listed with its absolute path', () => {
  const { scripts, skipped } = listWatchdogScripts([entry()]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(scripts, [{ plugin: 'demo', root: ROOT, script: 'harness/trigger.js', abs: ROOT + '/harness/trigger.js' }]);
});

test('disabled entries, entries without scripts, and entries without a registerPath list nothing', () => {
  const r = listWatchdogScripts([entry({ enabled: false }), entry({ watchdogScripts: undefined }), entry({ registerPath: '' }), entry({ registerPath: undefined })]);
  assert.deepEqual(r, { scripts: [], skipped: [] });
  assert.deepEqual(listWatchdogScripts([entry({ enabled: undefined })]).scripts.length, 1, 'enabled absent means enabled, as everywhere else');
});

test('no manifest, a non-array manifest and junk entries give an empty result and never throw', () => {
  for (const m of [null, undefined, {}, 'x', [null, 3, 'a', []]]) assert.deepEqual(listWatchdogScripts(m), { scripts: [], skipped: [] });
});

const BAD = [
  ['absolute path', '/etc/x.js', /relative/],
  ['windows drive path', 'C:\\x.js', /relative/],
  ['parent segment', '../x.js', /\.\./],
  ['parent segment mid-path', 'a/../../x.js', /\.\./],
  ['not a js file', 'run.sh', /\.js/],
  ['empty string', '  ', /non-empty/],
  ['not a string', 7, /non-empty/],
];
for (const [label, rel, re] of BAD) {
  test(`rejected with a reason: ${label}`, () => {
    assert.match(checkScript(rel), re);
    const r = listWatchdogScripts([entry({ watchdogScripts: [rel, 'ok.js'] })]);
    assert.equal(r.scripts.length, 1, 'the good sibling is still listed');
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, re);
  });
}

test('watchdogScripts that is not an array, and an unsafe plugin name, are skipped with a reason', () => {
  assert.match(listWatchdogScripts([entry({ watchdogScripts: 'a.js' })]).skipped[0].reason, /array/);
  assert.match(listWatchdogScripts([entry({ name: 'a/b' })]).skipped[0].reason, /name/);
  assert.match(listWatchdogScripts([entry({ name: undefined })]).skipped[0].reason, /name/);
});

test('plugins.json passthrough: readPluginsManifest keeps the extra watchdogScripts field', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pws-'));
  const m = path.join(dir, 'plugins.json');
  fs.writeFileSync(m, JSON.stringify([entry()]));
  const out = execFileSync(process.execPath, ['-e', "const {readPluginsManifest}=require('./src/plugins-manifest.js');console.log(JSON.stringify(readPluginsManifest()))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, AGENT_MANAGER_PLUGINS_MANIFEST: m }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out)[0].watchdogScripts, ['harness/trigger.js']);
});

test('CLI prints plugin<TAB>absolute path per script, and --json prints both lists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pws-'));
  const m = path.join(dir, 'plugins.json');
  fs.writeFileSync(m, JSON.stringify([entry({ watchdogScripts: ['a.js', '../bad.js'] })]));
  const env = { ...process.env, AGENT_MANAGER_PLUGINS_MANIFEST: m };
  const plain = execFileSync(process.execPath, [path.join(__dirname, 'plugin-watchdog-scripts.js')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(plain, `demo\t${ROOT}/a.js\n`);
  const json = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'plugin-watchdog-scripts.js'), '--json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(json.scripts.length, 1);
  assert.equal(json.skipped.length, 1);
});
