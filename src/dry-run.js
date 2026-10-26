'use strict';

// Supported dry-run of one recorded task's draft (docs/design-notes/task-atomization-plugin.md, hook 2). Runs the REAL draft entry point, `node
// src/local-draft.js <task.json>` (the exact invocation scripts/local-worker.sh makes: same prompts, passes, critique and post-implement gates),
// against a chosen lane's endpoint/model/context, and returns what it produced. What makes it a dry run:
//   - the task is a scrubbed COPY in a scratch dir (no queue file is read or written);
//   - AGENT_MANAGER_PIPELINE_DIR points at a scratch pipeline dir, so the capability ledger, pipeline-history, work logs, side-finding inbox and
//     task logs the draft writes all land there and are thrown away;
//   - AGENT_MANAGER_MODEL_STATS_DB_PATH is a scratch file (no model_calls rows);
//   - the repo (AGENT_MANAGER_REPO_ROOT) is the one place left real: drafts READ it for grounding. Read-only sources only: a source whose draft edits the
//     repo (the agentic-write tiers) is refused unless allowWrite is passed.
// The GPU arbiter / throughput state stay in the real instances dir on purpose: a replay queues behind the live lane instead of colliding with it, and the
// throughput calibration it feeds is for the same endpoint+model the lane really runs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DRAFT_SCRIPT = path.join(__dirname, 'local-draft.js');
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

// State a previous run left on the record. A replay must start clean or the draft resumes, reuses a prior plan or skips stages.
const RUN_STATE_FIELDS = [
  'draftAttempts', 'planResponse', 'implementResponse', 'lastGoodPlan', 'critiqueOutcome', 'history', 'blockedStage', 'blockedReason',
  'priorRejectionFeedback', 'localRejectCount', 'draftFailureCount', 'avoidLanes', 'pinnedWorker', 'reviewVotes', 'reviewResult', 'status',
  'terminalDisposition', 'mergedAt', 'branch', 'appliedAt', 'needsClarification', 'abCallId', 'candidateSplitProposals', 'acceptanceResults',
];

function freshTaskForReplay(task, { resetHarness = false } = {}) {
  const copy = JSON.parse(JSON.stringify(task || {}));
  for (const f of RUN_STATE_FIELDS) delete copy[f];
  if (resetHarness && copy.promptContext) { delete copy.promptContext.harnessHits; delete copy.promptContext.harnessFiles; }
  return copy;
}

// Environment for the child: the lane's own (OLLAMA_URL, LOCAL_MODEL, numCtx, numBatch) on top of the caller's, plus the isolation overrides.
function dryRunEnv({ lane, model, baseEnv = process.env, scratch }) {
  const env = { ...baseEnv, ...(lane && lane.env ? lane.env : {}) };
  if (lane) env.AGENT_MANAGER_INSTANCE_ID = lane.id;
  if (model) env.LOCAL_MODEL = model;
  env.AGENT_MANAGER_DRY_RUN = '1';
  env.AGENT_MANAGER_PIPELINE_DIR = path.join(scratch, 'pipeline');
  env.AGENT_MANAGER_MODEL_STATS_DB_PATH = path.join(scratch, 'model-stats.db');
  // The host lane has no OLLAMA_URL of its own: it is the process's. A remote lane's URL came from lane.env above.
  return env;
}

/**
 * dryRunDraft(task, { laneId, model, timeoutMs, resetHarness, allowWrite, baseEnv, lanes, script })
 * -> { ok, result, task, durationMs, exitCode, stderrTail, lane }
 *   result: local-draft's own stdout JSON ({ succeeded, blocked?, blockedReason?, ... }); task: the record after the draft (planResponse,
 *   implementResponse, draftAttempts, history). Never throws for a failed draft; rejects only for bad arguments.
 */
async function dryRunDraft(task, opts = {}) {
  const baseEnv = opts.baseEnv || process.env;
  const lanes = opts.lanes || require('./lanes.js').getLanes(baseEnv);
  const lane = opts.laneId ? lanes.find((l) => l.id === opts.laneId) : lanes[0];
  if (!lane) throw new Error(`dryRunDraft: unknown lane "${opts.laneId}" (have: ${lanes.map((l) => l.id).join(', ')})`);
  if (!task || typeof task !== 'object') throw new Error('dryRunDraft: a task record is required');

  if (!opts.allowWrite) {
    const { getRegisteredSource } = require('./task-source-registry.js');
    const reg = getRegisteredSource(task.source);
    if (reg && reg.writesRepo === true) throw new Error(`dryRunDraft: source "${task.source}" edits the repo in its draft; pass allowWrite to replay it`);
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-run-'));
  fs.mkdirSync(path.join(scratch, 'pipeline', 'queue'), { recursive: true });
  const taskPath = path.join(scratch, 'task.json');
  fs.writeFileSync(taskPath, JSON.stringify(freshTaskForReplay(task, opts), null, 2));
  const env = dryRunEnv({ lane, model: opts.model, baseEnv, scratch });
  const started = Date.now();

  const outcome = await new Promise((resolve) => {
    const child = spawn(process.execPath, [opts.script || DRAFT_SCRIPT, taskPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e.message), timedOut }); });
  });

  let result = null;
  const lastJson = outcome.stdout.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
  try { result = lastJson ? JSON.parse(lastJson) : null; } catch (_) { result = null; }
  let after = null;
  try { after = JSON.parse(fs.readFileSync(taskPath, 'utf8')); } catch (_) { after = null; }
  fs.rmSync(scratch, { recursive: true, force: true });

  const failedReason = outcome.timedOut ? 'dry-run timed out' : (result ? null : 'draft produced no result');
  return {
    ok: !failedReason && !!result && result.succeeded !== false,
    result: result || { succeeded: false, reason: failedReason },
    task: after,
    durationMs: Date.now() - started,
    exitCode: outcome.code,
    stderrTail: outcome.stderr,
    lane: { id: lane.id, model: opts.model || (lane.env && lane.env.LOCAL_MODEL) || lane.model || null, tier: lane.tier ?? null },
  };
}

module.exports = { dryRunDraft, freshTaskForReplay, dryRunEnv, RUN_STATE_FIELDS };

// CLI: node src/dry-run.js <task.json> [--lane worker-rx580] [--model tag] [--reset-harness] -- prints the draft result, the plan and implement text and the timing.
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (n) => { const i = args.indexOf(`--${n}`); return i === -1 ? null : args[i + 1]; };
  const file = args.find((a) => !a.startsWith('--') && a !== get('lane') && a !== get('model'));
  if (!file) { console.error('usage: node src/dry-run.js <task.json> [--lane <id>] [--model <tag>] [--reset-harness]'); process.exit(2); }
  require('./task-sources.js'); // registers sources (and the plugin) so write-tier sources are recognised
  dryRunDraft(JSON.parse(fs.readFileSync(file, 'utf8')), { laneId: get('lane'), model: get('model'), resetHarness: args.includes('--reset-harness') })
    .then((r) => {
      console.log(JSON.stringify({ ok: r.ok, result: r.result, lane: r.lane, durationMs: r.durationMs, exitCode: r.exitCode }, null, 2));
      if (r.task) console.log(`--- plan (${(r.task.planResponse || '').length} chars)\n${(r.task.planResponse || '').slice(0, 1500)}\n--- implement (${(r.task.implementResponse || '').length} chars)\n${(r.task.implementResponse || '').slice(0, 1500)}`);
      if (!r.ok && r.stderrTail) console.error(r.stderrTail.slice(-800));
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
