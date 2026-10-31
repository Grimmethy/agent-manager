'use strict';

// hub-add-piece.js -- append ONE follow-up piece to a hub that is already coordinating (2026-10-31, HUB0295-05).
//
// Why: a hub's piece list is fixed when it is decomposed (apply-adhoc-diff.js queueSubTasks -> the hub record's `subTasks`). The only way to add a
// corrective piece to a claimed hub was to file one more stacked child by hand. That child ran, but the hub did not know about it: the coordinator
// sweep builds each hub's checklist from `subTasks`, and python/dashboard/app_branch_helpers.py `_summarize_hub` computes readyToMerge from the same
// list, so the hub read "ready to merge" without the corrective piece and its branch could be verified and merged first.
//
// What it does (one implementation: the dashboard route POST /api/hub/<hubRecordId>/pieces runs this file as a subprocess, like rereview-task.js, so
// the route, the CLI and any future caller cannot diverge):
//   - NEW piece: builds the child exactly the way queueSubTasks does (id HUB####-NN-<slug>, title `HUB#### · n/n · ...`, domain adhoc, source manual,
//     promptContext {rawText, decomposedFrom: <hub id>}, the `Files:` line, premium inherited, stacked {branch, seq, total} on the hub's chain and
//     dependsOn the previous piece), writes it atomically to queue/adhoc, then appends {id, title, status:'pending'} to the hub's `subTasks`.
//   - ADOPT (--adopt <childId>): the child record already exists (a piece filed by hand before this existed). It is attached to the hub's `subTasks`
//     and left otherwise untouched; it must name this hub in promptContext.decomposedFrom.
// The coordinator sweep (agent-manager-hub-tasks, restackHubChain) then renumbers every not-yet-started piece's stacked.seq/total and dependsOn from
// the hub's order, retitles them, and `_summarize_hub` keeps the hub not-ready until the new piece is built.
//
// Safety: only a hub that is still in queue/coordinating/ (a finished hub is in done/); never a file-decompose hub (`mode` / `decomposeHub`: its own
// model); refuses a duplicate id and a child that sits in another hub; atomic writes (tmp + rename). The coordinator rewrites hub records with a plain
// writeFileSync and takes no lock, so a hub write can be lost to a sweep that read the hub before ours: after writing, the hub is read back (twice,
// a short wait apart) and the entry re-applied if it vanished. Re-running the same command is idempotent.
// Kill switch: AGENT_MANAGER_HUB_ADD_PIECE=false.
//
// CLI: node src/hub-add-piece.js <hubRecordId> --title "..." --prompt-context-file f.json [--files a,b] [--depends-on id] [--who name] [--reason "..."]
//        node src/hub-add-piece.js <hubRecordId> --adopt <childId> [--who name] [--reason "..."]
//      Pipeline dir: --pipeline-dir, else AGENT_MANAGER_PIPELINE_DIR. Prints one line of JSON: { ok, ... } or { ok:false, error }.

const fs = require('fs');
const path = require('path');
const { memberId, memberTitle } = require('./hub-serial.js');
const { slugify } = require('./apply-adhoc-diff.js');
const { ownerGateFor } = require('./owner-gates.js');
const { validProposalFiles } = require('./proposal-files.js');
const { validPrerequisiteHubs } = require('./hub-prerequisites.js');
const { appendHistoryEvent } = require('./task-history.js');

const CHILD_STATES = ['adhoc', 'derived', 'pending', 'review', 'approved', 'blocked', 'needs-clarification', 'awaiting-confirm', 'research', 'done'];

function enabled() { return String(process.env.AGENT_MANAGER_HUB_ADD_PIECE || '').trim().toLowerCase() !== 'false'; }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// -> { state, file, task } for a task id anywhere a hub child can sit (incl. any drafting/<lane>/), else null.
function findTask(queueDir, id) {
  for (const state of CHILD_STATES) {
    const file = path.join(queueDir, state, `${id}.json`);
    if (fs.existsSync(file)) return { state, file, task: readJson(file) };
  }
  const drafting = path.join(queueDir, 'drafting');
  try {
    for (const lane of fs.readdirSync(drafting)) {
      const file = path.join(drafting, lane, `${id}.json`);
      if (fs.existsSync(file)) return { state: 'drafting', file, task: readJson(file) };
    }
  } catch { /* no drafting dir */ }
  for (const sub of ['_archived_no_action', '_superseded']) {
    const file = path.join(queueDir, 'done', sub, `${id}.json`);
    if (fs.existsSync(file)) return { state: 'archived', file, task: readJson(file) };
  }
  return null;
}

