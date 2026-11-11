'use strict';

// Gateway budget awareness for the cloud lane's endpoint breaker (multi-node plan, piece 3).
//
// Why: the cloud-providers gateway (Ollama-compatible, default http://127.0.0.1:7450) enforces an hourly token budget and answers HTTP 429 `hourly token
// budget reached` (with the budget and resetsInSec) once it is spent, and `GET /meter` reports the same state. Nothing on this side listened: the worker's
// endpoint breaker (ollama_endpoint_reachable in scripts/agent-manager-common.sh) treats ANY HTTP answer as alive, so a lane over budget kept claiming
// tasks, and in the worker log of the lane 455 drafts failed with that 429 (each burning a task's infra requeue round) while the gateway said exactly when
// the budget would reset. docs/agents/cloud-lane.md "What went wrong on the lane" has the numbers.
//
// What this does: `node src/gateway-budget.js check <endpoint url>` asks that endpoint's /meter. Exit codes: 0 = fine, or unknown (no /meter, a 404, an
// answer that is not the gateway's JSON, a timeout, a budget of 0 = no cap: the check FAILS OPEN, a plain local Ollama is never affected); 3 = the budget is
// spent (it prints one line saying how much and when it resets). The shell breaker reads 3 as "not ready": the lane claims nothing and re-probes at its next
// tick instead of failing drafts.
//
// Side effects, only when the budget is spent, once per episode (an episode lasts until the gateway's own reset time): one line in hits.jsonl (when, the
// hourly budget, how much had been used: the observed ceiling, so a later ramp can start below it) and one summary-level (low priority) notification
// through src/notify.js. State directory: AGENT_MANAGER_BUDGET_STATE_DIR, default $HOME/.local/state/agent-manager/cloud-budget. Kill switch for the shell
// check: AGENT_MANAGER_BUDGET_PROBE=off.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { writeJsonAtomicSync } = require('./atomic-write.js');
const { notify } = require('./notify.js');

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 3000;
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_BUDGET = 3;

function stateDir(env = process.env) {
  const override = String(env.AGENT_MANAGER_BUDGET_STATE_DIR || '').trim();
  if (override) return override;
  return path.join(env.HOME || os.homedir(), '.local', 'state', 'agent-manager', 'cloud-budget');
}

// The gateway's /meter body -> {perHour, used, remaining, resetsInSec, exceeded}, or null when it carries no usable token budget (no cap, or not a gateway).
function budgetFromMeter(meter) {
  const tb = meter && typeof meter === 'object' ? meter.tokenBudget : null;
  if (!tb || typeof tb !== 'object') return null;
  const perHour = Number(tb.perHour);
  if (!Number.isFinite(perHour) || perHour <= 0) return null;
  const used = Number.isFinite(Number(tb.used)) ? Number(tb.used) : 0;
  const remaining = Number.isFinite(Number(tb.remaining)) ? Number(tb.remaining) : perHour - used;
  const resetsInSec = Number.isFinite(Number(tb.resetsInSec)) ? Math.max(0, Math.round(Number(tb.resetsInSec))) : 0;
  return { perHour, used, remaining, resetsInSec, exceeded: remaining <= 0 };
}

// GET <origin of url>/meter as parsed JSON, or null for anything else (never throws).
function fetchMeter(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL('/meter', url); } catch (e) { resolve(null); return; }
    if (target.protocol !== 'http:') { resolve(null); return; }
    const req = http.get({ hostname: target.hostname, port: target.port || 80, path: '/meter', agent: false, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { res.destroy(); resolve(null); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Records a budget episode. Returns true when this call started a NEW episode (the first sight of a spent budget since the previous reset), false inside an
// episode already recorded. The episode file keeps the reset time the gateway announced.
function recordHit(budget, env = process.env, now = Date.now()) {
  const dir = stateDir(env);
  const episodeFile = path.join(dir, 'episode.json');
  let episode = null;
  try { episode = JSON.parse(fs.readFileSync(episodeFile, 'utf8')); } catch (e) { /* none yet */ }
  if (episode && Number.isFinite(Date.parse(episode.resetsAt)) && now < Date.parse(episode.resetsAt)) return false;
  fs.mkdirSync(dir, { recursive: true });
  const resetsAt = new Date(now + budget.resetsInSec * 1000).toISOString();
  fs.appendFileSync(path.join(dir, 'hits.jsonl'), `${JSON.stringify({ at: new Date(now).toISOString(), perHour: budget.perHour, used: budget.used, resetsInSec: budget.resetsInSec })}\n`);
  writeJsonAtomicSync(episodeFile, { startedAt: new Date(now).toISOString(), perHour: budget.perHour, used: budget.used, resetsAt });
  return true;
}

function describe(budget) {
  const minutes = Math.max(1, Math.ceil(budget.resetsInSec / 60));
  return `token budget reached: ${budget.used} of ${budget.perHour} tokens per hour used; resets in about ${minutes} minutes`;
}

// -> 0 (fine or unknown) or 3 (spent). deps are injectable for tests.
async function checkEndpoint(url, { env = process.env, now = () => Date.now(), get = fetchMeter, send = notify, out = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const budget = budgetFromMeter(await get(url));
  if (!budget || !budget.exceeded) return EXIT_OK;
  out(describe(budget));
  let fresh = false;
  try { fresh = recordHit(budget, env, now()); } catch (e) { /* recording is best effort */ }
  if (fresh) {
    try {
      await send({ level: 'summary', key: 'cloud-budget-reached', title: 'Cloud lane: hourly token budget reached', text: `${describe(budget)}. The lane claims nothing until then.` }, { env, now });
    } catch (e) { /* the notice is best effort */ }
  }
  return EXIT_BUDGET;
}

async function main(argv, env = process.env, deps = {}) {
  const [cmd, url] = argv;
  if (cmd !== 'check' || !url) {
    process.stderr.write('usage: node src/gateway-budget.js check <endpoint url>\n');
    return EXIT_USAGE;
  }
  return checkEndpoint(url, { env, ...deps });
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { stateDir, budgetFromMeter, fetchMeter, recordHit, describe, checkEndpoint, main, EXIT_OK, EXIT_USAGE, EXIT_BUDGET };
