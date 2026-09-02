'use strict';

// Deterministic "evidence bundle" assembler for a pipeline forensic study (2026-09-01,
// Grimmethy: "We've done a forensic study multiple times that has produced good results.
// Can we break this down into a formal task that agent manager can reproduce?"). The
// mechanical half of what we did by hand three times (Brain Dump #184; the
// observability_review false-positive cluster; the /api/chat/inject net-new-code
// dead-end): pull every persisted trace for a failing task class, pull the same for
// sibling tasks that SUCCEEDED, and lay them side by side so a reasoning pass can rank
// root causes by counterfactual impact.
//
// Pure + config-free, like the pure halves of pipeline-self-audit.js / system-report.js:
// the caller (pipeline-forensics.js's nextPipelineForensicsTask) passes pipelineDir +
// dbPath. The local model has NO filesystem or queue/ access, so EVERYTHING it will reason
// over has to be embedded verbatim in the returned `evidenceText` -- there is no second
// chance to fetch. Budget-capped the same way arch_discovery caps its embedded file
// content.
//
// model-stats.db is read by opening the sqlite file directly with node:sqlite (NOT
// better-sqlite3 -- the checkout is on a noexec mount, its native addon fails; NOT
// require('./model-stats-db.js') -- that module process.exit()s at load). Every non-core
// column is pragma-guarded and a missing/unreadable DB degrades to "no cost data", exactly
// as system-report.js's computeTimeAccounting already does.

const fs = require('fs');
const path = require('path');
const { signatureForTask } = require('./pipeline-self-audit.js');
const { readWorkLog } = require('./work-log.js');
const { listArchivedMonthDirs } = require('./done-archive.js');

const DEFAULT_BUDGET_CHARS = 28000;
const MAX_SUBJECTS = 4;
const MAX_WINNERS = 3;
const MAX_FULL_ATTEMPTS = 4;      // newest N draftAttempts rendered in full per task
const TIER_RESPONSE_CAP = 3000;   // the model's own per-tier final analysis -- highest signal
const WORKLOG_PREVIEW_CAP = 1800; // per task, across the last tier's tool calls
const HISTORY_DETAIL_CAP = 160;

// Every queue state a task JSON can live in, in the order findTaskRecordById checks them.
// 'drafting' is special-cased (per-instance subdirs). Mirrors task-sources.js's own
// isDependencySatisfied candidate list + python api_task_anywhere.
const STATE_DIRS = [
  'pending', 'review', 'approved', 'blocked', 'needs-clarification',
  'awaiting-confirm', 'coordinating', 'adhoc', 'research', 'done',
];

// Static map so a report can cite the real file behind each draft tier -- the model
// otherwise invents plausible-looking module names. Rendered verbatim into evidenceText.
const TIER_SOURCE_MAP = [
  ['harness-search (adhoc tier 1: blind grep-grounded diff)', 'src/adhoc-harness-draft.js'],
  ['local-agentic (adhoc tier 2: read-only tools)', 'src/local-agentic-draft.js'],
  ['local-agentic-write (adhoc tier 3: edit/write/run_bash in a worktree)', 'src/local-agentic-write-draft.js'],
  ['agentic-research (research-domain tier)', 'src/research-agentic-draft.js'],
  ['plan / implement / critique (non-adhoc path)', 'src/local-draft.js + src/prompts.js'],
  ['review (majority vote)', 'src/review-task.js'],
  ['deterministic short-circuit', 'src/staleness-fastpath.js'],
  ['the multi-turn tool loop every agentic tier shares', 'src/local-tool-client.js'],
  ['harness grep grounding', 'src/arch-import-fetch.js + src/grep-codebase-tool.js'],
  ['reject / retry / requeue after a block', 'src/reject-retry-check.js'],
];

