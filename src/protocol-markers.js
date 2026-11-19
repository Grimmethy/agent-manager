'use strict';

// Shared protocol-marker inject/extract (AC-148). concepts.js (CONCEPT-BUILD:) and
// incident-amplification-marker.js (AMPLIFY:) both duplicated the same two steps:
//   1. inject a one-time instruction into a prompt (idempotent on the marker token), and
//   2. leniently extract + strip marker text from a response, never throwing.
// Each consumer now declares a `def` and calls injectMarker / extractMarker.
//
// def shape:
//   token        string   marker text; injection is skipped if the prompt already has it
//   instruction  string   text appended to the prompt (after a blank line)
//   -- line mode (single marker line; used when splitRe is absent) --
//   lineRe       RegExp   matches the one marker line
//   parseMatch   (match) => item | null   null means malformed (line is still stripped)
//   -- block mode (multi-line blocks; used when splitRe is present) --
//   splitRe      RegExp   lookahead split so each block starts at the marker
//   titleRe      RegExp   matches the marker's first line inside a block
//   parseBlock   (titleMatch, scoped) => item | null   scoped = block body up to first blank line
//   maxItems     number   (optional) items beyond this are dropped
//
// extractMarker returns { cleanText, items }. Pure and synchronous; requires no consumer.

function injectMarker(prompt, def) {
  const base = prompt || '';
  if (base.includes(def.token)) return base;
  return `${base}\n\n${def.instruction}`;
}

function extractLine(source, def) {
  const match = source.match(def.lineRe);
  if (!match) return { cleanText: source, items: [] };
  const cleanText = source.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim();
  const item = def.parseMatch(match);
  return { cleanText, items: item ? [item] : [] };
}

function extractBlocks(source, def) {
  if (!source.includes(def.token)) return { cleanText: source, items: [] };
  const max = def.maxItems === undefined ? Infinity : def.maxItems;
  const items = [];
  const cleanParts = [];

  for (const block of source.split(def.splitRe)) {
    const titleMatch = block.match(def.titleRe);
    if (!titleMatch) {
      cleanParts.push(block);
      continue;
    }
    const afterTitle = block.slice(block.indexOf(titleMatch[0]) + titleMatch[0].length);
    const paraSplit = afterTitle.match(/\n\s*\n/);
    const scoped = paraSplit ? afterTitle.slice(0, paraSplit.index) : afterTitle;
    cleanParts.push(paraSplit ? afterTitle.slice(paraSplit.index) : '');

    const item = def.parseBlock(titleMatch, scoped);
    if (!item) continue;
    if (items.length >= max) continue;
    items.push(item);
  }

  const cleanText = cleanParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, items };
}

function extractMarker(response, def) {
  const source = response || '';
  return def.splitRe ? extractBlocks(source, def) : extractLine(source, def);
}

module.exports = { injectMarker, extractMarker };
