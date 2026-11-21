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

// Joins a repo root and hub id with a NUL separator. Different (repoRoot, hubId) pairs produce different keys when neither input contains NUL.
function keyFor(repoRoot, hubId) {
  return repoRoot + "\u0000" + hubId;
}

// Builds the per-hub retire URL from a repo root. The body field `project` carries the repo root to the server.
function retireUrl(repoRoot) {
  return '/api/retire?repoRoot=' + encodeURIComponent(repoRoot);
}

// Stable sort: deepest rows first (highest depth), ties broken by keyFor ascending. Does not mutate input.
function sortInnermostFirst(rows) {
  return rows.slice().sort((a, b) => {
    const depthA = a.depth || 0;
    const depthB = b.depth || 0;
    if (depthB !== depthA) return depthB - depthA;
    return keyFor(a.repoRoot, a.hubId).localeCompare(keyFor(b.repoRoot, b.hubId));
  });
}

// Partitions rows into archived (2xx result) and left (non-2xx or error). Throws if any row is unaccounted for.
function summarizeBatch(rows, results) {
  const archived = [];
  const left = [];
  for (const row of rows) {
    const key = keyFor(row.repoRoot, row.hubId);
    if (!results.has(key)) {
      throw new Error('summarizeBatch: row not found in results for key ' + key);
    }
    const result = results.get(key);
    if (result && result.archived) {
      archived.push({ key: key, hubId: row.hubId });
    } else {
      left.push({
        key: key,
        hubId: row.hubId,
        reason: result.reason || 'unknown'
      });
    }
  }
  return { archived: archived, left: left };
}

// Awaits send one row at a time (no Promise.all). Rejected sends are caught per row and recorded with the error reason.
async function runBatch(rows, send) {
  const sorted = sortInnermostFirst(rows);
  const results = new Map();
  for (const row of sorted) {
    const url = retireUrl(row.repoRoot);
    const body = { project: row.repoRoot };
    try {
      const result = await send(url, body);
      results.set(keyFor(row.repoRoot, row.hubId), result);
    } catch (err) {
      results.set(keyFor(row.repoRoot, row.hubId), {
        archived: false,
        reason: err.message || String(err)
      });
    }
  }
  return results;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hubRetireRequest, hubRetirePreview, hubRetireOutcome, keyFor, retireUrl, sortInnermostFirst, summarizeBatch, runBatch };
}
