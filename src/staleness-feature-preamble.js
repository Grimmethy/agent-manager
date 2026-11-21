'use strict';
// JS port of the feature-preamble helpers (HUB0498). Pure functions, no I/O.
// Two records are siblings when they share at least one feature signal:
//   promptContext.decomposedFrom, promptContext.featureSlug, parentHub,
//   an HUBn id prefix, the same stacked.branch, or one lists the other in subTasks.
// Missing or empty fields never match.

const PREAMBLE_MARKER = /^this piece is part of\b/i;

function nonEmptyStr(v) { return typeof v === 'string' && v.trim() !== ''; }

// Drops leading paragraphs that carry the 'This piece is part of ...' feature preamble.
function stripFeaturePreamble(text) {
  const paras = String(text == null ? '' : text).split(/\n\s*\n/);
  while (paras.length && PREAMBLE_MARKER.test(paras[0].trim())) paras.shift();
  return paras.join('\n\n');
}

// Namespaced feature signals for one record (a Set of strings).
function featureSignals(t) {
  const out = new Set();
  if (!t || typeof t !== 'object') return out;
  const pc = t.promptContext && typeof t.promptContext === 'object' ? t.promptContext : {};
  if (nonEmptyStr(pc.decomposedFrom)) out.add(`decomposedFrom:${pc.decomposedFrom}`);
  if (nonEmptyStr(pc.featureSlug)) out.add(`featureSlug:${pc.featureSlug}`);
  if (nonEmptyStr(t.parentHub)) out.add(`parentHub:${t.parentHub}`);
  const m = /^(HUB\d+)[-_]/.exec(String(t.id || ''));
  if (m) out.add(`hub:${m[1]}`);
  if (t.stacked && typeof t.stacked === 'object' && nonEmptyStr(t.stacked.branch)) out.add(`branch:${t.stacked.branch}`);
  return out;
}

// Returns the first shared feature or chain key when a and b are siblings, else null.
function sharedFeatureKey(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return null;
  if (nonEmptyStr(a.id) && a.id === b.id) return null;
  const sa = featureSignals(a);
  const sb = featureSignals(b);
  for (const k of sa) if (sb.has(k)) return k;
  const subA = Array.isArray(a.subTasks) ? a.subTasks : [];
  const subB = Array.isArray(b.subTasks) ? b.subTasks : [];
  if (nonEmptyStr(b.id) && subA.includes(b.id)) return `chain:${a.id}`;
  if (nonEmptyStr(a.id) && subB.includes(a.id)) return `chain:${b.id}`;
  return null;
}

function siblingsShareFeatureOrChain(a, b) {
  return sharedFeatureKey(a, b) !== null;
}

module.exports = { stripFeaturePreamble, siblingsShareFeatureOrChain, sharedFeatureKey };
