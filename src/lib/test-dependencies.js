'use strict';

// Pure helpers that link a decomposed "tests" child to the sibling whose
// behavior it exercises. No I/O, timers or scheduler imports.
//
// A proposal looks like { id, title, rawText, kind?, dependsOn? }.
// dependsOn holds a sibling's task id; null means no edge.

// A child is a "tests" child when kind === 'tests'. As a fallback (EXTRAPOLATION:
// proposals may not carry a kind yet) a title that leads with a test word counts.
const TEST_TITLE_RE = /^\s*(?:(?:add|write|create|update|extend)\s+)?(?:\w+\s+)?tests?\b/i;
const FILE_RE = /[\w./-]*[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|json|md|sh|css|html)\b/gi;
const ASSERT_RE = /\b(?:assert(?:s|ing)?|verif(?:y|ies|ying)|expect(?:s|ing)?|returns?|should|tests? that|ensure(?:s)?|checks? that)\b/i;

function isTestsChild(p) {
  if (!p) return false;
  if (p.kind === 'tests') return true;
  if (p.kind) return false;
  return TEST_TITLE_RE.test(String(p.title || ''));
}

function textOf(p) {
  return `${(p && p.title) || ''}\n${(p && p.rawText) || ''}`.toLowerCase();
}

function basenames(text) {
  const out = new Set();
  const matches = String(text).match(FILE_RE) || [];
  for (const m of matches) {
    const base = m.split('/').pop().toLowerCase();
    if (base) out.add(base);
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWord(haystack, needle) {
  if (!needle) return false;
  return new RegExp(`(?:^|[^\\w-])${escapeRe(needle)}(?![\\w-])`, 'i').test(haystack);
}

// Does the tests child's text name this (non-test) sibling? Matches by sibling
// id, by a file basename the sibling mentions, or by its full title.
function namesSibling(child, sibling) {
  const text = textOf(child);
  if (sibling.id && containsWord(text, String(sibling.id).toLowerCase())) return true;
  const sibTitle = String(sibling.title || '').trim().toLowerCase();
  if (sibTitle.length >= 8 && text.includes(sibTitle)) return true;
  for (const base of basenames(textOf(sibling))) {
    if (containsWord(text, base)) return true;
  }
  return false;
}

function matchesFor(proposals, index) {
  const child = proposals[index];
  const matches = [];
  for (let j = 0; j < proposals.length; j++) {
    if (j === index) continue;
    const sib = proposals[j];
    if (isTestsChild(sib)) continue;
    if (namesSibling(child, sib)) matches.push(j);
  }
  return matches;
}

// Returns { proposals, unresolved }. Input is never mutated and an existing
// dependsOn is never overridden. Zero matches leaves dependsOn null without
// reporting (no ambiguity); several matches use the nearest preceding
// non-test child as tiebreak, else dependsOn stays null and the child is
// listed in unresolved.
function inferTestDependsOn(proposals) {
  const list = Array.isArray(proposals) ? proposals : [];
  const unresolved = [];
  const out = list.map((p, i) => {
    const copy = { ...p };
    if (!isTestsChild(p)) return copy;
    if (p.dependsOn !== undefined && p.dependsOn !== null) return copy;
    const matches = matchesFor(list, i);
    if (matches.length === 0) {
      copy.dependsOn = null;
      return copy;
    }
    if (matches.length === 1) {
      copy.dependsOn = list[matches[0]].id;
      return copy;
    }
    let nearest = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (!isTestsChild(list[j])) { nearest = j; break; }
    }
    if (nearest >= 0 && matches.includes(nearest)) {
      copy.dependsOn = list[nearest].id;
      return copy;
    }
    copy.dependsOn = null;
    unresolved.push(p.id);
    return copy;
  });
  return { proposals: out, unresolved };
}

// Returns { ok, errors }. A tests child that names a non-test sibling and
// asserts behavior (assertion verb) must have a dependsOn edge to a named sibling.
function validateTestDependencies(proposals) {
  const list = Array.isArray(proposals) ? proposals : [];
  const errors = [];
  list.forEach((p, i) => {
    if (!isTestsChild(p)) return;
    if (!ASSERT_RE.test(textOf(p))) return;
    const matches = matchesFor(list, i);
    if (matches.length === 0) return;
    const ids = matches.map((j) => list[j].id);
    if (p.dependsOn && ids.includes(p.dependsOn)) return;
    errors.push(
      `tests child ${p.id} asserts behavior of sibling ${ids.join(' / ')} but has no dependsOn edge to it`
    );
  });
  return { ok: errors.length === 0, errors };
}

module.exports = { inferTestDependsOn, validateTestDependencies };
