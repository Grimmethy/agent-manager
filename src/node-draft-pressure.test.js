'use strict';

// node-draft-pressure.js: a draft another machine built may be reviewed when the memory marker is critical only through the swap backstop.
// Run: node --test src/node-draft-pressure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { nodeDraftMayRunUnderPressure, hasNodeDraftReview } = require('./node-draft-pressure.js');
const SWAP_ONLY = { swap_free_mb: 0, available_mb: 2190, mem_full: 0.72, io_full: 1.19 };
const ndp = (over = {}, extra = {}) => nodeDraftMayRunUnderPressure({ state: 'critical', numbers: { ...SWAP_ONLY, ...over }, hasNodeDraftReview: true, env: {}, ...extra });

test('nodeDraftMayRunUnderPressure: the live 2026-11-12 marker (critical, swap gone, 2190 MB free, no stall) with a node draft waiting runs', () => {
  assert.equal(ndp(), true);
});

test('nodeDraftMayRunUnderPressure: each condition alone flips the answer to false', () => {
  assert.equal(ndp({}, { state: 'tight' }), false, 'only critical');
  assert.equal(ndp({}, { state: 'ok' }), false);
  assert.equal(ndp({}, { hasNodeDraftReview: false }), false, 'a node draft must wait');
  assert.equal(ndp({}, { hasNodeDraftReview: 'yes' }), false, 'only a real true counts');
  assert.equal(ndp({ swap_free_mb: 128 }), false, 'swap not gone: critical came from elsewhere');
  assert.equal(ndp({ swap_free_mb: 127 }), true, 'just under the backstop line still runs');
  assert.equal(ndp({ available_mb: 1023 }), false, 'under 1024 MB free');
  assert.equal(ndp({ available_mb: 1024 }), true, 'boundary: 1024 MB runs');
  assert.equal(ndp({ mem_full: 5 }), false, 'memory full stall');
  assert.equal(ndp({ mem_full: 4.99 }), true);
  assert.equal(ndp({ io_full: 10 }), false, 'io full stall');
  assert.equal(ndp({ io_full: 9.99 }), true);
});

test('nodeDraftMayRunUnderPressure: missing or non-numeric numbers fail closed; the kill switch restores the old answer', () => {
  for (const k of ['swap_free_mb', 'available_mb', 'mem_full', 'io_full']) {
    assert.equal(ndp({ [k]: undefined }), false, `${k} missing`);
    assert.equal(ndp({ [k]: '1' }), false, `${k} as a string`);
    assert.equal(ndp({ [k]: NaN }), false, `${k} NaN`);
  }
  assert.equal(nodeDraftMayRunUnderPressure({ state: 'critical', hasNodeDraftReview: true, env: {} }), false, 'no numbers at all');
  assert.equal(ndp({}, { env: { AGENT_MANAGER_NODE_DRAFT_REVIEW_UNDER_SWAP_CRITICAL: 'false' } }), false);
  assert.equal(ndp({}, { env: { AGENT_MANAGER_NODE_DRAFT_REVIEW_UNDER_SWAP_CRITICAL: 'FALSE' } }), false);
  assert.equal(ndp({}, { env: { AGENT_MANAGER_NODE_DRAFT_REVIEW_UNDER_SWAP_CRITICAL: 'true' } }), true);
});

test('node-draft-pressure.js command line: exit 0 only with a fromNode record in the home review/ and swap-only critical numbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-draft-'));
  try {
    fs.mkdirSync(path.join(dir, 'queue', 'review'), { recursive: true });
    const cli = path.join(__dirname, 'node-draft-pressure.js');
    const code = (...rest) => { try { execFileSync('node', [cli, dir, ...rest], { stdio: 'pipe' }); return 0; } catch (err) { return err.status; } };
    const args = ['critical', '0', '2190', '0.72', '1.19'];
    assert.equal(code(...args), 1, 'no record waiting');
    fs.writeFileSync(path.join(dir, 'queue', 'review', 'plain.json'), JSON.stringify({ id: 'plain' }));
    fs.writeFileSync(path.join(dir, 'queue', 'review', 'empty.json'), JSON.stringify({ id: 'e', fromNode: '' }));
    assert.equal(hasNodeDraftReview(dir), false, 'a record without a node name is not a node draft');
    assert.equal(code(...args), 1);
    fs.writeFileSync(path.join(dir, 'queue', 'review', 'draft.json'), JSON.stringify({ id: 'd', fromNode: 'grimm' }));
    assert.equal(hasNodeDraftReview(dir), true);
    assert.equal(code(...args), 0, 'swap-only critical with a node draft waiting runs');
    assert.equal(code('tight', '0', '2190', '0.72', '1.19'), 1);
    assert.equal(code('critical', '0', '900', '0.72', '1.19'), 1, 'under 1024 MB free');
    assert.equal(code('critical', '0', '2190', '0.72', '12'), 1, 'io full stall');
    assert.equal(code('critical', '0', '2190', '0.72'), 1, 'a missing number fails closed');
    assert.equal(hasNodeDraftReview(path.join(dir, 'nope')), false, 'no review dir is not a node draft');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('review-runner.sh asks nodeDraftMayRunUnderPressure only for a critical marker, after the premium question and before it yields, and limits that tick to node drafts', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'review-runner.sh'), 'utf8');
  const premium = sh.indexOf('--premium-under-pressure "$PIPELINE_DIR" "$mem_state"');
  const node = sh.indexOf('node-draft-pressure.js" "$PIPELINE_DIR" "$mem_state"');
  const yieldMsg = sh.indexOf('yielding this tick -- host RAM pressure');
  assert.ok(premium > 0 && node > premium && yieldMsg > node, 'premium first, then node drafts, then the yield');
  assert.match(sh, /elif \[\[ "\$mem_state" == critical \]\] && node/, 'asked only when the marker is critical');
  for (const key of ['swap_free_mb', 'available_mb', 'mem_full', 'io_full']) assert.ok(sh.includes(`mem_marker_num ${key}`), `passes ${key} from the marker`);
  assert.match(sh, /TICK_NODE_DRAFT_ONLY=true; UNDER_PRESSURE=true/);
  assert.equal((sh.match(/TICK_NODE_DRAFT_ONLY=false/g) || []).length, 1, 'reset once per tick, in the same line as the premium flag');
  assert.match(sh, /UNDER_PRESSURE=false; TICK_NODE_DRAFT_ONLY=false/);
  assert.match(sh, /if "\$TICK_NODE_DRAFT_ONLY"; then ls -1tr "\$review_dir" 2>\/dev\/null \| filter_node_draft_names/, 'the item list is limited to node drafts on that tick');
  assert.match(sh, /swap-only critical memory pressure: reviewing node draft %s anyway/);
});
