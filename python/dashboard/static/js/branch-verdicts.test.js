'use strict';

// Tests for branch-verdicts.js (the Unmerged Branches verdict rendering helpers). Pure functions, no DOM.
// Run: node --test python/dashboard/static/js/branch-verdicts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { branchVerdictKey, branchVerdictBorderStyle, branchVerdictBadgeHtml, branchVerdictDetailHtml, filterBranchesByVerdict, branchVerdictFilterBarHtml } = require('./branch-verdicts.js');

const B = (verdict, extra = {}) => ({ branch: 'agent/x', verdict, reasons: ['r1', 'r2'], source: 'manual', stale: false, ...extra });

test('hold: its own badge and filter bucket, distinct from needs-work', () => {
  assert.equal(branchVerdictKey(B('hold')), 'hold');
  assert.match(branchVerdictBadgeHtml(B('hold')), /class="badge hold" data-verdict="hold"/);
  assert.equal(branchVerdictKey(B('hold', { stale: true })), 'unverified');
  const list = [B('needs-work'), B('hold'), B('hold'), B('merge')];
  assert.equal(filterBranchesByVerdict(list, 'hold').length, 2);
  assert.equal(filterBranchesByVerdict(list, 'needs-work').length, 1);
  assert.match(branchVerdictFilterBarHtml(list, 'all'), /Hold \(2\)/);
});

test('the card border is the shared blue for every verdict: the verdict shows in the badge, not the border', () => {
  for (const v of ['merge', 'needs-work', 'hold', 'discard', null]) assert.equal(branchVerdictBorderStyle(B(v)), '', String(v));
  assert.equal(branchVerdictBorderStyle(B('merge', { stale: true })), '');
  assert.equal(branchVerdictBorderStyle(), '');
  assert.match(branchVerdictBadgeHtml(B('merge')), /class="badge ok" data-verdict="merge"/);
  assert.match(branchVerdictBadgeHtml(B('needs-work')), /class="badge warn" data-verdict="needs-work"/);
  assert.match(branchVerdictBadgeHtml(B('discard')), /class="badge bad" data-verdict="discard"/);
  assert.match(branchVerdictBadgeHtml(B(null)), /class="badge idle" data-verdict="unverified"/);
});

test('a stale verdict is grey/unverified and shows the older-commit note', () => {
  const b = B(null, { stale: true, reasons: ['verdict is for an older commit'] });
  assert.equal(branchVerdictKey(b), 'unverified');
  assert.match(branchVerdictBadgeHtml(b), /verdict is for an older commit/);
});

test('even a stale record that still names a verdict renders as unverified, not green', () => {
  assert.equal(branchVerdictKey(B('merge', { stale: true })), 'unverified');
});

test('badge shows the verdict word and only the first reason; detail lists them all', () => {
  const badge = branchVerdictBadgeHtml(B('discard'));
  assert.match(badge, />discard</);
  assert.match(badge, /r1/);
  assert.doesNotMatch(badge, /r2/);
  const detail = branchVerdictDetailHtml(B('discard'));
  assert.match(detail, /r1/);
  assert.match(detail, /r2/);
});

test('reasons are HTML-escaped', () => {
  assert.doesNotMatch(branchVerdictBadgeHtml(B('needs-work', { reasons: ['<script>x</script>'] })), /<script>/);
});

test('filter buckets: All / Unverified / Ready to merge / Needs work / Discard', () => {
  const list = [B('merge'), B('needs-work'), B('discard'), B(null), B('merge', { stale: true })];
  assert.equal(filterBranchesByVerdict(list, 'all').length, 5);
  assert.equal(filterBranchesByVerdict(list, 'unverified').length, 2);
  assert.equal(filterBranchesByVerdict(list, 'merge').length, 1);
  assert.equal(filterBranchesByVerdict(list, 'needs-work').length, 1);
  assert.equal(filterBranchesByVerdict(list, 'discard').length, 1);
});

test('filter bar shows counts and marks the active filter', () => {
  const html = branchVerdictFilterBarHtml([B('merge'), B(null)], 'merge');
  assert.match(html, /All \(2\)/);
  assert.match(html, /Ready to merge \(1\)/);
  assert.match(html, /Unverified \(1\)/);
  assert.match(html, /class="action" data-verdict-filter="merge"/);
});

test('heldHubsHtml: empty placeholder when nothing is held, one row per held hub naming what it waits on', () => {
  const { heldHubsHtml } = require('./branch-verdicts.js');
  assert.equal(heldHubsHtml([]), '<div data-held-hubs></div>');
  const html = heldHubsHtml([{ hubId: 'h', title: 'HUB0113 <x>', progress: { built: 2, total: 4 }, waitingOn: ['HUB0113-03'], branches: ['a', 'b'] }]);
  assert.match(html, /<b>Hubs \(1\)<\/b>/);
  assert.match(html, /2 of 4 built, 2 held, waiting on HUB0113-03/);
  assert.ok(!html.includes('<x>'), 'hub title is escaped');
});

// ---- Discard all (owner request 2026-10-31) ----
const dv = require('./branch-verdicts.js');
globalThis.branchProjectRequestRoot = require('./branch-projects.js').branchProjectRequestRoot;
const D = (name, extra = {}) => ({ ...B('discard'), branch: name, headSha: 'sha-' + name, project: { active: true, label: 'agent-manager', repoRoot: '/r/am' }, ...extra });

