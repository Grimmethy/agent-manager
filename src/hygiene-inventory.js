'use strict';

// hygiene-inventory.js -- one read-only picture of the hygiene backlog for the dashboard's Hygiene tab.
//
// Why (2026-09-19): "don't create new tasks before working through what exists" is a sound throttle when the pile is
// visible (brain dump entries are). Hygiene work is not: scanners keep findings in queue/*-flags.json, reviews turn them
// into Docs/*_CANDIDATES.md, fixes become tasks and branches -- and the queue only shows the slice already tasked. AM had
// ~520 flags not yet tasked plus 346 pending change_review tasks with nothing surfacing any of it.
//
// Per hygiene family this joins every stage of the funnel, all read straight off disk / git with NO side effects:
//   scanner flags       -> each plugin's registered `inventory({ taskState })` hook (the flag->task-id rules live in the
//                          plugin, so the plugin answers; core never re-derives them)
//   candidate docs      -> the doc as merged on the default branch, plus candidates that exist only on unmerged agent/*
//                          branches ("awaiting your merge"), each with its fix/review task state
//   tasks               -> per-family counts by queue state and by done-disposition
//
// Everything is computed for the ACTIVE project (AGENT_MANAGER_REPO_ROOT / PIPELINE_DIR), i.e. whatever the dashboard's
// project selector points at. CLI: `node src/hygiene-inventory.js` prints the JSON the /api/hygiene/inventory route serves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const IN_FLIGHT = ['pending', 'drafting', 'review', 'approved'];
const NEEDS_HUMAN = ['blocked', 'needs-clarification', 'awaiting-confirm', 'coordinating'];
const QUEUE_STATES = [...IN_FLIGHT, ...NEEDS_HUMAN, 'done'];

// family -> the task sources it covers, the task-id filename prefixes (so we only READ files that can belong to it --
// done/ holds thousands), the source whose `inventory` hook holds its flags, and the sources whose candidate doc it owns.
const FAMILIES = [
  { key: 'observability', label: 'Observability', sources: ['observability_review', 'observability_review_digest', 'observability_fix'], prefixes: ['observability-'], flagSource: 'observability_review', docSources: ['observability_fix'] },
  { key: 'performance', label: 'Performance', sources: ['performance_review', 'performance_fix'], prefixes: ['performance-'], flagSource: 'performance_review', docSources: ['performance_fix'] },
  { key: 'function_length', label: 'Function length', sources: ['function_length_review', 'function_length_fix'], prefixes: ['function-length-'], flagSource: 'function_length_review', docSources: ['function_length_fix'] },
  { key: 'unused_export', label: 'Unused exports', sources: ['unused_export'], prefixes: ['deadcode-'], flagSource: 'unused_export', docSources: [] },
  { key: 'arch', label: 'Architecture', sources: ['arch_discovery', 'arch_review', 'arch_import', 'arch_import_review'], prefixes: ['arch-'], flagSource: null, docSources: ['arch_review', 'arch_import_review'] },
  { key: 'change_review', label: 'Change review', sources: ['change_review', 'change_review_fix'], prefixes: ['change-review-'], flagSource: null, docSources: ['change_review_fix'] },
];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function listJson(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
}

// --- per-file metadata cache -----------------------------------------------------------------------------------------
// The done/ task files are large and rarely change; parsing ~8 MB of them on every request cost ~2 s on AM. This caches
// {source, disposition} per file, keyed by mtime+size, in the agent-manager STATE dir (NOT the pipeline dir -- this view
// never writes to the queue). Any cache problem just means re-reading the file.
function makeMetaCache(pipelineDir) {
  const dir = path.join(os.homedir(), '.local', 'state', 'agent-manager');
  const file = path.join(dir, `hygiene-inventory-cache-${crypto.createHash('sha1').update(String(pipelineDir)).digest('hex').slice(0, 12)}.json`);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { data = {}; }
  const seen = new Set();
  let dirty = false;
  return {
    // -> { source, disposition } | null
    meta(fp) {
      let st;
      try { st = fs.statSync(fp); } catch { return null; }
      seen.add(fp);
      const c = data[fp];
      if (c && c.m === st.mtimeMs && c.s === st.size) return c;
      const d = readJson(fp);
      if (!d) return null;
      const entry = { m: st.mtimeMs, s: st.size, source: d.source === 'deadcode_triage' ? 'unused_export' : (d.source || null), disposition: d.terminalDisposition || null };
      data[fp] = entry;
      dirty = true;
      return entry;
    },
    // Drops entries for files no longer present (a full scan just visited every live one), then persists if anything changed.
    save() {
      for (const k of Object.keys(data)) if (!seen.has(k)) { delete data[k]; dirty = true; }
      if (!dirty) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, file);
      } catch { /* cache is best-effort */ }
    },
  };
}

