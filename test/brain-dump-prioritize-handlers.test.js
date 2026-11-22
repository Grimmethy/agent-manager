'use strict';

// HUB0281-03: both 'Process now' click handlers (the Brain Dump card wiring and the Filed Findings wiring) go through prioritizeEntry(): a declined
// 409 prompt resets the button without refreshing, any other outcome refreshes, and a thrown error alerts and resets. The two wire functions are cut
// out of the browser script's source and run in a vm context with a fake element whose only [data-prioritize] button is the one under test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'python/dashboard/static/js/brain-dump-and-second-brain.js'), 'utf8');

function functionSource(name) {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const end = SRC.indexOf('\n}\n', start + 1);
  return SRC.slice(start + 1, end + 3);
}

// wireName: 'wireBrainDumpCardHandlers' | 'wireFiledFindingsHandlers'; refreshName: the refresh function that wire function calls after queueing.
function click(wireName, refreshName, prioritizeEntry) {
  const calls = { refresh: 0, alert: [], prioritized: [] };
  const btn = { dataset: { prioritize: 'bd-9' }, disabled: false, textContent: 'Process now' };
  const el = { querySelectorAll: (sel) => (sel === '[data-prioritize]' ? [btn] : []), querySelector: () => null };
  const sandbox = {
    document: { getElementById: () => null }, localStorage: { setItem() {}, getItem: () => null },
    brainDumpDiscussingId: null,
    alert: (m) => calls.alert.push(m),
    prioritizeEntry: async (id) => { calls.prioritized.push(id); return prioritizeEntry(id); },
    [refreshName]: async () => { calls.refresh += 1; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${functionSource(wireName)}; this.wire = ${wireName};`, sandbox);
  sandbox.wire(el);
  return { btn, calls, press: () => btn.onclick() };
}

for (const [wireName, refreshName] of [['wireBrainDumpCardHandlers', 'refreshBrainDumpEntries'], ['wireFiledFindingsHandlers', 'refreshFiledFindingsEntries']]) {
  test(`${wireName}: a queued entry calls prioritizeEntry with the id and refreshes`, async () => {
    const h = click(wireName, refreshName, async () => ({ queued: true, declined: false, status: 200 }));
    await h.press();
    assert.deepEqual(h.calls.prioritized, ['bd-9']);
    assert.equal(h.calls.refresh, 1);
    assert.equal(h.calls.alert.length, 0);
    assert.equal(h.btn.textContent, 'Queuing...', 'the refresh re-renders the card, so the handler leaves the label alone');
  });

  test(`${wireName}: a declined prompt resets the button and does not refresh`, async () => {
    const h = click(wireName, refreshName, async () => ({ queued: false, declined: true, status: 409 }));
    await h.press();
    assert.equal(h.calls.refresh, 0);
    assert.equal(h.btn.disabled, false);
    assert.equal(h.btn.textContent, 'Process now');
  });

  test(`${wireName}: a thrown error alerts and resets the button`, async () => {
    const h = click(wireName, refreshName, async () => { throw new Error('network down'); });
    await h.press();
    assert.equal(h.calls.refresh, 0);
    assert.match(h.calls.alert[0], /Could not queue: network down/);
    assert.equal(h.btn.disabled, false);
    assert.equal(h.btn.textContent, 'Process now');
  });
}

test('the script has no inline POST to /prioritize any more (both handlers use the helper)', () => {
  const inline = SRC.split('\n').filter((l) => l.includes("'/prioritize'"));
  assert.equal(inline.length, 1, 'only prioritizeEntry itself builds the /prioritize URL');
});
