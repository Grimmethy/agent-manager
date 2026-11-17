'use strict';

// Apply-failure watchdog: when the same apply failure repeats (3 times inside WINDOW_MS, with no recent notification for that signature),
// pause the pipeline by writing the pipeline-paused marker and tell the owner once. Nothing is ever removed here; `forge-mode.js off`
// or a human removes the marker.
//   decide()            pure: no I/O and no timers; it never reads the wall clock.
//   recordApplyFailure() the wrapper; takes injected deps and fails open (logs, never throws).
//   productionDeps()    wires the real store, marker path (from forge-mode.js), notify (from notify.js) and the clock.

const fs = require('fs');
const path = require('path');

const WINDOW_MS = 600000;
const THRESHOLD = 3;

// First non-empty trimmed line of the reason ('' when there is none).
function signatureOf(reason) {
  const lines = String(reason == null ? '' : reason).split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

// Pure decision. entries: [{sig, at}], notified: {sig: at}.
function decide({ entries, notified, sig, now }) {
  const count = (entries || []).filter((e) => e && e.sig === sig && now - e.at < WINDOW_MS).length;
  const last = notified ? Number(notified[sig]) : NaN;
  const alreadyNotified = Number.isFinite(last) && now - last < WINDOW_MS;
  if (count === THRESHOLD && !alreadyNotified) return { action: 'pause', count };
  return { action: 'none', count };
}

// deps: { clock() -> ms, store: { append(entry), load() -> {entries, notified}, markNotified(sig, at), tail() -> string },
//         pauseMarker: { exists() -> bool, write(content) (must use the 'wx' flag and throw EEXIST if present) },
//         notify(message) -> Promise }
async function recordApplyFailure({ task, reason, deps }) {
  try {
    const now = deps.clock();
    // Marker check first: a paused pipeline is left byte-for-byte alone, nothing is written, nothing is sent.
    if (deps.pauseMarker.exists()) return { action: 'none', count: 0, reason: 'already-paused' };

    let text = reason;
    if (!signatureOf(text)) text = deps.store.tail();
    const sig = signatureOf(text);
    if (!sig) return { action: 'none', count: 0, reason: 'no-signature' };

    deps.store.append({ task: task == null ? '' : String(task), sig, at: now });
    const { entries, notified } = deps.store.load();
    const { action, count } = decide({ entries, notified, sig, now });

    if (action === 'pause') {
      try {
        deps.pauseMarker.write(JSON.stringify({ since: new Date(now).toISOString(), reason: `repeated apply failure: ${sig}` }) + '\n');
      } catch (e) {
        if (e && e.code === 'EEXIST') return { action: 'none', count, reason: 'already-paused' };
        throw e;
      }
      deps.store.markNotified(sig, now);
      try {
        await deps.notify({ level: 'urgent', key: `apply-failure:${sig}`, title: 'Pipeline paused: repeated apply failure', text: sig });
      } catch (e) {
        console.error(`[apply-failure-watchdog] notify failed: ${e && e.message ? e.message : e}`);
      }
    }
    return { action, count };
  } catch (e) {
    console.error(`[apply-failure-watchdog] failed open: ${e && e.message ? e.message : e}`);
    return { action: 'none', count: 0, reason: 'error' };
  }
}

function productionDeps(env = process.env) {
  // Reuse the pipeline-paused marker path owned by forge-mode.js (its state dir is the same).
  const { markerPath } = require('./forge-mode.js');
  const { notify } = require('./notify.js');
  const marker = markerPath(env);
  const stateDir = path.dirname(marker);
  const storeFile = path.join(stateDir, 'apply-failure-watchdog.json');
  const logFile = path.join(stateDir, 'apply-failure-watchdog.log');

  const readStore = () => {
    try {
      const p = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      return { entries: Array.isArray(p.entries) ? p.entries : [], notified: p.notified && typeof p.notified === 'object' ? p.notified : {} };
    } catch (e) {
      return { entries: [], notified: {} };
    }
  };
  const writeStore = (s) => {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = `${storeFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, storeFile);
  };

  return {
    clock: () => Date.now(),
    store: {
      append(entry) {
        const s = readStore();
        // Keep only what the window can still count.
        const cutoff = entry.at - WINDOW_MS;
        s.entries = s.entries.filter((e) => e && e.at >= cutoff).concat([entry]);
        writeStore(s);
      },
      load() {
        return readStore();
      },
      markNotified(sig, at) {
        const s = readStore();
        s.notified[sig] = at;
        writeStore(s);
      },
      tail() {
        try {
          const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
          return lines.length ? lines[lines.length - 1] : '';
        } catch (e) {
          return '';
        }
      },
    },
    pauseMarker: {
      exists: () => fs.existsSync(marker),
      write: (content) => {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(marker, content, { flag: 'wx' });
      },
    },
    notify,
  };
}

module.exports = { WINDOW_MS, THRESHOLD, signatureOf, decide, recordApplyFailure, productionDeps };