function hubOf(queueDir, hubId) {
  const file = path.join(queueDir, 'coordinating', `${hubId}.json`);
  if (!fs.existsSync(file)) return { error: `no coordinating hub '${hubId}' (a finished or retired hub cannot take a new piece)` };
  const hub = readJson(file);
  if (!hub || !Array.isArray(hub.subTasks) || !hub.subTasks.length) return { error: `hub '${hubId}' has no subTasks list to extend` };
  if (hub.decomposeHub === true || hub.mode) return { error: `hub '${hubId}' is a file-decompose hub (its own model): pieces cannot be added to it` };
  if (!hub.hubLabel) return { error: `hub '${hubId}' has no hubLabel` };
  return { file, hub };
}

// The chain the hub's pieces share: { branch, maxSeq } from their records, or { branch: null } for a hub of independent pieces. Several branches = refuse.
function chainOf(queueDir, hub) {
  const branches = new Set();
  let maxSeq = 0;
  for (const st of hub.subTasks) {
    if (!st || !st.id) continue;
    const rec = findTask(queueDir, st.id);
    const stacked = rec && rec.task && rec.task.stacked;
    if (stacked && stacked.branch) { branches.add(stacked.branch); maxSeq = Math.max(maxSeq, Number(stacked.seq) || 0); }
  }
  if (branches.size > 1) return { error: `the hub's pieces span ${branches.size} branches; refusing to guess which chain to join` };
  return { branch: branches.size ? [...branches][0] : null, maxSeq };
}

// Read the hub back and make sure `entry` is in its subTasks; re-apply when a sweep's stale write dropped it. Returns true when present at the end.
function ensureListed(hubFile, entry, sleep) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    sleep(attempt === 0 ? 0 : 1500);
    const fresh = readJson(hubFile);
    if (!fresh || !Array.isArray(fresh.subTasks)) return false;
    if (fresh.subTasks.some((s) => s && s.id === entry.id)) { if (attempt >= 1) return true; continue; }
    fresh.subTasks.push({ ...entry });
    writeJsonAtomic(hubFile, fresh);
  }
  const last = readJson(hubFile);
  return !!(last && Array.isArray(last.subTasks) && last.subTasks.some((s) => s && s.id === entry.id));
}

function addPieceToHub({ pipelineDir, hubId, title, rawText, files, dependsOn, prerequisiteHubs, adopt, who, reason, now = () => new Date().toISOString(), sleep = (ms) => { if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } }) {
  if (!enabled()) return { ok: false, error: 'hub add-piece is switched off (AGENT_MANAGER_HUB_ADD_PIECE=false)' };
  if (!pipelineDir || !hubId) return { ok: false, error: 'pipelineDir and hubId are required' };
  const queueDir = path.join(pipelineDir, 'queue');
  const found = hubOf(queueDir, hubId);
  if (found.error) return { ok: false, error: found.error };
  const { file: hubFile, hub } = found;
  const by = who || 'operator';

  // ---------------------------------------------------------------- adopt an existing child
  if (adopt) {
    if (hub.subTasks.some((s) => s && s.id === adopt)) return { ok: true, id: adopt, adopted: true, already: true, total: hub.subTasks.length };
    const rec = findTask(queueDir, adopt);
    if (!rec || !rec.task) return { ok: false, error: `no task record '${adopt}' to adopt` };
    const owner = rec.task.promptContext && rec.task.promptContext.decomposedFrom;
    if (owner !== hub.id) return { ok: false, error: `'${adopt}' names '${owner || 'no hub'}' in promptContext.decomposedFrom, not '${hub.id}'` };
    const chain = chainOf(queueDir, hub);
    if (chain.error) return { ok: false, error: chain.error };
    if (chain.branch && rec.task.stacked && rec.task.stacked.branch && rec.task.stacked.branch !== chain.branch) return { ok: false, error: `'${adopt}' is stacked on ${rec.task.stacked.branch}, the hub's chain is ${chain.branch}` };
    const entry = { id: adopt, title: rec.task.title || adopt, status: 'pending' };
    return finish({ hub, hubFile, entry, by, reason, now, sleep, adopted: true });
  }

  // ---------------------------------------------------------------- build a new child
  if (!title || !String(title).trim()) return { ok: false, error: 'title is required' };
  if (!rawText || !String(rawText).trim()) return { ok: false, error: 'rawText (the self-contained piece text) is required' };
  const chain = chainOf(queueDir, hub);
  if (chain.error) return { ok: false, error: chain.error };
  const n = hub.subTasks.length + 1;
  const id = memberId(hub.hubLabel, n, slugify(String(title)));
  if (findTask(queueDir, id) || hub.subTasks.some((s) => s && s.id === id)) return { ok: false, error: `a task with id '${id}' already exists` };
  const last = hub.subTasks[hub.subTasks.length - 1];
  const record = {
    id,
    domain: 'adhoc',
    source: 'manual',
    title: memberTitle(hub.hubLabel, n, n, String(title).trim()),
    promptContext: { rawText: String(rawText), decomposedFrom: hub.id },
  };
  if (chain.branch) {
    const seq = Math.max(chain.maxSeq, hub.subTasks.length) + 1;
    record.stacked = { branch: chain.branch, seq, total: seq };
  }
  const deps = Array.isArray(dependsOn) && dependsOn.length ? dependsOn : (chain.branch && last && last.id ? [last.id] : []);
  if (deps.length) record.dependsOn = deps;
  const declared = validProposalFiles(files);
  if (declared && !/^Files:/im.test(record.promptContext.rawText)) record.promptContext.rawText += `\nFiles: ${declared.join(', ')}`;
  if (hub.premiumPriority) { record.premiumPriority = true; if (hub.premiumSetBy) record.premiumSetBy = hub.premiumSetBy; }
  const prereq = validPrerequisiteHubs(prerequisiteHubs);
  if (prereq) record.prerequisiteHubs = prereq;
  fs.mkdirSync(path.join(queueDir, 'adhoc'), { recursive: true });
  const childFile = path.join(queueDir, 'adhoc', `${id}.json`);
  writeJsonAtomic(childFile, record);
  const entry = { id, title: record.title, status: 'pending' };
  const gate = ownerGateFor({ id, title: record.title, rawText: record.promptContext.rawText });
  return finish({ hub, hubFile, entry, by, reason, now, sleep, gate, seq: record.stacked && record.stacked.seq });
}

