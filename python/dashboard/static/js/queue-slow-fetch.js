// Fetches a JSON list and calls opts.onSlow() once if the response is slow.
// Never aborts: only opts.signal (caller-supplied) can cancel the request.
(function () {
  'use strict';

  var DEFAULT_SLOW_MS = 8000;

  async function fetchList(url, opts) {
    opts = opts || {};
    var slowMs = (opts.slowMs === null || opts.slowMs === undefined) ? DEFAULT_SLOW_MS : opts.slowMs;
    var timer = setTimeout(function () {
      if (typeof opts.onSlow === 'function') {
        try { opts.onSlow(); } catch (e) { }
      }
    }, slowMs);
    try {
      var r = await fetch(url, { signal: opts.signal });
      if (!r.ok) {
        throw new Error('HTTP ' + r.status + ' for ' + url);
      }
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  var QueueSlowFetch = { fetchList: fetchList };

  var g = (typeof window !== 'undefined') ? window : globalThis;
  g.QueueSlowFetch = QueueSlowFetch;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = QueueSlowFetch;
  }
})();