// --- task lookup -----------------------------------------------------------------------------------------------------

function archivedMonthDirs(queueDir) {
  const root = path.join(queueDir, 'done', '_archived');
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  } catch { return []; }
}

// taskState(id) -> null | { state, disposition }. state is a queue dir name, 'done' or 'archived'. Reads ONE file, only
// for the states that carry a disposition (done / archived).
function makeTaskLookup(queueDir, cache = null) {
  const months = archivedMonthDirs(queueDir);
  const dispositionOf = (file) => {
    const m = cache ? cache.meta(file) : (() => { const d = readJson(file); return d ? { disposition: d.terminalDisposition || null } : null; })();
    return (m && m.disposition) || 'unclassified';
  };
  return function taskState(id) {
    const noAction = path.join(queueDir, 'done', '_archived_no_action', `${id}.json`);
    if (fs.existsSync(noAction)) return { state: 'archived', disposition: dispositionOf(noAction) };
    for (const dir of months) {
      const f = path.join(dir, `${id}.json`);
      if (fs.existsSync(f)) return { state: 'archived', disposition: dispositionOf(f) };
    }
    for (const state of QUEUE_STATES) {
      if (state === 'drafting') {
        const draftingDir = path.join(queueDir, 'drafting');
        if (fs.existsSync(path.join(draftingDir, `${id}.json`))) return { state: 'drafting', disposition: null };
        let entries = [];
        try { entries = fs.readdirSync(draftingDir, { withFileTypes: true }); } catch { /* none */ }
        if (entries.some((e) => e.isDirectory() && fs.existsSync(path.join(draftingDir, e.name, `${id}.json`)))) return { state: 'drafting', disposition: null };
        continue;
      }
      const f = path.join(queueDir, state, `${id}.json`);
      if (fs.existsSync(f)) return { state, disposition: state === 'done' ? dispositionOf(f) : null };
    }
    return null;
  };
}

// --- task funnel -----------------------------------------------------------------------------------------------------

function familyOfFile(name) {
  return FAMILIES.find((f) => f.prefixes.some((p) => name.startsWith(p))) || null;
}

function emptyTaskCounts() {
  return { byState: {}, done: {}, awaitingMerge: 0, archivedOlder: 0, total: 0, bySource: {} };
}

// One pass over the queue dirs, READING only files whose name matches a family prefix.
function scanTaskFunnel(queueDir, cache = null) {
  const out = Object.fromEntries(FAMILIES.map((f) => [f.key, emptyTaskCounts()]));
  const add = (fam, source, state, disposition) => {
    const c = out[fam.key];
    c.total += 1;
    c.bySource[source || '?'] = (c.bySource[source || '?'] || 0) + 1;
    if (state === 'done' || state === 'archived') {
      const d = disposition || 'unclassified';
      c.done[d] = (c.done[d] || 0) + 1;
      if (d === 'pending-merge') c.awaitingMerge += 1;
    } else {
      c.byState[state] = (c.byState[state] || 0) + 1;
    }
  };
  const scanDir = (dir, state, { nested = false } = {}) => {
    const files = nested
      ? (() => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => listJson(path.join(dir, e.name)).map((f) => path.join(dir, e.name, f))); } catch { return []; } })()
      : listJson(dir).map((f) => path.join(dir, f));
    for (const file of files) {
      const fam = familyOfFile(path.basename(file));
      if (!fam) continue;
      let m;
      if (cache) m = cache.meta(file);
      else { const d = readJson(file); m = d ? { source: d.source === 'deadcode_triage' ? 'unused_export' : d.source, disposition: d.terminalDisposition || null } : null; }
      if (!m) continue;
      add(fam, m.source, state, state === 'done' || state === 'archived' ? (m.disposition || null) : null);
    }
  };
  for (const state of [...IN_FLIGHT, ...NEEDS_HUMAN, 'done']) scanDir(path.join(queueDir, state), state, { nested: state === 'drafting' });
  scanDir(path.join(queueDir, 'done', '_archived_no_action'), 'archived');
  // Dated month buckets can be huge: count by filename only (never read), so the number is "how many older ones exist".
  for (const dir of archivedMonthDirs(queueDir)) {
    for (const f of listJson(dir)) { const fam = familyOfFile(f); if (fam) out[fam.key].archivedOlder += 1; }
  }
  return out;
}

// --- candidate docs --------------------------------------------------------------------------------------------------

