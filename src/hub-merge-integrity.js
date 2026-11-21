'use strict';

// hub-merge-integrity: pure checks that a piece marked merged really has its commit on the landed set,
// or still has a live branch. The only I/O is readLandedSet, which reads one JSON file.

const fs = require('node:fs');

function hasLanded(landedSet, commit) {
  if (landedSet instanceof Set) return landedSet.has(commit);
  if (Array.isArray(landedSet)) return landedSet.includes(commit);
  return false;
}

// piece: { id, state, commit }. landedSet: Set or array of commit ids. hasLiveBranch: boolean.
// -> true only when the piece is merged and (its commit landed or it has a live branch).
function canMarkMerged(piece, landedSet, hasLiveBranch) {
  if (!piece || piece.state !== 'merged') return false;
  return hasLanded(landedSet, piece.commit) || hasLiveBranch === true;
}

// pieces: array of piece records. hasLiveBranchOf: (piece) => boolean.
// -> ids of merged pieces that fail the test.
function checkHub(pieces, landedSet, hasLiveBranchOf) {
  const failing = [];
  for (const p of Array.isArray(pieces) ? pieces : []) {
    if (!p || p.state !== 'merged') continue;
    if (!canMarkMerged(p, landedSet, hasLiveBranchOf(p) === true)) failing.push(p.id);
  }
  return failing;
}

// file: path to a JSON array of commit id strings. -> Set of those ids. Throws on any other shape.
function readLandedSet(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
    throw new Error(`landed set must be a JSON array of strings: ${file}`);
  }
  return new Set(parsed);
}

module.exports = { canMarkMerged, checkHub, readLandedSet };