test('discard all: the button shows only on the Discard filter and counts current discard verdicts', () => {
  const list = [D('agent/a'), D('agent/b'), B('merge'), B('needs-work')];
  assert.match(branchVerdictFilterBarHtml(list, 'discard'), /data-discard-all[^>]*>Discard all \(2\)</);
  assert.doesNotMatch(branchVerdictFilterBarHtml(list, 'all'), /data-discard-all/);
  assert.doesNotMatch(branchVerdictFilterBarHtml(list, 'merge'), /data-discard-all/);
  assert.doesNotMatch(branchVerdictFilterBarHtml([B('merge')], 'discard'), /data-discard-all/, 'no discard cards, no button');
});

test('discard all: a stale discard verdict (older commit) is never counted or sent', () => {
  const list = [D('agent/a'), D('agent/stale', { stale: true })];
  assert.deepEqual(dv.discardAllCandidates(list).map((b) => b.branch), ['agent/a']);
  assert.match(branchVerdictFilterBarHtml(list, 'discard'), /Discard all \(1\)/);
  assert.deepEqual(dv.discardAllPayload(dv.discardAllCandidates(list), false).branches.map((x) => x.branch), ['agent/a']);
});

test('discard all: triage-queue is left out by default and only joins when the owner opts in', () => {
  const list = [D('agent/a'), D('agent/triage-queue')];
  assert.deepEqual(dv.discardAllCandidates(list, false).map((b) => b.branch), ['agent/a']);
  assert.deepEqual(dv.discardAllCandidates(list, true).map((b) => b.branch), ['agent/a', 'agent/triage-queue']);
  assert.match(branchVerdictFilterBarHtml(list, 'discard'), /Discard all \(1\)/);
  assert.equal(dv.discardAllPayload(dv.discardAllCandidates(list, false), false).includeTriage, false);
  assert.equal(dv.discardAllPayload(dv.discardAllCandidates(list, true), true).includeTriage, true);
});

test('discard all: the payload carries each branch, its project root (empty for the active project) and the head sha the owner saw', () => {
  const other = D('agent/o', { project: { active: false, label: 'questforge', repoRoot: '/r/qf' } });
  const p = dv.discardAllPayload([D('agent/a'), other], false);
  assert.deepEqual(p.branches, [{ branch: 'agent/a', project: '', sha: 'sha-agent/a' }, { branch: 'agent/o', project: '/r/qf', sha: 'sha-agent/o' }]);
});

test('discard all: the dialog states the count, lists at most 15 names with their project, says PERMANENTLY DELETES and refs/discarded, and asks for the number', () => {
  const many = Array.from({ length: 20 }, (_, i) => D('agent/n' + i, i === 3 ? { project: { active: false, label: 'questforge', repoRoot: '/r/qf' } } : {}));
  const t = dv.discardAllDialogText(many);
  assert.match(t, /^Discard 20 branches\?/);
  assert.equal((t.match(/^  - agent\/n/gm) || []).length, 15);
  assert.match(t, /\.\.\. and 5 more/);
  assert.match(t, /agent\/n3 \[questforge\]/);
  assert.doesNotMatch(t, /agent\/n0 \[/, 'the active project is not annotated');
  assert.match(t, /PERMANENTLY DELETES the remote branches/);
  assert.match(t, /refs\/discarded\/\*/);
  assert.match(t, /Type 20 to confirm:$/);
  assert.match(dv.discardAllDialogText([D('agent/one')]), /^Discard 1 branch\?/);
});

test('discard all: pieces of a hub that is still open are named in the dialog, finished hubs are not', () => {
  const open = D('agent/hub-piece', { hub: { id: 'HUB0042', state: 'coordinating' } });
  const done = D('agent/old-piece', { hub: { id: 'HUB0001', state: 'done' } });
  const t = dv.discardAllDialogText([open, done, D('agent/plain')]);
  assert.match(t, /WARNING: 1 of these is a piece of a hub that is still open/);
  assert.match(t, /agent\/hub-piece \(hub HUB0042, coordinating\)/);
  assert.doesNotMatch(t, /hub HUB0001/);
  assert.doesNotMatch(dv.discardAllDialogText([done, D('agent/plain')]), /WARNING/);
});

test('discard all: only the typed count confirms', () => {
  assert.equal(dv.discardAllConfirmOk('20', 20), true);
  assert.equal(dv.discardAllConfirmOk(' 20 ', 20), true);
  for (const bad of ['19', '', null, undefined, 'yes', '20x']) assert.equal(dv.discardAllConfirmOk(bad, 20), false, String(bad));
});

test('discard all: the result reads "Discarded X of N" and lists each failure with its reason', () => {
  const r = { results: [{ branch: 'agent/a', succeeded: true }, { branch: 'agent/b', succeeded: false, reason: 'head moved' }, { branch: 'agent/c', succeeded: true }] };
  assert.equal(dv.discardAllResultText(r), 'Discarded 2 of 3\n  - agent/b: head moved');
  assert.equal(dv.discardAllResultText({ results: [] }), 'Discarded 0 of 0');
});

test('discard all: the bar is a flex container and only the Discard-all button is pushed right, inset like the card buttons', () => {
  const list = [D('agent/a'), D('agent/b')];
  const html = branchVerdictFilterBarHtml(list, 'discard');
  assert.match(html, /data-verdict-filter-bar style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;/);
  assert.equal(dv.DISCARD_ALL_INSET_PX, 18, 'card border 2px + padding 16px');
  assert.match(html, /<button class="secondary" data-discard-all style="margin-left:auto;margin-right:18px"/);
  assert.equal((html.match(/margin-left:auto/g) || []).length, 1, 'no filter chip is pushed right');
  assert.doesNotMatch(branchVerdictFilterBarHtml(list, 'all'), /margin-left:auto/);
});
