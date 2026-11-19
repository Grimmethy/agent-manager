'use strict';

// Shared marker-block helpers for response markers (SIDE-FINDING, AMPLIFY, CONTEXT-LOG style).
// Pure string logic only: no I/O, no timers, no scanning of directories, no model calls.

// Idempotent: if the marker string is already present, the text is returned unchanged,
// so a retried identical prompt does not accumulate copies of the instruction.
function injectInstruction(text, marker, instructionBlock) {
  const base = text || '';
  if (base.includes(marker)) return base;
  return `${base}\n\n${instructionBlock}`;
}

// Finds every match of markerRegex, treats each match as the start of a block, and bounds
// each block to its first blank line (the remainder stays in cleanText). parser(block) is
// called per scoped block; a parser that throws, or returns null/undefined, drops that block.
// Never throws. Returns { cleanText, data, match } where data is the array of surviving
// parsed results and match is the first regex match (or null when nothing matched).
function extractMarkerData(text, markerRegex, parser) {
  const source = text || '';
  const flags = markerRegex.flags.includes('g') ? markerRegex.flags : `${markerRegex.flags}g`;
  const matches = [...source.matchAll(new RegExp(markerRegex.source, flags))];
  if (matches.length === 0) return { cleanText: source, data: [], match: null };

  const data = [];
  const cleanParts = [source.slice(0, matches[0].index)];

  matches.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : source.length;
    const block = source.slice(start, end);
    const paraSplit = block.match(/\n\s*\n/);
    const scoped = paraSplit ? block.slice(0, paraSplit.index) : block;
    const remainder = paraSplit ? block.slice(paraSplit.index) : '';
    cleanParts.push(remainder);

    let parsed;
    try {
      parsed = parser(scoped);
    } catch (e) {
      parsed = undefined; // malformed block: drop it, never rethrow
    }
    if (parsed !== undefined && parsed !== null) data.push(parsed);
  });

  const cleanText = cleanParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, data, match: matches[0] };
}

module.exports = { injectInstruction, extractMarkerData };
