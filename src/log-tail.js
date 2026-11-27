// Log tail module (event-driven): this module has no timers and no polling.
// It advances a cursor by applying in-order chunks from fetchFrom(),
// and requests missing ranges via trigger() when offsets mismatch.

export function createLogTail({ fetchFrom, onChunk }) {
  let cursor = 0;
  let inFlight = false;
  let syncAgain = false;
  let disposed = false;

  function finish() {
    inFlight = false;
    if (syncAgain) {
      syncAgain = false;
      trigger();
    }
  }

  function trigger() {
    if (disposed) return;
    if (inFlight) {
      syncAgain = true;
      return;
    }
    inFlight = true;
    fetchFrom(cursor).then((result) => {
      if (disposed) return;
      if (result && result.data) {
        if (!disposed) {
          onChunk(result.data);
        }
      }
      cursor =
        result.nextOffset != null
          ? result.nextOffset
          : cursor + (result.data ? result.data.length : 0);
      finish();
    }).catch(() => {
      finish();
    });
  }

  function onEvent({ offset, data }) {
    if (offset !== cursor) {
      trigger();
      return;
    }
    if (data) {
      onChunk(data);
      cursor = offset + (Array.isArray(data) ? data.length : 1);
    }
  }

  function dispose() {
    disposed = true;
  }

  return { onEvent, trigger, dispose };
}
