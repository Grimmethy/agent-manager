'use strict';

// This file's FIRST test coverage (2026-09-27), mirroring core-ui.test.js's own precedent
// (its own header: "the FIRST test coverage this file has ever had", achieved by
// exporting one small, DOM-free function). renderConceptCard returns a plain HTML string
// with no direct DOM calls inside it -- testable the same way once exported.
//
// This module-scope code references several globals defined by OTHER plain <script> tags
// loaded before it in index.html (escapeHtml/escapeAttr in core-ui.js,
// renderReportMarkdown in analytics-and-discovery.js, CONCEPT_STABLE_STATUSES inline in
// index.html itself, line ~714) -- in the browser they share one global scope; in Node
// they must be stubbed onto `global` before require(), since each file is its own CommonJS
// module with no shared scope otherwise. Real behavior (escaping, markdown rendering) is
// deliberately not re-tested here -- these are simple, behavior-preserving stand-ins whose
// only job is to let renderConceptCard run at all; escapeHtml/escapeAttr pass text through
// unchanged so the assertions below can match on plain substrings.

global.escapeHtml = (s) => String(s == null ? '' : s);
global.escapeAttr = (s) => String(s == null ? '' : s);
global.renderReportMarkdown = (s) => String(s == null ? '' : s);
global.CONCEPT_STABLE_STATUSES = new Set(['shelved', 'shipped']);

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderConceptCard } = require('./concepts-and-adhoc-tab.js');

const LIFECYCLE_CONCEPT_ID = 'concept-adhoc-task-lifecycle-64935e';
const GHOST_CONCEPT_ID = 'concept-ghost-in-the-machine-0dbeea';

function baseConcept(id, overrides = {}) {
  return {
    id,
    name: 'Some Concept',
    description: 'a description',
    status: 'open',
    researchForkCount: 0,
    builtFromScratchCount: 0,
    adaptedFromResourceCount: 0,
    linkedTaskCount: 0,
    ...overrides,
  };
}

test('renderConceptCard: the Adhoc Task Lifecycle concept renders the real flow-chart panel', () => {
  const html = renderConceptCard(baseConcept(LIFECYCLE_CONCEPT_ID, { name: 'Adhoc Task Lifecycle' }));
  // A handful of the real stage labels and the real function/field names each box cites --
  // proves this is the actual lifecycle content, not just any non-empty panel.
  assert.match(html, /pending \/ adhoc/);
  assert.match(html, /queueAdhocTask/);
  assert.match(html, /drafting \/ orient/);
  assert.match(html, /runOrientPass/);
  assert.match(html, /orientNotes/);
  assert.match(html, /reviewTask/);
  assert.match(html, /applyTask/);
  assert.match(html, /done \/ blocked/);
});

test('renderConceptCard: every OTHER concept id -- including the pre-existing ghost-in-the-machine one -- renders WITHOUT the lifecycle panel', () => {
  const ghostHtml = renderConceptCard(baseConcept(GHOST_CONCEPT_ID, { name: 'Ghost in the Machine' }));
  assert.doesNotMatch(ghostHtml, /pending \/ adhoc/);
  assert.doesNotMatch(ghostHtml, /queueAdhocTask/);
  // The ghost panel itself must still render, unaffected by this change.
  assert.match(ghostHtml, /ghost-telemetry/);

  const otherHtml = renderConceptCard(baseConcept('concept-some-other-thing-abc123', { name: 'Something Else' }));
  assert.doesNotMatch(otherHtml, /pending \/ adhoc/);
  assert.doesNotMatch(otherHtml, /ghost-telemetry/);
});

test('renderConceptCard: an ordinary concept (no special id) still renders its normal card content unaffected', () => {
  const html = renderConceptCard(baseConcept('concept-normal-thing-abc123', {
    name: 'A Normal Concept',
    description: 'ordinary description text',
  }));
  assert.match(html, /A Normal Concept/);
  assert.match(html, /ordinary description text/);
  assert.match(html, /data-view-timeline/);
});
