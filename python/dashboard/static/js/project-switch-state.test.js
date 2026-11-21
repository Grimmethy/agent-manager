'use strict';

// Run: node --test python/dashboard/static/js/project-switch-state.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectSwitchState, renderProjectSwitchNoticeHtml } = require('./project-switch-state.js');

test('selected differs from the running pipeline: differs state, notice and Switch button rendered', () => {
  const sel = 'C:\\proj\\feature-forge';
  const act = 'C:\\proj\\questforge';
  const r = projectSwitchState(sel, act, true);
  assert.equal(r.state, 'differs');
  assert.equal(r.selectedName, 'feature-forge');
  assert.equal(r.activeName, 'questforge');
  const html = renderProjectSwitchNoticeHtml(sel, act, true);
  assert.match(html, /Pipeline still running against/);
  assert.match(html, /switch-project-btn/);
});

test('selected equals active while running: match, no notice', () => {
  assert.equal(projectSwitchState('C:\\proj\\A', 'C:\\proj\\A', true).state, 'match');
  const html = renderProjectSwitchNoticeHtml('C:\\proj\\A', 'C:\\proj\\A', true);
  assert.equal(html, '');
  assert.doesNotMatch(html, /still running/);
});

test('no pipeline running: none, no notice', () => {
  assert.equal(projectSwitchState('C:\\proj\\A', 'C:\\proj\\B', false).state, 'none');
  assert.equal(renderProjectSwitchNoticeHtml('C:\\proj\\A', 'C:\\proj\\B', false), '');
});

test('slash and case differences on the same path: match', () => {
  assert.equal(projectSwitchState('C:/proj/A', 'c:\\proj\\a', true).state, 'match');
});
