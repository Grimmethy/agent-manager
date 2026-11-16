// Hub retire helpers: pure functions for the hub retire flow. No DOM, network, storage, or timer access.
// A plain global <script> in the browser; the guarded module.exports below lets Node require() it for tests.

// Builds the POST target and body for retiring a hub. Returns {error} when the reason is empty after trimming.
function hubRetireRequest(hubId, reason) {
  const trimmed = (reason === null || reason === undefined ? '' : String(reason)).trim();
  if (!trimmed) return { error: 'A reason is required to retire a hub.' };
  return { url: '/api/hub/' + encodeURIComponent(hubId) + '/retire', body: { reason: trimmed } };
}

// Maps sub-tasks to {id, state, title} for display. Unfiltered: every sub-task is kept.
function hubRetirePreview(subTasks) {
  return (subTasks || []).map((t) => ({ id: t.id, state: t.state, title: t.title }));
}

// Decides whether the retire dialog closes. 2xx closes; anything else keeps it open with a message.
function hubRetireOutcome(status, payload) {
  if (status >= 200 && status < 300) return { close: true };
  const message = (payload && payload.description) || 'Retire failed (HTTP ' + status + ')';
  return { close: false, message: message };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hubRetireRequest, hubRetirePreview, hubRetireOutcome };
}
