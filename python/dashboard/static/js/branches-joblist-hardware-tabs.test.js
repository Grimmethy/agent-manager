const test = require('node:test');
const assert = require('node:assert/strict');

// HUB0185 2/2: re-enable the hub badge on other projects' branch cards and forward the
// card's project label as the task-anywhere project hint.
//
// The tab file is a plain browser <script>; it exposes branchCardHtml/wireBranchCard
// through a module.exports guard, and this test stubs the browser-global helpers it
// calls at render time (the real ones from branch-projects.js / branch-verdicts.js,
// which are themselves Node-safe, where they exist).
const bp = require('./branch-projects.js');
const bv = require('./branch-verdicts.js');

globalThis.branchIsActiveProject = bp.branchIsActiveProject;
globalThis.branchRowKey = bp.branchRowKey;
globalThis.branchProjectChipHtml = bp.branchProjectChipHtml;
globalThis.branchProjectRequestRoot = bp.branchProjectRequestRoot;
globalThis.branchVerdictKey = bv.branchVerdictKey;
globalThis.branchVerdictBorderStyle = bv.branchVerdictBorderStyle;
globalThis.branchVerdictBadgeHtml = bv.branchVerdictBadgeHtml;
globalThis.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
globalThis.escapeHtmlBright = (s) => String(s == null ? '' : s);
globalThis.fmtAge = (sec) => sec + 's';
globalThis.fetchJson = async () => { throw new Error('no network in tests'); };
globalThis.renderBranchDetailModal = () => {};

const { branchCardHtml, wireBranchCard } = require('./branches-joblist-hardware-tabs.js');

const FOREIGN = {
  branch: 'agent/x',
  title: 'Foreign branch',
  project: { label: 'OtherProj', active: false, repoRoot: '/r/other' },
  hub: { id: 'HUB123', progress: { done: 1, total: 2 }, integrationGate: { status: 'pass' } },
  ahead: 2,
  behind: 0,
  willConflict: false,
  conflictFiles: [],
  pushedAt: new Date().toISOString(),
  matchedTaskState: 'pending',
  mainBranch: 'main',
  domain: 'd',
  source: 's',
  description: 'desc',
};

test('foreign-project card keeps its clickable hub badge (suppression removed)', () => {
  assert.equal(bp.branchIsActiveProject(FOREIGN), false); // sanity: this IS a foreign card
  const html = branchCardHtml(FOREIGN);
  assert.match(html, /data-open-hub="HUB123"/);
  assert.match(html, /cursor:pointer/);
  assert.match(html, /hub mid-flight/);
});

test('active-project card still keeps its hub badge', () => {
  const html = branchCardHtml({ ...FOREIGN, project: { label: 'Active', active: true, repoRoot: '/r/active' } });
  assert.match(html, /data-open-hub="HUB123"/);
});

test('card element carries its project label', () => {
  assert.match(branchCardHtml(FOREIGN), /data-project-label="OtherProj"/);
  assert.match(
    branchCardHtml({ ...FOREIGN, project: { label: 'Active', active: true, repoRoot: '/r/active' } }),
    /data-project-label="Active"/,
  );
  // A label with a double quote is attribute-escaped and cannot break out of the value.
  assert.match(
    branchCardHtml({ ...FOREIGN, project: { label: 'Ev"il', active: false, repoRoot: '/r/e' } }),
    /data-project-label="Ev&quot;il"/,
  );
});

test('badge click forwards the card project label as the openTaskAnywhere hint', () => {
  const calls = [];
  globalThis.openTaskAnywhere = (id, hint) => calls.push([id, hint]);
  const badge = { dataset: { openHub: 'HUB123' }, onclick: null };
  const card = {
    dataset: { openBranch: '/r/other|agent/x', projectLabel: 'OtherProj' },
    querySelector: (sel) => (sel === '[data-open-hub]' ? badge : null),
    onclick: null,
  };
  wireBranchCard(card);
  assert.equal(typeof badge.onclick, 'function');
  badge.onclick({ stopPropagation() {} });
  assert.deepEqual(calls, [['HUB123', 'OtherProj']]);
});

test('data-open-hub value is unchanged (still the hub id) when the badge is wired', () => {
  const html = branchCardHtml(FOREIGN);
  const id = html.match(/data-open-hub="([^"]*)"/);
  assert.ok(id, 'badge present');
  assert.equal(id[1], 'HUB123');
});
