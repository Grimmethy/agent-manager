'use strict';

// Owner-gated pieces of a hub, found when the hub is built. 2026-10-23, chat plugin: HUB0003-05 (a library download that needs the owner's approval)
// and HUB0016-01 (a design decision) were only discovered when the serial chain reached them, parking everything behind them. Listing them on the hub
// record up front lets the owner decide before the chain gets there. Behaviour of claiming and ordering is unchanged.
//
// PURPOSE
// -------
// Decides whether a single hub piece (a sub-task or child) should pause the
// serial chain to wait for the hub owner's explicit approval before the piece
// runs. The match is purely lexical: the piece's title and raw-text body are
// concatenated and scanned for three trigger phrases. If any phrase is found,
// the piece is "owner-gated" — it is recorded on the hub's `ownerGates` array
// so the dashboard and coordinator can surface it to the owner before the
// chain reaches it.
//
// TRIGGER PHRASES (case-insensitive)
// ----------------------------------
//   1. "owner-approval" or "owner approval"  — explicit approval required
//   2. "needs the owner"                     — owner intervention required
//   3. "design decision"                     — architectural choice needs sign-off
//
// The regex preserves the original casing in the match so callers can show the
// user exactly what was found; the `why` field is lower-cased for stable
// programmatic use.
//
// RETURN PATHS
// ------------
// The function has two primary return paths plus edge cases:
//
//   A. GATE HIT (work is paused / owner must decide)
//      Returns: { id, title, why }
//        - id: the piece's task id (e.g. "HUB0924-02-...")
//        - title: the piece's title (unchanged)
//        - why: the matched trigger phrase, lower-cased (e.g. "owner approval")
//      Caller action: push onto hub.ownerGates; dashboard lists on hub record;
//        coordinator may refuse to start the piece until the owner waives it.
//
//   B. NO HIT (work proceeds normally)
//      Returns: null
//      Caller action: no gate record; piece joins the serial chain as usual.
//
//   EDGE CASES:
//     - piece.title or piece.rawText is missing/null/empty → concatenation
//       yields an empty string; regex returns null; function returns null.
//       (An empty piece can never trigger the gate.)
//     - piece.id is missing → returned object's id will be undefined; callers
//       should treat this as a malformed piece, not a gate hit.
//
// PROTECTED CASE (checked first by the CALLER, documented here for clarity)
// -----------------------------------------------------------------------
// The HUB0924 task contract specifies that tasks with status 'blocked' that
// were previously escalated from 'needs-clarification' MUST NOT be dismissed
// even when there are no recent history events. This protection is NOT
// implemented inside ownerGateFor itself (the gate function has no access to
// task history or status); it is the responsibility of the caller that
// consumes the gate result (typically the coordinator sweep or dashboard
// route that decides whether to dismiss/archive a piece).
//
// WHY THE PROTECTED CASE IS CHECKED FIRST
// ---------------------------------------
// A piece that was escalated from needs-clarification to blocked was actively
// being worked on — the operator needed clarification, the piece was paused,
// and the status was set to blocked to prevent it from being auto-dismissed
// while waiting. If we allowed dismissal of such pieces solely because they
// lack recent history events, we would silently drop work that was
// intentionally held for human input. The protected case preserves the
// operator's explicit pause signal.
//
// ORDERING LOGIC
// --------------
// When a caller evaluates multiple return paths (e.g. gate hit, protected
// case, dismissal), the protected case MUST be checked before the gate logic
// because:
//   1. The protected case is a SAFETY NET — it prevents data loss of
//      intentionally-held work.
//   2. The gate logic is a ROUTING decision — it directs work to the owner.
//   3. Safety nets always take precedence over routing: you never route
//      around a safety net.
//
// In practice this means: if a piece is blocked-and-escalated-from-needs-
// clarification, the caller MUST skip dismissal regardless of what
// ownerGateFor returns. The gate function itself remains pure and side-effect
// free; it only detects trigger phrases.
//
// DISMISSAL RECORDING
// -------------------
// The gate function itself does NOT record dismissals (it has no access to
// the task history store). Dismissal recording is the caller's responsibility:
// when a caller decides to dismiss a piece (after checking the protected case),
// it should call appendHistoryEvent(task, 'advisory', ...) to log the
// dismissal reason. This keeps ownerGateFor pure and testable.
//
// SEE ALSO
// --------
//   - src/apply-adhoc-diff.js:295 — first caller (hub decompose)
//   - src/hub-add-piece.js:181 — second caller (manual piece addition)
//   - src/hub-apply-routing.js:30 — consumer that logs ownerGates to history
//   - src/owner-gates.test.js — unit tests for the regex match

const GATE_RE = /owner[ -]approval|needs the owner|design decision/i;

// piece: { id, title, rawText } -> { id, title, why } or null. `why` is the matched phrase, lower-cased.
// See module-level JSDoc for full contract, return paths, and protected-case ordering.
function ownerGateFor(piece) {
  const m = GATE_RE.exec(`${piece.title || ''}\n${piece.rawText || ''}`);
  return m ? { id: piece.id, title: piece.title, why: m[0].toLowerCase() } : null;
}

module.exports = { GATE_RE, ownerGateFor };