function cap(s, n) {
  const str = typeof s === 'string' ? s : (s == null ? '' : String(s));
  return str.length > n ? `${str.slice(0, n)}\n...[+${str.length - n} chars]` : str;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The missing findTaskById. Returns { task, state, file } or null. `state` is the queue
// dir name, or 'archived' for a task under done/_archived/<month>/, or 'archived_no_action'.
function findTaskRecordById(pipelineDir, id) {
  const queueDir = path.join(pipelineDir, 'queue');
  for (const state of STATE_DIRS) {
    const file = path.join(queueDir, state, `${id}.json`);
    const task = readJson(file);
    if (task) return { task, state, file };
  }
  // drafting/<instance>/<id>.json
  try {
    const draftingRoot = path.join(queueDir, 'drafting');
    for (const sub of fs.readdirSync(draftingRoot)) {
      const file = path.join(draftingRoot, sub, `${id}.json`);
      const task = readJson(file);
      if (task) return { task, state: 'drafting', file };
    }
  } catch { /* no drafting/ */ }
  // done/_archived_no_action/<id>.json
  const naFile = path.join(queueDir, 'done', '_archived_no_action', `${id}.json`);
  const na = readJson(naFile);
  if (na) return { task: na, state: 'archived_no_action', file: naFile };
  // done/_archived/<YYYY-MM>/<id>.json
  for (const monthDir of listArchivedMonthDirs(pipelineDir)) {
    const file = path.join(monthDir, `${id}.json`);
    const task = readJson(file);
    if (task) return { task, state: 'archived', file };
  }
  return null;
}

// Every task JSON in one queue state dir (best-effort per file).
function readStateDir(pipelineDir, state) {
  const dir = path.join(pipelineDir, 'queue', state);
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const t = readJson(path.join(dir, name));
    if (t) out.push(t);
  }
  return out;
}

function terminalTs(task) {
  const hist = Array.isArray(task.history) ? task.history : [];
  if (hist.length && hist[hist.length - 1].at) return hist[hist.length - 1].at;
  return task.createdAt || null;
}

// --- model_calls (node:sqlite, read-only, pragma-guarded) -----------------------------

const CORE_CALL_COLUMNS = ['call_id', 'task_id', 'stage', 'model', 'started_at'];
const WANT_CALL_COLUMNS = [
  'latency_ms', 'eval_count', 'prompt_eval_count', 'turns_used', 'attempts',
  'degenerate', 'call_error', 'outcome', 'outcome_stage', 'outcome_reason',
  'cost_usd', 'hypothetical_cost_usd', 'source',
];

