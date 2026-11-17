'use strict';

// Create-premise check for piece intake (ADR-0024, docs/adr/0024-triggers-not-polls.md).
//
// Per ADR-0024 this check runs on the event of piece intake, once per piece, so no poll is involved:
// the intake path calls it once when a piece arrives and never again for that piece.
//
// Why: a piece that says "create <path>" for a file the base already has would have a draft re-create
// an existing file. This check reports those targets before the first draft is written.
//
// What: parse the `create <path>` targets from the piece text. A bare file name such as review-inert.js
// resolves to src/review-inert.js. Each resolved path is checked with the injected baseHasFile(path).
// If none exist on the base the piece is fine ({ ok: true }); otherwise the piece needs clarification and
// the existing paths are named.
//
// Pure: baseHasFile is injected, and this module has no I/O and no timers.

const CREATE_TARGET_RE = /\bcreate\s+`?([\w./-]+\.[A-Za-z0-9]+)`?/gi;

function resolveTarget(name) {
  return name.includes('/') ? name : `src/${name}`;
}

function parseCreateTargets(pieceTargets) {
  const text = Array.isArray(pieceTargets) ? pieceTargets.join('\n') : String(pieceTargets || '');
  const out = [];
  for (const m of text.matchAll(CREATE_TARGET_RE)) {
    const resolved = resolveTarget(m[1]);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

function checkCreatePremise({ pieceTargets, baseHasFile } = {}) {
  const targets = parseCreateTargets(pieceTargets);
  if (targets.length === 0) return { ok: true };
  const existing = targets.filter((p) => baseHasFile(p));
  if (existing.length === 0) return { ok: true };
  return {
    ok: false,
    action: 'needs-clarification',
    existing,
    reason: `piece says to create file(s) that already exist on the base: ${existing.join(', ')}`,
  };
}

module.exports = { checkCreatePremise, parseCreateTargets };
