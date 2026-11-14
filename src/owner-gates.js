'use strict';

// Owner-gated pieces of a hub, found when the hub is built. 2026-10-23, chat plugin: HUB0003-05 (a library download that needs the owner's approval)
// and HUB0016-01 (a design decision) were only discovered when the serial chain reached them, parking everything behind them. Listing them on the hub
// record up front lets the owner decide before the chain gets there. Behaviour of claiming and ordering is unchanged.

const GATE_RE = /owner[ -]approval|needs the owner|design decision/i;

// piece: { id, title, rawText } -> { id, title, why } or null. `why` is the matched phrase, lower-cased.
function ownerGateFor(piece) {
  const m = GATE_RE.exec(`${piece.title || ''}\n${piece.rawText || ''}`);
  return m ? { id: piece.id, title: piece.title, why: m[0].toLowerCase() } : null;
}

module.exports = { GATE_RE, ownerGateFor };