// ids -> [row, ...] (empty Map on any failure; never throws).
function readModelCallsForTasks(dbPath, ids) {
  const result = new Map();
  if (!ids || !ids.length) return result;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (err) { console.error('[forensic-bundle] readModelCallsForTasks: node:sqlite module unavailable', err); return result; }
  if (!dbPath || !fs.existsSync(dbPath)) return result;
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (err) { console.error('[forensic-bundle] readModelCallsForTasks: failed to open database', dbPath, err); return result; }
  try {
    const present = new Set(
      db.prepare(`SELECT name FROM pragma_table_info('model_calls')`).all().map((r) => r.name),
    );
    const cols = [...CORE_CALL_COLUMNS, ...WANT_CALL_COLUMNS].filter((c) => present.has(c));
    if (!cols.length) return result;
    const stmt = db.prepare(
      `SELECT ${cols.join(', ')} FROM model_calls WHERE task_id = ? ORDER BY started_at`,
    );
    for (const id of ids) {
      const rows = stmt.all(id);
      if (rows.length) result.set(id, rows);
    }
  } catch (err) {
    console.error('[forensic-bundle] readModelCallsForTasks: query execution failed', dbPath, err);
    return result;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return result;
}

function renderCallRows(rows) {
  if (!rows || !rows.length) return '  (no model_calls rows)';
  return rows.map((r) => {
    const bits = [
      `stage=${r.stage ?? '—'}`,
      `model=${r.model ?? '—'}`,
      r.turns_used != null ? `turns=${r.turns_used}` : null,
      r.latency_ms != null ? `latency=${Math.round(r.latency_ms / 1000)}s` : null,
      r.prompt_eval_count != null ? `promptTok=${r.prompt_eval_count}` : null,
      r.eval_count != null ? `evalTok=${r.eval_count}` : null,
      r.degenerate ? `degenerate=${r.degenerate}` : null,
      r.call_error ? `error=${cap(r.call_error, 80)}` : null,
      r.outcome ? `outcome=${r.outcome}${r.outcome_reason ? ` (${cap(r.outcome_reason, 80)})` : ''}` : null,
      r.hypothetical_cost_usd != null ? `~$${Number(r.hypothetical_cost_usd).toFixed(4)}` : null,
    ].filter(Boolean);
    return `  - ${bits.join('  ')}`;
  }).join('\n');
}

// --- per-task evidence section -------------------------------------------------------

function renderTier(t) {
  const head = [
    `tier=${t.tier}`,
    t.resolution ? `resolution=${t.resolution}` : null,
    t.applied != null ? `applied=${t.applied}` : null,
    t.blocked != null ? `blocked=${t.blocked}` : null,
    t.turnsUsed != null ? `turns=${t.turnsUsed}` : null,
  ].filter(Boolean).join('  ');
  const lines = [`    · ${head}`];
  if (t.toolCalls && t.toolCalls.byTool) {
    lines.push(`      toolCalls: ${JSON.stringify(t.toolCalls.byTool)}${t.toolCalls.errors ? ` errors=${t.toolCalls.errors}` : ''}`);
  }
  if (t.reason) lines.push(`      reason: ${cap(t.reason, 240)}`);
  if (t.response) lines.push(`      final message:\n${cap(t.response, TIER_RESPONSE_CAP).split('\n').map((l) => `        ${l}`).join('\n')}`);
  return lines.join('\n');
}

function renderAttempt(a) {
  const head = `attempt ${a.attemptNo ?? '?'} → ${a.outcome ?? '?'}${a.blockedReason ? ` (${cap(a.blockedReason, 200)})` : ''}`;
  const tiers = Array.isArray(a.tiers) ? a.tiers.map(renderTier).join('\n') : '    (no tiers)';
  return `  ${head}\n${tiers}`;
}

function gatherEvidenceForTask(record, worklog, callRows, { label }) {
  const { task, state } = record;
  const ctx = task.promptContext || {};
  const lines = [];
  lines.push(`### ${label}: ${task.id}`);
  lines.push(`source=${task.source || 'unknown'}  domain=${task.domain || '—'}  currentState=${state}` +
    (task.mergedAt ? `  mergedAt=${task.mergedAt}` : '') +
    (ctx.decomposedFrom ? `  decomposedFrom=${ctx.decomposedFrom}` : ''));
  if (task.title) lines.push(`title: ${task.title}`);
  if (ctx.rawText) lines.push(`ask: ${cap(ctx.rawText, 600)}`);
  if (task.blockedReason) lines.push(`blockedReason: ${cap(task.blockedReason, 400)}`);
  if (task.needsClarification) {
    lines.push(`needsClarification.reason: ${task.needsClarification.reason || '—'}`);
    if (task.needsClarification.openQuestions) lines.push(`  openQuestions: ${cap(task.needsClarification.openQuestions, 500)}`);
  }

  const hist = Array.isArray(task.history) ? task.history : [];
  if (hist.length) {
    lines.push('history:');
    for (const h of hist) lines.push(`  ${h.stage}${h.detail ? `: ${cap(h.detail, HISTORY_DETAIL_CAP)}` : ''}`);
  }

  if (Array.isArray(task.priorRejectionFeedback) && task.priorRejectionFeedback.length) {
    lines.push('priorRejectionFeedback:');
    for (const f of task.priorRejectionFeedback) lines.push(`  - ${cap(f, 300)}`);
  }

  const attempts = Array.isArray(task.draftAttempts) ? task.draftAttempts : [];
  if (attempts.length) {
    lines.push(`draftAttempts (${attempts.length} total, newest ${Math.min(MAX_FULL_ATTEMPTS, attempts.length)} in full):`);
    for (const a of attempts.slice(-MAX_FULL_ATTEMPTS)) lines.push(renderAttempt(a));
  }

  if (worklog && Array.isArray(worklog.tiers) && worklog.tiers.length) {
    const lastTier = worklog.tiers[worklog.tiers.length - 1];
    const calls = Array.isArray(lastTier.calls) ? lastTier.calls : [];
    const rendered = calls.map((c) => {
      const args = c.args && typeof c.args === 'object'
        ? Object.entries(c.args).map(([k, v]) => `${k}=${cap(v, 120)}`).join(' ')
        : '';
      return `  #${c.n} ${c.tool} ${args}${c.error ? ' [ERROR]' : ''} → ${c.resultBytes}B`;
    }).join('\n');
    lines.push(`worklog last tier (${lastTier.tier}, ${lastTier.callCount} calls):`);
    lines.push(cap(rendered, WORKLOG_PREVIEW_CAP));
    if (lastTier.finalMessage) lines.push(`  finalMessage: ${cap(lastTier.finalMessage, 800)}`);
  }

  lines.push('model_calls:');
  lines.push(renderCallRows(callRows));
  return lines.join('\n');
}

// --- subject + winner selection -----------------------------------------------------

// A subject is a task that FAILED (blocked / needs-clarification / archived-no-action).
// subject = { kind: 'task'|'signature'|'source', key }
function collectSubjectTasks(pipelineDir, subject, { signatureFn = signatureForTask } = {}) {
  if (subject.kind === 'task') {
    const rec = findTaskRecordById(pipelineDir, subject.key);
    return rec ? [rec] : [];
  }
  const pool = [
    ...readStateDir(pipelineDir, 'needs-clarification').map((task) => ({ task, state: 'needs-clarification' })),
    ...readStateDir(pipelineDir, 'blocked').map((task) => ({ task, state: 'blocked' })),
  ];
  let matched;
  if (subject.kind === 'signature') {
    matched = pool.filter((r) => signatureFn(r.task) === subject.key);
  } else { // 'source'
    matched = pool.filter((r) => (r.task.source || 'unknown') === subject.key);
  }
  matched.sort((a, b) => String(terminalTs(b.task)).localeCompare(String(terminalTs(a.task))));
  return matched.slice(0, MAX_SUBJECTS);
}

// Winners: tasks that reached done/ (ideally with mergedAt) sharing the subject's `source`
// OR its `promptContext.decomposedFrom` parent.
function selectWinners(pipelineDir, subjectRecords) {
  if (!subjectRecords.length) return [];
  const sources = new Set(subjectRecords.map((r) => r.task.source).filter(Boolean));
  const parents = new Set(subjectRecords.map((r) => (r.task.promptContext || {}).decomposedFrom).filter(Boolean));
  const subjectIds = new Set(subjectRecords.map((r) => r.task.id));

  const doneDirs = [
    { dir: path.join(pipelineDir, 'queue', 'done'), state: 'done' },
    ...listArchivedMonthDirs(pipelineDir).map((dir) => ({ dir, state: 'archived' })),
  ];
  const candidates = [];
  for (const { dir, state } of doneDirs) {
    let names;
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      const task = readJson(path.join(dir, name));
      if (!task || subjectIds.has(task.id)) continue;
      const ctxParent = (task.promptContext || {}).decomposedFrom;
      // A decomposition SIBLING (same parent) is the sharpest contrast -- score it above a
      // bare same-source match, which for adhoc tasks (nearly all source==='manual') is
      // weak on its own.
      const score = (ctxParent && parents.has(ctxParent)) ? 2 : ((task.source && sources.has(task.source)) ? 1 : 0);
      if (!score) continue;
      // Only tasks that actually produced/shipped something count as a contrast "win".
      const shipped = !!task.mergedAt
        || (Array.isArray(task.history) && task.history.some((h) => h.stage === 'applied' || h.stage === 'approved'))
        || task.adhocResolution === 'implemented';
      if (!shipped) continue;
      candidates.push({ task, state, score, merged: !!task.mergedAt, at: terminalTs(task) });
    }
  }
  candidates.sort((a, b) => (b.score - a.score) || (Number(b.merged) - Number(a.merged)) || String(b.at).localeCompare(String(a.at)));
  return candidates.slice(0, MAX_WINNERS).map((c) => ({ task: c.task, state: c.state }));
}

