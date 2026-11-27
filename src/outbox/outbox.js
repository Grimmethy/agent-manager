'use strict';

// Single-writer outbox.
// - One drain() is the only writer to subscribers, so each sees append order.
// - Replay and live delivery share one buffer and one index per subscriber.
// - Drains run only on append/subscribe/close; nothing runs in the background.
// - Cursor: offset of the next entry wanted. Missing, non-integer, or < -1 -> 0.
//   -1 -> tail (live only, no replay). CHOSEN MEANING; confirm with a human.
// - Buffer holds at most maxEntries. Older entries are dropped. A subscriber
//   behind the lowest retained offset gets {type:'gap', lowest} before replay.
// - close(finalEvent) appends a terminal entry; nothing can follow it.

function parseCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < -1) return 0;
  return n;
}

class Outbox {
  constructor({ maxEntries = 1000 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.maxEntries = maxEntries;
    this.entries = [];        // { offset, event, terminal }
    this.nextOffset = 0;
    this.closed = false;
    this.subs = new Set();    // { next, onEvent }
    this.draining = false;
  }

  get lowest() {
    return this.entries.length ? this.entries[0].offset : this.nextOffset;
  }

  _push(event, terminal) {
    this.entries.push({ offset: this.nextOffset++, event, terminal });
    if (this.entries.length > this.maxEntries) this.entries.shift();
    this.drain();
    return this.nextOffset - 1;
  }

  append(event) {
    if (this.closed) throw new Error('outbox closed');
    return this._push(event, false);
  }

  close(finalEvent) {
    if (this.closed) return;
    this.closed = true;
    this._push(finalEvent, true);
  }

  subscribe({ cursor, onEvent }) {
    const c = parseCursor(cursor);
    const sub = { next: c === -1 ? this.nextOffset : c, onEvent };
    this.subs.add(sub);
    this.drain();
    return () => this.subs.delete(sub);
  }

  drain() {
    // Reentrant calls (an onEvent that appends) return here; the outer loop
    // re-reads nextOffset and lowest, so nothing is skipped or duplicated.
    if (this.draining) return;
    this.draining = true;
    try {
      for (const sub of this.subs) {
        while (sub.next < this.nextOffset) {
          if (sub.next < this.lowest) {
            sub.next = this.lowest;
            sub.onEvent({ type: 'gap', lowest: this.lowest });
            continue;
          }
          const e = this.entries[sub.next - this.lowest];
          sub.next = e.offset + 1;
          sub.onEvent(e.event);
          if (e.terminal) { this.subs.delete(sub); break; }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

module.exports = { Outbox, parseCursor };