// Cheap, tolerant parse of a candidates doc: `### AC-<n> · <title>` blocks with Strength:/Files:/Depends-On: lines, plus
// the facts nextCandidateFulfillmentTask's eligibility rules read (size, dependency, placeholder body).
function parseCandidateHeaders(text) {
  const out = [];
  const isPlaceholder = (m) => !m || m[1].trim() === '' || /^\.{3,}$/.test(m[1].trim());
  for (const section of String(text || '').split(/^(?=### )/m)) {
    const h = section.match(/^###\s*AC-(\d+)\s*(?:[·:—-]\s*)?(.*)$/m);
    if (!h) continue;
    const line = (re) => { const m = section.match(re); return m ? m[1].trim() : ''; };
    const problem = section.match(/^Problem:\s*\n?([\s\S]*?)(?=\n(?:Solution|Benefits):|$)/m);
    const solution = section.match(/^Solution:\s*\n?([\s\S]*?)(?=\nBenefits:|$)/m);
    out.push({
      n: parseInt(h[1], 10), title: (h[2] || '').trim().slice(0, 160),
      strength: line(/^Strength:\s*(.+)$/m) || 'Strong', files: line(/^Files:\s*(.+)$/m),
      chars: section.length, dependsOn: line(/^Depends-On:\s*(AC-\d+)\s*$/m) || null,
      placeholder: isPlaceholder(problem) || isPlaceholder(solution),
    });
  }
  return out;
}

function candidateDocPath(entry) {
  try { return typeof entry.candidatesPath === 'function' ? entry.candidatesPath() : entry.candidatesPath; } catch { return null; }
}

// Why a Strong candidate with no task will NOT be picked up -- the same filters nextCandidateFulfillmentTask applies
// (sdk/lib/candidate-lifecycle.js), in the same order. null = eligible.
function ineligibleReason(c, { prefix, isDependencySatisfied, maxChars }) {
  if (c.dependsOn && isDependencySatisfied && !isDependencySatisfied(`${prefix}-${c.dependsOn.toLowerCase()}`)) return `depends on ${c.dependsOn}, which is not merged`;
  if (c.chars > maxChars) return `oversized: ${c.chars} chars > the ${maxChars}-char limit -- the fulfillment step skips it forever; it needs narrowing`;
  if (c.placeholder) return 'placeholder Problem/Solution body';
  return null;
}

function inventoryCandidateDoc({ sourceName, entry, taskState, repoRoot, isDependencySatisfied, maxChars }) {
  const docPath = candidateDocPath(entry);
  if (!docPath) return null;
  const refs = require('./lib/candidate-doc-refs.js').readCandidateDocRefs(docPath);
  const mainText = refs.gitAnswered ? refs.main : (fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '');
  const onMain = parseCandidateHeaders(mainText);
  const mainIds = new Set(onMain.map((c) => c.n));
  const prefix = sourceName.replace(/_/g, '-');
  const items = [];
  const push = (c, location) => {
    const id = `AC-${c.n}`;
    const ts = location === 'main' ? taskState(`${prefix}-ac-${c.n}`) : null;
    let status;
    let reason = null;
    if (location !== 'main') status = 'awaiting-merge';
    else if (ts) status = IN_FLIGHT.includes(ts.state) ? 'queued' : NEEDS_HUMAN.includes(ts.state) ? 'blocked' : 'done';
    else if (String(c.strength).trim() !== 'Strong') status = 'not-actionable';
    else {
      reason = ineligibleReason(c, { prefix, isDependencySatisfied, maxChars });
      status = reason ? 'ineligible' : 'waiting';
    }
    items.push({ id, n: c.n, title: c.title, strength: c.strength, files: c.files, chars: c.chars, status, reason, location, taskState: ts ? ts.state : null, disposition: ts ? ts.disposition : null });
  };
  onMain.forEach((c) => push(c, 'main'));
  const seenBranchIds = new Set();
  for (const b of refs.branches) {
    for (const c of parseCandidateHeaders(b.text)) {
      if (mainIds.has(c.n) || seenBranchIds.has(c.n)) continue; // already merged, or already listed from another branch
      seenBranchIds.add(c.n);
      push(c, `unmerged:${b.ref}`);
    }
  }
  const byStatus = {};
  for (const it of items) byStatus[it.status] = (byStatus[it.status] || 0) + 1;
  return {
    source: sourceName,
    path: docPath,
    relPath: repoRoot && docPath.startsWith(repoRoot) ? path.relative(repoRoot, docPath) : path.basename(docPath),
    total: items.length, byStatus,
    items: items.sort((a, b) => a.n - b.n),
  };
}

// --- assemble --------------------------------------------------------------------------------------------------------

function buildHygieneInventory({ getRegisteredSource, getConfig, now = new Date(), isDependencySatisfied = null, maxChars = null }) {
  const { repoRoot, pipelineDir } = getConfig();
  // Eligibility inputs come from the real fulfillment code so the two cannot drift apart.
  const maxCharsResolved = maxChars || require('./sdk/lib/candidate-lifecycle.js').MAX_ARCH_REVIEW_TASK_CHARS;
  const depCheck = isDependencySatisfied || ((id) => require('./task-sources.js').isDependencySatisfied(pipelineDir, id));
  const queueDir = path.join(pipelineDir, 'queue');
  const cache = makeMetaCache(pipelineDir);
  const taskState = makeTaskLookup(queueDir, cache);
  const funnel = scanTaskFunnel(queueDir, cache);
  const notes = [];

  const families = FAMILIES.map((fam) => {
    // scanner flags -- the plugin's own hook (its id formula / skip rules), pure read
    let flags = null;
    const flagEntry = fam.flagSource ? getRegisteredSource(fam.flagSource) : null;
    if (flagEntry && typeof flagEntry.inventory === 'function') {
      try { flags = flagEntry.inventory({ taskState }); } catch (e) { notes.push(`${fam.key}: flag inventory failed: ${e.message}`); }
    }
    // candidate docs
    const docs = [];
    for (const sourceName of fam.docSources) {
      const entry = getRegisteredSource(sourceName);
      if (!entry) continue;
      try {
        const d = inventoryCandidateDoc({ sourceName, entry, taskState, repoRoot, isDependencySatisfied: depCheck, maxChars: maxCharsResolved });
        if (d) docs.push(d);
      } catch (e) { notes.push(`${fam.key}: candidate doc ${sourceName} failed: ${e.message}`); }
    }
    const cand = { waiting: 0, ineligible: 0, awaitingMerge: 0, queued: 0, blocked: 0, done: 0, notActionable: 0 };
    for (const d of docs) {
      cand.waiting += d.byStatus.waiting || 0; cand.ineligible += d.byStatus.ineligible || 0; cand.awaitingMerge += d.byStatus['awaiting-merge'] || 0; cand.queued += d.byStatus.queued || 0;
      cand.blocked += d.byStatus.blocked || 0; cand.done += d.byStatus.done || 0; cand.notActionable += d.byStatus['not-actionable'] || 0;
    }
    const tasks = funnel[fam.key];
    const inFlight = IN_FLIGHT.reduce((n, s) => n + (tasks.byState[s] || 0), 0);
    const needsHuman = NEEDS_HUMAN.reduce((n, s) => n + (tasks.byState[s] || 0), 0);
    const registered = fam.sources.filter((s) => getRegisteredSource(s));
    return {
      key: fam.key, label: fam.label, sources: registered, available: registered.length > 0,
      flags, candidates: docs.length ? { docs, totals: cand } : null, tasks,
      // The headline numbers: what is waiting on a WORKER (flags + Strong candidates not yet tasked), what is in
      // flight, what needs a HUMAN decision, and what waits on the human MERGE.
      open: {
        waitingFlags: flags ? flags.counts.waiting : 0,
        waitingCandidates: cand.waiting,
        stuckCandidates: cand.ineligible,
        inFlight, needsHuman,
        awaitingMerge: cand.awaitingMerge + tasks.awaitingMerge,
      },
    };
  });

  // Advisory-only: the file-length scan flags oversized files but nothing tasks them automatically.
  const fl = readJson(path.join(queueDir, 'file-length-flags.json'));
  const flItems = fl ? (Array.isArray(fl) ? fl : (fl.findings || fl.flags || [])) : [];
  const fileLength = { key: 'file_length', label: 'File length (advisory)', advisory: true, total: flItems.length, items: flItems.slice(0, 200).map((f) => ({ file: f.file || null, lines: f.lines || f.lineCount || null })) };

  const totals = families.reduce((t, f) => ({
    waitingFlags: t.waitingFlags + f.open.waitingFlags,
    waitingCandidates: t.waitingCandidates + f.open.waitingCandidates,
    stuckCandidates: t.stuckCandidates + f.open.stuckCandidates,
    inFlight: t.inFlight + f.open.inFlight,
    needsHuman: t.needsHuman + f.open.needsHuman,
    awaitingMerge: t.awaitingMerge + f.open.awaitingMerge,
  }), { waitingFlags: 0, waitingCandidates: 0, stuckCandidates: 0, inFlight: 0, needsHuman: 0, awaitingMerge: 0 });

  cache.save();
  return { generatedAt: now.toISOString(), repoRoot, projectTag: path.basename(repoRoot), families, fileLength, totals, notes };
}

module.exports = { buildHygieneInventory, makeTaskLookup, scanTaskFunnel, parseCandidateHeaders, FAMILIES };

if (require.main === module) {
  // Same bootstrap as the other registry-reading CLIs: built-in sources, then any AGENT_MANAGER_REGISTER_PATH plugins.
  const { getRegisteredSource } = require('./task-source-registry.js');
  require('./task-sources.js');
  const { getConfig, ensureRegistered } = require('./config.js');
  try { ensureRegistered(); } catch { /* best-effort: built-ins still load */ }
  try {
    process.stdout.write(JSON.stringify(buildHygieneInventory({ getRegisteredSource, getConfig })));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e.message }));
    process.exitCode = 1;
  }
}
