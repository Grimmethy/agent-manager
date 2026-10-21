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

test('foreign action note names the project to switch to', () => {
  assert.match(bp.branchForeignActionNoteHtml(mk('1', 'storyforge', false)), /switch to <strong>storyforge<\/strong>/);
});
