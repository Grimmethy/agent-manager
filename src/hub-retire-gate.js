'use strict';

// hub-retire-gate.js -- pure decision: may a coordinating hub be retired (its pieces considered done)?
//
// Field mapping (the only place raw piece field names appear):
//   FIELD.status   'status'   CONFIRMED: hub subTasks entries carry `status` (src/hub-add-piece.js).
//   FIELD.waived   'waived'   ASSUMED: boolean; not present in src/hub-add-piece.js.
//   FIELD.question 'question' ASSUMED: string; not present in src/hub-add-piece.js.
//   Piece number: 1-based position in the pieces array (ASSUMED convention).
//
// Rules applied:
//   - built = status is one of done, built, merged.
//   - a waived piece is excluded from `unbuilt` (it counts as settled).
//   - `unbuilt` is the ascending list of piece numbers that are neither built nor waived.
//   - an unbuilt piece with status needs-clarification blocks: outcome ASK-OWNER, and
//     questions gets {piece, question}; question is '' when the piece has no string question.
//   - otherwise outcome WAIT when unbuilt is non-empty, RETIRE-HUB when it is empty.
//   - empty pieces (evaluateRetire([])): unbuilt is [] and questions is [], so by the rule above
//     the outcome is RETIRE-HUB. This is the stated rule, not a separate judgement.
//
// Purity: no filesystem, child-process, resident-model client, timer or model-call code.

const FIELD = {
  status: 'status',
  waived: 'waived',
  question: 'question',
};

const BUILT_STATUSES = new Set(['done', 'built', 'merged']);
const BLOCKING_STATUS = 'needs-clarification';

function evaluateRetire(pieces) {
  const list = Array.isArray(pieces) ? pieces : [];
  const unbuilt = [];
  const questions = [];
  let blocked = false;

  list.forEach((piece, index) => {
    const number = index + 1;
    const p = piece && typeof piece === 'object' ? piece : {};
    const status = p[FIELD.status];
    if (BUILT_STATUSES.has(status) || p[FIELD.waived] === true) return;
    unbuilt.push(number);
    if (status === BLOCKING_STATUS) {
      blocked = true;
      const q = p[FIELD.question];
      questions.push({ piece: number, question: typeof q === 'string' ? q : '' });
    }
  });

  let outcome;
  if (blocked) outcome = 'ASK-OWNER';
  else if (unbuilt.length > 0) outcome = 'WAIT';
  else outcome = 'RETIRE-HUB';

  return { outcome, unbuilt, questions };
}

module.exports = { evaluateRetire };
