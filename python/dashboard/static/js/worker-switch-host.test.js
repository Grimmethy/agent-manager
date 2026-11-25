// Tests for the host name in switch tooltips and the Workers header (worker-switch-ui.js helpers).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'worker-switch-ui.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src + '\n;this.api = { buildWorkerSwitchHtml, workersHeaderLine, workerSwitchTitle };', ctx);
const { buildWorkerSwitchHtml, workersHeaderLine, workerSwitchTitle } = ctx.api;

const ON_INST = { instanceId: 'worker-1', switchable: true, disabled: false, status: 'idle' };
const OFF_INST = { instanceId: 'worker-1', switchable: true, disabled: true, status: 'disabled' };

test('off button title names the host', () => {
  assert.match(buildWorkerSwitchHtml(ON_INST, 'wok'), /title="Turns off this lane on wok only/);
});

test('on button title names the host', () => {
  assert.match(buildWorkerSwitchHtml(OFF_INST, 'grimm'), /title="Turns on this lane on grimm only/);
});

test('header line names the host and keeps the fixed sentence', () => {
  const line = workersHeaderLine('wok');
  assert.ok(line.includes('wok'));
  assert.ok(line.includes('node lanes are listed read-only.'));
});

test('missing host falls back to this machine and never prints undefined', () => {
  assert.equal(workersHeaderLine(undefined), 'Switches here control this machine only; node lanes are listed read-only.');
  const html = buildWorkerSwitchHtml(ON_INST);
  assert.ok(html.includes('this machine only'));
  assert.ok(!html.includes('undefined'));
  assert.ok(!workerSwitchTitle(true, '').includes('undefined'));
});

test('host with markup characters is escaped in the attribute', () => {
  const html = buildWorkerSwitchHtml(ON_INST, 'a"<b>');
  assert.ok(!html.includes('a"<b>'));
  assert.ok(html.includes('a&quot;&lt;b&gt;'));
});
