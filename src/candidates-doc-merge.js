'use strict';

// Structural 3-way merge for the pipeline's auto-generated "### AC-N · Title" candidate
// docs (Docs/*_CANDIDATES.md). Exists because git's line-based merge reliably fails on
// these: multiple branches routinely compute the same "next AC-N slot" against a shared,
// not-yet-merged base and each write a DIFFERENT candidate into it, which git sees as two
// incompatible edits to the same lines. Confirmed live 2026-08-21: 9 independently-pushed
// observability_review branches all collided on Docs/OBSERVABILITY_FIX_CANDIDATES.md this
// way -- each branch's OWN source-code diff was conflict-free, only the shared doc wasn't.
//
// The correct resolution isn't "pick a side": every branch's candidate is real, wanted
// content. So this treats a same-slot collision as "both sides added a new candidate that
// happened to land on the same id" -- keeps ours at that slot and re-files theirs' version
// as a new slot above the doc's current max, the same renumber-on-write rule
// applyArchDiscoveryCandidates (apply-group-a.js) already uses for fresh appends.

const HEADING_RE = /^#{1,6}\s*AC-(\d+)\b/;

function parseBlocks(text) {
  const t = (text || '').replace(/\r\n/g, '\n');
  const parts = t.split(/(?=^#{1,6}\s*AC-\d+)/m);
  const preamble = HEADING_RE.test(parts[0].trimStart()) ? '' : parts[0];
  const blocks = new Map(); // id (number) -> block text (trimmed, heading included)
  const order = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(HEADING_RE);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    blocks.set(id, trimmed);
    order.push(id);
  }
  return { preamble, blocks, order };
}

/**
 * @returns {string|null} merged text, or null if the input doesn't look like a candidates
 *   doc at all (no AC-N headings anywhere) -- callers should treat null as "could not
 *   resolve structurally," and fall back to a real conflict rather than guessing.
 */
function mergeCandidatesDoc({ ancestorText, oursText, theirsText }) {
  const ancestor = parseBlocks(ancestorText);
  const ours = parseBlocks(oursText);
  const theirs = parseBlocks(theirsText);

  if (ours.blocks.size === 0 && theirs.blocks.size === 0) return null;

  let nextId = 1;
  for (const id of [...ours.blocks.keys(), ...theirs.blocks.keys(), ...ancestor.blocks.keys()]) {
    if (id >= nextId) nextId = id + 1;
  }

  const finalBlocks = new Map(ours.blocks);
  const finalOrder = [...ours.order];
  const overflow = []; // blocks bumped to a fresh id because ours already claimed the slot

  for (const id of theirs.order) {
    const theirsBlock = theirs.blocks.get(id);
    const ancestorBlock = ancestor.blocks.get(id);
    const oursBlock = ours.blocks.get(id);

    if (theirsBlock === ancestorBlock) continue; // theirs didn't touch this slot
    if (!ours.blocks.has(id)) {
      // ours never touched this slot -- theirs' edit (or new entry) applies cleanly.
      finalBlocks.set(id, theirsBlock);
      if (!finalOrder.includes(id)) finalOrder.push(id);
      continue;
    }
    if (oursBlock === theirsBlock) continue; // both sides made the identical change
    if (oursBlock === ancestorBlock) {
      // ours left the slot alone, theirs changed it -- theirs' edit wins outright.
      finalBlocks.set(id, theirsBlock);
      continue;
    }
    // Both sides changed the SAME slot to DIFFERENT content: two distinct real candidates
    // collided on one id. Keep ours where it is; re-file theirs under a fresh id instead
    // of discarding it.
    const freshId = nextId++;
    const reheaded = theirsBlock.replace(HEADING_RE, (full, digits) => full.replace(`AC-${digits}`, `AC-${freshId}`));
    overflow.push({ id: freshId, block: reheaded });
  }

  for (const { id, block } of overflow) {
    finalBlocks.set(id, block);
    finalOrder.push(id);
  }

  const seen = new Set();
  const dedupedOrder = finalOrder.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  dedupedOrder.sort((a, b) => a - b);

  const preamble = ours.preamble || theirs.preamble || ancestor.preamble || '# Candidates\n';
  const body = dedupedOrder.map((id) => finalBlocks.get(id)).join('\n\n');
  return `${preamble.trimEnd()}\n\n${body}\n`;
}

module.exports = { mergeCandidatesDoc, parseBlocks };
