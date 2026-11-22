'use strict';
// Run: node --test python/dashboard/static/js/branch-projects.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const bp = require('./branch-projects.js');

const mk = (branch, label, active, root) => ({ branch, project: { label, active, repoRoot: root || '/r/' + label } });

test('rows without a project tag count as the active project', () => {
  assert.equal(bp.branchIsActiveProject({ branch: 'agent/x' }), true);
  assert.equal(bp.branchIsActiveProject(mk('agent/x', 'p', false)), false);
  assert.equal(bp.branchIsActiveProject(mk('agent/x', 'p', true)), true);
});

test('row key separates the same branch name in two projects', () => {
  assert.notEqual(bp.branchRowKey(mk('agent/triage-queue', 'a', true)), bp.branchRowKey(mk('agent/triage-queue', 'b', false)));
});

test('a project always gets the same color', () => {
  assert.equal(bp.branchProjectHue('storyforge'), bp.branchProjectHue('storyforge'));
  assert.notEqual(bp.branchProjectHue('storyforge'), bp.branchProjectHue('promptforge'));
});

test('unpinned repos keep the hue the hash always gave them', () => {
  assert.equal(bp.branchProjectHue('storyforge'), 58);
  assert.equal(bp.branchProjectHue('promptforge'), 155);
  assert.equal(bp.branchProjectHue('crosslister'), 163);
  assert.equal(bp.branchProjectHue(''), 0);
  assert.equal(bp.branchProjectHue(undefined), 0);
});

test('the daily repos are pinned, and the pins win over the hash', () => {
  assert.deepEqual(bp.BRANCH_PROJECT_PINS, {
    questforge: 133, 'agent-manager': 253, tokenfold: 186, 'pf-backend': 221, uiforge: 279, 'agent-manager-chat-plugin-am': 160,
    'lead-call-desk': 71, 'pf-admin-ui': 107, 'taxharvest-scrapers': 305, 'trade-calculator': 331, uxforge: 15,
  });
  assert.equal(bp.branchProjectHue('uiforge'), 279);
  assert.equal(bp.branchProjectHue('uxforge'), 15);
  assert.ok(Number.isInteger(bp.branchProjectHue('toString')), 'a label named like an Object method still gets a numeric hue');
  assert.ok(Number.isInteger(bp.branchProjectHue('constructor')));
});

test('pinned hues are at least 26 degrees apart', () => {
  const hues = Object.values(bp.BRANCH_PROJECT_PINS);
  const dist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) assert.ok(dist(hues[i], hues[j]) >= 26, `${hues[i]} vs ${hues[j]}`);
});

test('project colour is hsl at saturation 55 and lightness 30 and white text stays readable for every hue', () => {
  assert.equal(bp.branchProjectColorCss('questforge'), 'hsl(133 55% 30%)');
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const rgb = (h, s, l) => { const a = s * Math.min(l, 1 - l); const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return [f(0), f(8), f(4)]; };
  let min = Infinity;
  for (let h = 0; h < 360; h++) {
    const [r, g, b] = rgb(h, 0.55, 0.3);
    min = Math.min(min, 1.05 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05));
  }
  assert.ok(min >= 4.5, `lowest ratio ${min}`);
});

test('chip and header use the shared colour', () => {
  assert.match(bp.branchProjectChipHtml(mk('a', 'questforge', true)), /background:hsl\(133 55% 30%\)/);
  const header = bp.branchProjectHeaderHtml({ project: { label: 'uiforge', active: false, repoRoot: '/r/uiforge' }, branches: [{}, {}] });
  assert.match(header, /background:hsl\(279 55% 30%\)/);
  assert.match(header, /2 branches/);
});

test('chip names the project, marks the active one and escapes the label', () => {
  assert.match(bp.branchProjectChipHtml(mk('a', 'chat', true)), /chat ● active/);
  assert.doesNotMatch(bp.branchProjectChipHtml(mk('a', 'chat', false)), /active</);
  assert.match(bp.branchProjectChipHtml(mk('a', '<b>x', false)), /&lt;b&gt;x/);
  assert.equal(bp.branchProjectChipHtml({ branch: 'a' }), '');
});

test('grouping keeps the server order and splits on project change', () => {
  const rows = [mk('1', 'a', true), mk('2', 'a', true), mk('3', 'b', false), mk('4', 'c', false)];
  assert.deepEqual(bp.groupBranchesByProject(rows).map((g) => [g.label, g.branches.length]), [['a', 2], ['b', 1], ['c', 1]]);
});

test('project headers appear only when more than one project is shown, or the only one is not active', () => {
  const card = (b) => `<i>${b.branch}</i>`;
  assert.doesNotMatch(bp.branchListWithProjectHeadersHtml([mk('1', 'a', true), mk('2', 'a', true)], card), /data-project-header/);
  assert.doesNotMatch(bp.branchListWithProjectHeadersHtml([{ branch: 'x' }], card), /data-project-header/);
  const multi = bp.branchListWithProjectHeadersHtml([mk('1', 'a', true), mk('2', 'b', false)], card);
  assert.equal((multi.match(/data-project-header/g) || []).length, 2);
  assert.ok(multi.indexOf('data-project-header="a"') < multi.indexOf('<i>1</i>') && multi.indexOf('<i>1</i>') < multi.indexOf('data-project-header="b"'));
  assert.match(bp.branchListWithProjectHeadersHtml([mk('1', 'b', false)], card), /data-project-header="b"/);
});

test('pending note lists the projects still being scanned, empty when none', () => {
  assert.equal(bp.branchProjectsPendingHtml([]), '');
  assert.match(bp.branchProjectsPendingHtml(['x', 'y']), /2 other projects.*x, y/);
});

test('only another project\'s card sends a project with merge and discard', () => {
  assert.equal(bp.branchProjectRequestRoot({ branch: 'agent/x' }), '');
  assert.equal(bp.branchProjectRequestRoot(mk('agent/x', 'a', true)), '');
  assert.equal(bp.branchProjectRequestRoot(mk('agent/x', 'pf', false, '/repos/pf')), '/repos/pf');
});

test('the action URL encodes the branch and appends the project only when one is given', () => {
  assert.equal(bp.branchActionUrl('agent/a b', 'merge', ''), '/api/git/branches/agent%2Fa%20b/merge');
  assert.equal(bp.branchActionUrl('agent/x', 'discard', '/repos/pf & co'), '/api/git/branches/agent%2Fx/discard?project=%2Frepos%2Fpf%20%26%20co');
});

test('the confirm text names the project for another project\'s card and is untouched for the active one', () => {
  const chip = { dataset: { projectChip: 'PF-Client-Portal' } };
  const row = { querySelector: (sel) => (sel === '[data-project-chip]' ? chip : null) };
  const btn = { dataset: { project: '/repos/pf' }, closest: (sel) => (sel === '[data-branch-row]' ? row : null) };
  const out = bp.branchConfirmWithProject('Discard "agent/x"?', btn);
  assert.match(out, /^PROJECT: PF-Client-Portal\n/);
  assert.match(out, /runs in \/repos\/pf/);
  assert.match(out, /Discard "agent\/x"\?$/);
  assert.equal(bp.branchConfirmWithProject('Discard "agent/x"?', { dataset: { project: '' } }), 'Discard "agent/x"?');
  assert.equal(bp.branchConfirmWithProject('msg', null), 'msg');
  assert.match(bp.branchConfirmWithProject('m', { dataset: { project: '/r' }, closest: () => null }), /^PROJECT: \/r\n/, 'no chip: falls back to the root');
});