// --- assembly ----------------------------------------------------------------------

function renderTierMap() {
  return ['TIER → SOURCE FILE (cite these, not invented module names):',
    ...TIER_SOURCE_MAP.map(([tier, file]) => `  ${tier}  →  ${file}`)].join('\n');
}

function historyStageDiff(subjectRecords, winnerRecords) {
  const stagesOf = (t) => (Array.isArray(t.history) ? t.history.map((h) => h.stage) : []);
  const line = (label, t) => `  ${label}: ${stagesOf(t).join(' → ') || '(none)'}`;
  return ['HISTORY-STAGE TRACE (subject vs. winners — where do the paths diverge?):',
    ...subjectRecords.map((r, i) => line(`subject ${i + 1}`, r.task)),
    ...winnerRecords.map((r, i) => line(`winner ${i + 1}`, r.task))].join('\n');
}

// Concatenate sections; drop lowest-value ones first when over budget, recording what fell.
function assembleText(sections, budgetChars) {
  const dropped = [];
  // Drop least-decisive evidence first. Subject 1's full trace + at least one winner's
  // tier tool-call detail (the "winner edited at turn 3, the subject never edited" signal)
  // are the last to go.
  const order = ['subjectOldAttempts', 'winnerCalls', 'winnerAttempts', 'subjectWorklog'];
  let text = sections.map((s) => s.text).join('\n\n');
  for (const tag of order) {
    if (text.length <= budgetChars) break;
    for (const s of sections) {
      if (s.dropTag === tag && !s.dropped) {
        s.dropped = true;
        dropped.push(tag);
      }
    }
    text = sections.filter((s) => !s.dropped).map((s) => s.text).join('\n\n');
  }
  if (text.length > budgetChars) {
    text = `${text.slice(0, budgetChars)}\n...[bundle truncated at ${budgetChars} chars]`;
    dropped.push('hard-truncate');
  }
  return { text, dropped };
}

