// Premium Priority provenance line for the task modal: "Set by <who> <relative time>". A plain global <script> holding only declarations (no DOM, no fetch), loaded by
// index.html just before task-detail-modal.js, whose renderTaskDetailModal() puts premiumProvenanceHtml(task) under the Premium Priority button. The fields come from
// POST /api/task-anywhere/<id>/premium-priority and src/queue-adhoc-task.js (premiumSetBy, premiumSetAt, premiumClearedBy, premiumClearedAt). Display only.

const PREMIUM_SET_BY_LABELS = {
  'operator-ui': 'operator (task modal)',
  'operator-bulk': 'operator (bulk)',
  'chat-queue': 'Chat',
  'cli': 'the command line',
  'source': 'its task source',
};

function premiumRelativeTime(iso, nowMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

// Plain text; the caller escapes it. Empty string when the task is not premium and was never cleared by a known actor.
function premiumProvenanceText(task, nowMs) {
  if (!task) return '';
  if (task.premiumPriority) {
    if (!task.premiumSetBy) return 'origin unknown';
    const who = PREMIUM_SET_BY_LABELS[task.premiumSetBy] || String(task.premiumSetBy);
    const when = task.premiumSetAt ? premiumRelativeTime(task.premiumSetAt, nowMs) : '';
    return `Set by ${who}${when ? ' ' + when : ''}`;
  }
  if (task.premiumClearedAt) {
    const who = PREMIUM_SET_BY_LABELS[task.premiumClearedBy] || String(task.premiumClearedBy || 'an operator');
    const when = premiumRelativeTime(task.premiumClearedAt, nowMs);
    return `Cleared by ${who}${when ? ' ' + when : ''}`;
  }
  return '';
}