function finish({ hub, hubFile, entry, by, reason, now, sleep, gate, adopted, seq }) {
  // Re-read just before writing so we extend the freshest copy; the coordinator may have rewritten the hub since `hub` was read.
  const fresh = readJson(hubFile) || hub;
  if (!fresh.subTasks.some((s) => s && s.id === entry.id)) fresh.subTasks.push({ ...entry });
  if (gate) fresh.ownerGates = [...(Array.isArray(fresh.ownerGates) ? fresh.ownerGates : []), gate];
  appendHistoryEvent(fresh, 'advisory', `piece ${entry.id} ${adopted ? 'adopted into' : 'added to'} the hub by ${by}${reason ? `: ${reason}` : ''} -- the hub is not ready to merge until it is built`);
  fresh.piecesAddedAt = now();
  writeJsonAtomic(hubFile, fresh);
  const kept = ensureListed(hubFile, entry, sleep);
  if (!kept) return { ok: false, error: `the hub record lost '${entry.id}' to a concurrent coordinator write three times; re-run the same command (it is idempotent)` };
  const total = (readJson(hubFile) || fresh).subTasks.length;
  return { ok: true, id: entry.id, adopted: !!adopted, total, ...(seq ? { seq } : {}), ...(gate ? { ownerGate: gate.why } : {}) };
}

// ------------------------------------------------------------------------------------------------ CLI
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else out._.push(a);
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const hubId = args._[0];
  const pipelineDir = args['pipeline-dir'] || process.env.AGENT_MANAGER_PIPELINE_DIR;
  let rawText = args['raw-text'];
  let files = typeof args.files === 'string' ? args.files.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  let prerequisiteHubs;
  if (args['prompt-context-file']) {
    const pc = readJson(args['prompt-context-file']);
    if (!pc) return { ok: false, error: `could not read ${args['prompt-context-file']}` };
    rawText = pc.rawText;
    if (Array.isArray(pc.files) && !files) files = pc.files;
    prerequisiteHubs = pc.prerequisiteHubs;
  }
  return addPieceToHub({
    pipelineDir, hubId, title: args.title, rawText, files, prerequisiteHubs,
    dependsOn: typeof args['depends-on'] === 'string' ? args['depends-on'].split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    adopt: typeof args.adopt === 'string' ? args.adopt : undefined, who: args.who, reason: typeof args.reason === 'string' ? args.reason : undefined,
  });
}

if (require.main === module) {
  let result;
  try { result = main(process.argv.slice(2)); } catch (e) { result = { ok: false, error: String((e && e.message) || e) }; }
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

module.exports = { addPieceToHub, findTask, chainOf };