function buildForensicBundle({ pipelineDir, dbPath, subject, now = new Date(), budgetChars = DEFAULT_BUDGET_CHARS, signatureFn } = {}) {
  const subjectRecords = collectSubjectTasks(pipelineDir, subject, { signatureFn });
  const winnerRecords = selectWinners(pipelineDir, subjectRecords);

  const subjectIds = subjectRecords.map((r) => r.task.id);
  const winnerIds = winnerRecords.map((r) => r.task.id);
  const allIds = [...subjectIds, ...winnerIds];
  const callsById = readModelCallsForTasks(dbPath, allIds);
  const worklogById = new Map();
  for (const id of allIds) {
    const wl = readWorkLog(id, pipelineDir);
    if (wl) worklogById.set(id, wl);
  }

  const signature = subject.kind === 'signature'
    ? subject.key
    : (subjectRecords[0] ? (signatureForTask(subjectRecords[0].task) || `${subject.kind}::${subject.key}`) : `${subject.kind}::${subject.key}`);

  const framing = [
    `PIPELINE FORENSIC BUNDLE — assembled ${new Date(now).toISOString()}`,
    `subject: kind=${subject.kind} key=${subject.key}  (${subjectRecords.length} failing task(s), ${winnerRecords.length} contrast "winner" task(s))`,
    '',
    'Method: rank candidate root causes by COUNTERFACTUAL impact — for each, "if this cause',
    'alone were fixed, would the failing case have gone through?". Contrast the failing',
    'tasks with the winners below (same task source / same decomposition parent) to isolate',
    'the variable. The deliverable is a fix to THIS PIPELINE\'s code, never a re-attempt of',
    'the failed task and never a hand-built version of the feature it was trying to build.',
  ].join('\n');

  const sections = [
    { text: framing },
    { text: renderTierMap() },
  ];
  subjectRecords.forEach((rec, i) => {
    sections.push({
      text: gatherEvidenceForTask(rec, worklogById.get(rec.task.id), callsById.get(rec.task.id), { label: `SUBJECT ${i + 1} (FAILED)` }),
      dropTag: i === 0 ? 'subjectWorklog' : 'subjectOldAttempts',
    });
  });
  winnerRecords.forEach((rec, i) => {
    sections.push({
      text: gatherEvidenceForTask(rec, worklogById.get(rec.task.id), callsById.get(rec.task.id), { label: `WINNER ${i + 1} (SUCCEEDED)` }),
      dropTag: i === 0 ? 'winnerAttempts' : 'winnerCalls',
    });
  });
  if (subjectRecords.length || winnerRecords.length) {
    sections.push({ text: historyStageDiff(subjectRecords, winnerRecords) });
  }

  const { text, dropped } = assembleText(sections, budgetChars);

  return {
    evidenceText: text,
    signature,
    subjectIds,
    winnerIds,
    loserIds: subjectIds, // alias — the failing set, named for the prompt's contrast instruction
    stats: {
      subjectCount: subjectRecords.length,
      winnerCount: winnerRecords.length,
      callRows: [...callsById.values()].reduce((n, rows) => n + rows.length, 0),
      worklogs: worklogById.size,
      droppedForBudget: dropped,
      chars: text.length,
    },
  };
}

module.exports = {
  buildForensicBundle,
  findTaskRecordById,
  readStateDir,
  readModelCallsForTasks,
  collectSubjectTasks,
  selectWinners,
  gatherEvidenceForTask,
  assembleText,
  terminalTs,
  TIER_SOURCE_MAP,
  DEFAULT_BUDGET_CHARS,
};

// CLI (read-only): node src/forensic-bundle.js --signature "<sig>" | --task <id> | --source <name>
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? null : args[i + 1]; };
  const { getConfig } = require('./config.js');
  const cfg = getConfig();
  const dbPath = process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH || path.join(cfg.pipelineDir, 'model-stats.db');
  let subject = null;
  if (get('task')) subject = { kind: 'task', key: get('task') };
  else if (get('signature')) subject = { kind: 'signature', key: get('signature') };
  else if (get('source')) subject = { kind: 'source', key: get('source') };
  if (!subject) {
    console.error('usage: node forensic-bundle.js --signature "<sig>" | --task <id> | --source <name>');
    process.exit(1);
  }
  const bundle = buildForensicBundle({ pipelineDir: cfg.pipelineDir, dbPath, subject });
  process.stdout.write(`${bundle.evidenceText}\n\n---\n${JSON.stringify({ signature: bundle.signature, subjectIds: bundle.subjectIds, winnerIds: bundle.winnerIds, stats: bundle.stats }, null, 2)}\n`);
}
