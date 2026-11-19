'use strict';

// Shared marker extraction helper (HUB0660 subtask 1/4).
//
// One pure function, extractMarkers(text, options). No I/O, no model calls, and no
// module imports at all. Callers supply anything environment-specific through options.
//
// Two parsing modes:
//
//   mode: 'inline' (default) -- single-line marker, first match only. Matches the
//     behaviour of src/concepts.js extractConceptBuildReport exactly when called with
//     no options:
//       option keys and defaults:
//         inlinePattern: /^CONCEPT-BUILD:\s*(scratch|adapted)\s*\|\s*(.+)$/im
//         resultKey:     'report'
//       return: { cleanText, report: { kind, detail } | null }
//       no match -> cleanText is the untouched source (no collapse, no trim).
//       match    -> strips match[0] only, collapses \n{3,}, trims. Empty detail gives
//                   report: null but still strips the line. kind is lowercased.
//
//   mode: 'block' -- multi-line keyed block (AMPLIFY/QUERY/DIR/EXCLUDE). Matches the
//     behaviour of src/incident-amplification-marker.js extractAmplificationRequests
//     when given AMPLIFY_OPTIONS (below) plus a caller-supplied normalizePath and
//     maxItems. Option keys:
//         blockPrefix:   'AMPLIFY:'      (the block-start label)
//         resultKey:     'requests'
//         maxItems:      Infinity       (per-response cap; incident uses an env value)
//         normalizePath: identity        (incident passes path.normalize from its caller)
//       return: { cleanText, requests: [{ rootCauseSummary, query, dir, exclude }] }
//       A block's scope ends at the first blank line. A block missing QUERY, or with an
//       empty title, is dropped (never thrown). Items beyond maxItems are dropped.
//       When the prefix is absent, cleanText is the untouched source and requests is [].
//
// Presets:
//   CONCEPT_BUILD_OPTIONS -- {} (the defaults above).
//   AMPLIFY_OPTIONS       -- block-mode keys above, with maxItems: 1. It does NOT include
//                            normalizePath, because this module may not import path.
//                            Callers that need exclude paths normalised must add
//                            normalizePath: path.normalize themselves.

const CONCEPT_BUILD_OPTIONS = {};

function amplifyOptions({ maxItems = 1, normalizePath } = {}) {
  return { mode: 'block', blockPrefix: 'AMPLIFY:', resultKey: 'requests', maxItems, normalizePath };
}

const AMPLIFY_OPTIONS = amplifyOptions();

const DEFAULT_INLINE_PATTERN = /^CONCEPT-BUILD:\s*(scratch|adapted)\s*\|\s*(.+)$/im;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fieldRe(label) {
  return new RegExp(`^${label}:\\s*(.+)$`, 'm');
}

function extractInline(source, opts) {
  const key = opts.resultKey;
  const pattern = opts.inlinePattern || DEFAULT_INLINE_PATTERN;
  const match = source.match(pattern);
  if (!match) return { cleanText: source, [key]: null };
  const kind = match[1].toLowerCase();
  const detail = match[2].trim();
  const cleanText = source.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim();
  if (!detail) return { cleanText, [key]: null };
  return { cleanText, [key]: { kind, detail } };
}

function extractBlock(source, opts) {
  const key = opts.resultKey;
  const prefix = opts.blockPrefix;
  if (!source.includes(prefix)) return { cleanText: source, [key]: [] };

  const titleRe = new RegExp(`^${escapeRe(prefix)}\\s*(.+)$`, 'm');
  const splitRe = new RegExp(`(?=^${escapeRe(prefix)}\\s*)`, 'm');
  const queryRe = fieldRe('QUERY');
  const dirRe = fieldRe('DIR');
  const excludeRe = fieldRe('EXCLUDE');

  const blocks = source.split(splitRe);
  const items = [];
  const cleanParts = [];

  for (const block of blocks) {
    const titleMatch = block.match(titleRe);
    if (!titleMatch) {
      cleanParts.push(block);
      continue;
    }
    const rootCauseSummary = titleMatch[1].trim();
    const afterTitle = block.slice(block.indexOf(titleMatch[0]) + titleMatch[0].length);
    const paraSplit = afterTitle.match(/\n\s*\n/);
    const scoped = paraSplit ? afterTitle.slice(0, paraSplit.index) : afterTitle;
    const remainder = paraSplit ? afterTitle.slice(paraSplit.index) : '';
    cleanParts.push(remainder);

    const queryMatch = scoped.match(queryRe);
    if (!rootCauseSummary || !queryMatch) continue;
    if (items.length >= opts.maxItems) continue;

    const dirMatch = scoped.match(dirRe);
    const excludeMatch = scoped.match(excludeRe);
    items.push({
      rootCauseSummary,
      query: queryMatch[1].trim(),
      dir: dirMatch ? dirMatch[1].trim() : undefined,
      exclude: excludeMatch
        ? excludeMatch[1].split(',').map((s) => s.trim()).filter(Boolean).map(opts.normalizePath)
        : [],
    });
  }

  const cleanText = cleanParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, [key]: items };
}

function extractMarkers(text, options) {
  const given = options || {};
  const mode = given.mode || 'inline';
  const opts = {
    mode,
    inlinePattern: given.inlinePattern,
    blockPrefix: given.blockPrefix || 'AMPLIFY:',
    resultKey: given.resultKey || (mode === 'block' ? 'requests' : 'report'),
    maxItems: given.maxItems === undefined ? Infinity : given.maxItems,
    normalizePath: given.normalizePath || ((p) => p),
  };
  const source = text || '';
  if (mode === 'block') return extractBlock(source, opts);
  return extractInline(source, opts);
}

module.exports = {
  extractMarkers,
  CONCEPT_BUILD_OPTIONS,
  AMPLIFY_OPTIONS,
};
