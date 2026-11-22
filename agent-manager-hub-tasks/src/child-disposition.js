'use strict';
// Child disposition classifier for hub coordination. Pure: no VCS access, no timers, no I/O.
//
// classifyChild(child, ctx) -> { classification, disposition, reason }
//   ctx.mergeEvidence(child) -> boolean. Injected merge-evidence lookup (e.g. commit reachable
//   from master). It may throw; a throw, or a missing function, fails closed to needs-human.
//   Order: recorded merged state, then merge evidence (both win regardless of archive state),
//   then archive reason. Without merge evidence:
//     archive.reason AND archive.supersededBy -> redundant / noop
//     otherwise                               -> discarded / needs-human
//   Assumed child fields: id, mergedAt, terminalDisposition, archive.reason, archive.supersededBy.
//
// hubDispositionFor(children) -> { disposition, doneMarker }
//   children: array of results { childId, disposition }. Precedence needs-human > noop > merged.
//   Empty list -> needs-human (vacuous all-merged must not mark a hub done).
//
// historyEvent(hubId, child, classification, disposition, reason) -> { hubId, childId, classification, reason, disposition }

const RANK = { merged: 0, noop: 1, 'needs-human': 2 };

function recordedMerged(child) {
  return Boolean(child && (child.mergedAt || child.terminalDisposition === 'merged'));
}

function classifyChild(child, ctx) {
  const c = child || {};
  if (recordedMerged(c)) {
    return { classification: 'merged', disposition: 'merged', reason: 'merged-state-recorded' };
  }
  let evidenced;
  try {
    if (!ctx || typeof ctx.mergeEvidence !== 'function') throw new Error('no merge-evidence lookup');
    evidenced = Boolean(ctx.mergeEvidence(c));
  } catch (err) {
    return { classification: 'discarded', disposition: 'needs-human', reason: 'merge-evidence-unavailable' };
  }
  if (evidenced) {
    return { classification: 'merged', disposition: 'merged', reason: 'merge-evidence' };
  }
  const archive = c.archive || {};
  const reason = archive.reason;
  if (reason && archive.supersededBy) {
    return { classification: 'redundant', disposition: 'noop', reason: 'superseded-by:' + String(archive.supersededBy) };
  }
  if (reason) {
    return { classification: 'discarded', disposition: 'needs-human', reason: 'archive-reason-without-superseding-reference:' + String(reason) };
  }
  return { classification: 'discarded', disposition: 'needs-human', reason: 'no-archive-reason' };
}

function hubDispositionFor(children) {
  const list = Array.isArray(children) ? children : [];
  if (list.length === 0) {
    return { disposition: 'needs-human', doneMarker: 'no-children' };
  }
  const norm = list.map((ch) => {
    const d = ch && Object.prototype.hasOwnProperty.call(RANK, ch.disposition) ? ch.disposition : 'needs-human';
    const id = (ch && (ch.childId || ch.id)) || '(unknown)';
    return { d, id };
  });
  let worst = 'merged';
  for (const { d } of norm) {
    if (RANK[d] > RANK[worst]) worst = d;
  }
  if (worst === 'merged') {
    return { disposition: 'merged', doneMarker: 'all-children-merged' };
  }
  const ids = norm.filter((x) => x.d === worst).map((x) => x.id);
  return { disposition: worst, doneMarker: worst + ':' + ids.join(',') };
}

function historyEvent(hubId, child, classification, disposition, reason) {
  const c = child || {};
  return {
    hubId,
    childId: c.id,
    classification,
    reason: reason === undefined ? null : reason,
    disposition,
  };
}

module.exports = { classifyChild, hubDispositionFor, historyEvent };
