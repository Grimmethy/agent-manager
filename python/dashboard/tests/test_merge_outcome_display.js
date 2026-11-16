// Source-level check for the merge handler's outcome display (node:test, no framework).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'static', 'js', 'branches-joblist-hardware-tabs.js'),
  'utf8'
);

test('merge handler shows the outcome before the restartTriggered branch, so synced:false alerts with restartTriggered:false', () => {
  const h = src.slice(src.indexOf('const outcome = typeof mergeOutcomeText'));
  const alertIdx = h.indexOf('if (shown) alert(shown);');
  const restartIdx = h.indexOf('if (result.liveSync && result.liveSync.restartTriggered)');
  assert.ok(alertIdx > 0, 'alert call must exist in the merge handler');
  assert.ok(restartIdx > alertIdx, 'alert must come before the restart branch');
});

test('synced:false with no reason still produces non-empty alert text via the fallback', () => {
  assert.ok(
    src.includes("'Merged, but the live dashboard was not synced (no reason given).'"),
    'fallback text for synced:false must be present'
  );
});

test('the dismissal event is dispatched after the alert call', () => {
  const alertIdx = src.indexOf('if (shown) alert(shown);');
  const evtIdx = src.indexOf("new CustomEvent('merge-outcome-dismissed'");
  assert.ok(evtIdx > alertIdx && alertIdx > 0);
});
