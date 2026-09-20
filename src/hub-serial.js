'use strict';

// hub-serial.js -- every hub gets a serial number, and its members carry it (2026-09-20, Grimmethy: "Hub task members need to be more
// recognizable as part of a hub. The names of hub task members should start with HUB#### and hubs should have serial numbers. This naming
// convention should also be applied to the ID instead of AC-2").
//
//   hub label   HUB0007                       (serial from <pipelineDir>/queue/hub-serials.json, monotonic, never reused)
//   hub title   HUB0007 · <title>             (a leading candidate id -- "AC-2 · ..." -- is replaced, not stacked; the id stays in promptContext.candidateId)
//   member id   HUB0007-02-<slug>             (queueSubTasks mints these for adhoc-decompose and candidate-split hubs)
//   member title HUB0007 · 2/5 · <title>
//
// A hub's own record keeps its file id (it is referenced by worklogs, task logs, its branch name and any dependsOn); it gains `hubSerial` and
// `hubLabel` and its title changes. Hubs filed before this (and producers that mint their own child ids: file-decompose, product-spec) are labelled
// by assignMissingHubSerials + retitleHubMembers, run from coordinator-sweep.js. Everything is idempotent: an already-prefixed title is left alone.

const fs = require('fs');
const path = require('path');

const LABEL_RE = /^HUB\d{4,}(?:-\d+)?/;
const TITLE_PREFIX_RE = /^HUB\d{4,}(?: · \d+\/\d+)? · /;

function serialFile(pipelineDir) { return path.join(pipelineDir, 'queue', 'hub-serials.json'); }
function formatHubLabel(n) { return `HUB${String(n).padStart(4, '0')}`; }
function hasHubTitlePrefix(title) { return TITLE_PREFIX_RE.test(String(title || '')); }

// Tiny O_EXCL lock: allocation is read-modify-write and the apply loop, the sweep and a manual run can overlap.
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 3000;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.unlinkSync(lock); continue; } } catch { /* raced with the holder */ }
      if (Date.now() > deadline) throw new Error(`hub-serial: timed out waiting for ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* already gone */ } }
}

// Reserve `count` consecutive serials; returns the first. count > 1 is for the backfill.
function allocateHubSerials(pipelineDir, count = 1) {
  const file = serialFile(pipelineDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => {
    let next = 1;
    try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (Number.isInteger(cur.next) && cur.next >= 1) next = cur.next; } catch { /* first use */ }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ next: next + count }, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return next;
  });
}
function allocateHubSerial(pipelineDir) { return allocateHubSerials(pipelineDir, 1); }

// "HUB0007 · <title>", replacing a leading `<candidateId> · ` / `<candidateId> -- ` / `<candidateId>: ` and any earlier HUB prefix.
function hubTitle(label, title, candidateId) {
  let t = String(title || '').replace(TITLE_PREFIX_RE, '');
  if (candidateId) {
    const id = String(candidateId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^${id}\\s*(?:·|--|—|–|:|-)\\s*`, 'i'), '');
  }
  return `${label} · ${t}`;
}

function memberTitle(label, seq, total, title) {
  return `${label} · ${seq}/${total} · ${String(title || '').replace(TITLE_PREFIX_RE, '')}`;
}

function memberId(label, seq, slug) {
  return `${label}-${String(seq).padStart(2, '0')}-${slug}`;
}

// Stamp serials on every coordinating hub that has none, oldest first, so the numbering follows creation order. Retitles the hub. Returns the
// number labelled. The hub file is the sweep's own to write (it rewrites it every tick).
function assignMissingHubSerials(pipelineDir) {
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  let names;
  try { names = fs.readdirSync(coordDir).filter((f) => f.endsWith('.json')); } catch { return 0; }
  const todo = [];
  for (const name of names) {
    const file = path.join(coordDir, name);
    try {
      const hub = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (hub && !hub.hubSerial && Array.isArray(hub.subTasks) && hub.subTasks.length) todo.push({ file, hub, at: Date.parse(hub.createdAt) || 0 });
    } catch { /* malformed -- not ours */ }
  }
  if (!todo.length) return 0;
  todo.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
  let n = allocateHubSerials(pipelineDir, todo.length);
  let labelled = 0;
  for (const { file, hub } of todo) {
    hub.hubSerial = n;
    hub.hubLabel = formatHubLabel(n);
    n += 1;
    hub.title = hubTitle(hub.hubLabel, hub.title, hub.promptContext && hub.promptContext.candidateId);
    try { fs.writeFileSync(file, JSON.stringify(hub, null, 2)); labelled += 1; } catch { /* retried next tick (a serial is then skipped, which is harmless) */ }
  }
  return labelled;
}

// States whose record no worker or loop is mid-write on; a child in drafting/pending/review/approved is retitled on a later tick, once it settles.
const RETITLE_SAFE_STATES = new Set(['adhoc', 'derived', 'blocked', 'needs-clarification', 'awaiting-confirm', 'done']);

// Give every member a `HUB#### · i/n · ` title. hub.subTasks[].title always follows; the member's own record only when it is safe to write.
// recById: Map<childId, { task, state, file } | null>. Returns the count of member records rewritten.
function retitleHubMembers(hub, recById) {
  if (!hub || !hub.hubLabel || !Array.isArray(hub.subTasks)) return 0;
  const total = hub.subTasks.length;
  let rewritten = 0;
  hub.subTasks.forEach((st, i) => {
    if (!st || !st.id) return;
    const rec = recById.get(st.id);
    const base = (rec && rec.task && rec.task.title) || st.title || '';
    const want = hasHubTitlePrefix(base) ? base : memberTitle(hub.hubLabel, i + 1, total, base);
    st.title = want;
    if (!rec || !rec.task || !rec.file || hasHubTitlePrefix(rec.task.title) || !RETITLE_SAFE_STATES.has(rec.state)) return;
    try {
      const before = fs.statSync(rec.file).mtimeMs;
      const fresh = JSON.parse(fs.readFileSync(rec.file, 'utf8'));
      if (hasHubTitlePrefix(fresh.title)) return;
      fresh.title = want;
      if (fs.statSync(rec.file).mtimeMs !== before) return; // something wrote it meanwhile -- retry next tick
      const tmp = `${rec.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2) + '\n');
      fs.renameSync(tmp, rec.file);
      rec.task.title = want;
      rewritten += 1;
    } catch { /* best-effort: retried next tick */ }
  });
  return rewritten;
}

module.exports = {
  formatHubLabel, hasHubTitlePrefix, allocateHubSerial, allocateHubSerials, hubTitle, memberTitle, memberId,
  assignMissingHubSerials, retitleHubMembers, LABEL_RE,
};
