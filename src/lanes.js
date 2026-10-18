'use strict';

// The pipeline's worker lanes -- ONE per GPU endpoint, named for the GPU (worker-3090, worker-p40, worker-rx580).
//
// Replaces the old worker-1 / worker-reasoning / worker-p40 / worker-reasoning-p40 layout
// (2026-09-19, Grimmethy: "merge worker and reasoning... just turn them into GPU lanes. The lane
// name should be the GPU that is running it. All tasks are just tasks that get picked up based on
// the priority list."). The reasoning/worker split existed to route high-tier work to a different
// model; with every lane on a local model the only real difference is the GPU. Lane identity used
// to be hard-coded separately in launch.sh, dead-process-check.js and the dashboard; this is now
// the single definition all of them read.
//
// 2026-10-17 (Grimmethy, on adding a third GPU -- grimm's RX 580 8 GB -- "we should look into refactoring how
// they are handled so that this process is smoother in the future rather than needing boutique coding every
// time"): lanes are now DATA. Adding a GPU is one entry in the lanes registry file; no code, no new special case.
//
// Where lanes come from, in order:
//   1. the host lane, named from AGENT_MANAGER_LOCAL_GPU, else the first `nvidia-smi` GPU
//      ("NVIDIA GeForce RTX 3090" -> 3090), else 'local'. Always present. local:true, preempt:'always'.
//   2. the legacy P40 lane `worker-p40`, when AGENT_MANAGER_P40_OLLAMA_URL and AGENT_MANAGER_P40_MODEL are both set
//      (kept so existing installs behave exactly as before; it can also be declared in the registry, which then wins).
//   3. every entry of the lanes registry: the JSON file at AGENT_MANAGER_LANES_PATH (default <repo>/lanes.json, absent =
//      none). See lanes.example.json and docs/agents/lanes.md. An entry with the id of an earlier lane REPLACES it.
//
// Registry entry: { gpu (required slug), ollamaUrl (required), model (required), id?, enabled?, preempt?, taskClasses? }
//   id          default `worker-${gpu}`; must match /^worker-[a-z0-9]+$/.
//   enabled     false skips the entry (kept in the file but not launched).
//   preempt     'always' | 'age-gated' | 'never' (default 'never'): whether an interactive chat turn may kill this lane's
//               in-flight call. The chat only takes over the HOST GPU (2026-09-21, "only take over the 3090. P40 should remain
//               in action"), so every registry lane -- a different endpoint -- defaults to never.
//   slow        true marks a categorically slower endpoint (the P40 is the model case): its calls get the longer per-call timeout
//               ceiling (local-client.js / local-tool-client.js) and the longer watchdog zombie threshold (dead-process-check.js), so a
//               legitimately still-generating lane is not killed mid-call. Default false. The legacy P40 lane is slow.
//   reviewer    optional boolean (default false): also run a REVIEW daemon on this lane's GPU (reviewer-<gpu>, src/review-runner.sh). The host lane always
//               has the plain `reviewer`; the legacy P40 lane reads AGENT_MANAGER_P40_REVIEWER=true. Two reviewers share queue/review/ through per-item claims.
//   numBatch    optional whole number 32..8192: the prompt-processing batch (num_batch) this lane's calls use -> AGENT_MANAGER_LANE_NUM_BATCH. Measured
//               on the RX 580: default 26 tok/s prompt processing, 1024 -> 178 tok/s.
//   numCtx      optional whole number 2048..131072: the ONE context window (num_ctx) this lane's calls use, for a card that cannot hold the
//               pipeline's default pin (49152, sized for the 24 GB cards). Becomes AGENT_MANAGER_LANE_NUM_CTX in the lane's env
//               (gpu-capacity.js reads it). Measured on an 8 GB RX 580 with qwen3-vl:8b: 49152 -> 10.6 tok/s at 80% GPU, 16384 -> 26.2 tok/s at 100%.
//   taskClasses optional allowlist of task SOURCE names (brain_dump_sort, change_review, ...). Absent = the lane claims any
//               task (today's behaviour for the host and P40 lanes). Present = the claim loop (next-claimable-task.js) only
//               offers this lane tasks of those sources, so a small GPU can be given only the work that fits it. A task
//               explicitly pinned to the lane (operator action) still wins. An EMPTY list is invalid (a lane that can claim
//               nothing is a misconfiguration, not a feature) and drops the entry.
//
// FAIL CLOSED: a malformed file, or an entry missing a required field / with a bad id, URL, preempt or taskClasses, never
// creates a lane (and never widens one); the problem goes to stderr once per process and every other lane carries on.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tierFromModel } = require('./capability-ledger.js');

const REPO = path.resolve(__dirname, '..');
const LANE_ID_RE = /^worker-[a-z0-9]+$/;
const PREEMPT_MODES = ['always', 'age-gated', 'never'];

let detectedGpu; // cached per process
const warned = new Set();

function warnOnce(msg) {
  if (warned.has(msg)) return;
  warned.add(msg);
  process.stderr.write(`lanes: ${msg}\n`);
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// "NVIDIA GeForce RTX 3090" -> "3090"; "Tesla P40" -> "p40". Last name token containing a digit.
function gpuSlugFromName(name) {
  const tokens = String(name || '').trim().split(/\s+/).filter((t) => /\d/.test(t));
  return tokens.length ? slug(tokens[tokens.length - 1]) : '';
}

function detectLocalGpu() {
  if (detectedGpu !== undefined) return detectedGpu;
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    detectedGpu = gpuSlugFromName(out.split('\n')[0]);
  } catch {
    detectedGpu = '';
  }
  return detectedGpu;
}

function lanesRegistryPath(env = process.env) {
  return env.AGENT_MANAGER_LANES_PATH || path.join(REPO, 'lanes.json');
}

// The registry's raw entries ([] when the file is absent; [] + a warning when it is unreadable or not a JSON array).
function readRegistry(env = process.env) {
  const file = lanesRegistryPath(env);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code !== 'ENOENT') warnOnce(`cannot read ${file}: ${e.message}`);
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.lanes) ? parsed.lanes : null);
    if (!entries) { warnOnce(`${file} must be a JSON array of lanes (or {"lanes": [...]}); ignoring it`); return []; }
    return entries;
  } catch (e) {
    warnOnce(`${file} is not valid JSON (${e.message}); ignoring it`);
    return [];
  }
}

function validHttpUrl(u) {
  try { const p = new URL(String(u)); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; }
}

// One registry entry -> a lane, or null (with a warning) when it must not exist. Pure apart from warnOnce.
function laneFromEntry(raw, index) {
  const where = `lanes registry entry #${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { warnOnce(`${where} is not an object; skipped`); return null; }
  if (raw.enabled === false) return null;
  const gpu = slug(raw.gpu);
  if (!gpu) { warnOnce(`${where} has no usable "gpu"; skipped`); return null; }
  const id = raw.id === undefined ? `worker-${gpu}` : String(raw.id).trim().toLowerCase();
  if (!LANE_ID_RE.test(id)) { warnOnce(`${where} id "${raw.id}" must match ${LANE_ID_RE}; skipped`); return null; }
  if (!validHttpUrl(raw.ollamaUrl)) { warnOnce(`${where} (${id}) needs an http(s) "ollamaUrl"; skipped`); return null; }
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model) { warnOnce(`${where} (${id}) needs a "model"; skipped`); return null; }
  if (raw.slow !== undefined && typeof raw.slow !== 'boolean') { warnOnce(`${where} (${id}) slow must be true or false; skipped`); return null; }
  let numCtx = null;
  if (raw.numCtx !== undefined && raw.numCtx !== null) {
    if (!Number.isInteger(raw.numCtx) || raw.numCtx < 2048 || raw.numCtx > 131072) { warnOnce(`${where} (${id}) numCtx must be a whole number between 2048 and 131072; skipped`); return null; }
    numCtx = raw.numCtx;
  }
  let numBatch = null;
  if (raw.numBatch !== undefined && raw.numBatch !== null) {
    if (!Number.isInteger(raw.numBatch) || raw.numBatch < 32 || raw.numBatch > 8192) { warnOnce(`${where} (${id}) numBatch must be a whole number between 32 and 8192; skipped`); return null; }
    numBatch = raw.numBatch;
  }
  if (raw.reviewer !== undefined && typeof raw.reviewer !== 'boolean') { warnOnce(`${where} (${id}) reviewer must be true or false; skipped`); return null; }
  const preempt = raw.preempt === undefined ? 'never' : raw.preempt;
  if (!PREEMPT_MODES.includes(preempt)) { warnOnce(`${where} (${id}) preempt must be one of ${PREEMPT_MODES.join('|')}; skipped`); return null; }
  let tier = tierFromModel(model);
  if (raw.tier !== undefined && raw.tier !== null) {
    if (typeof raw.tier !== 'number' || !(raw.tier > 0)) { warnOnce(`${where} (${id}) tier must be a positive number (billions of parameters); skipped`); return null; }
    tier = raw.tier;
  }
  const reserve = raw.reserve === undefined || raw.reserve === null ? 'auto' : raw.reserve;
  if (reserve !== 'auto' && reserve !== 'always' && reserve !== false) { warnOnce(`${where} (${id}) reserve must be "auto", "always" or false; skipped`); return null; }
  let taskClasses = null;
  if (raw.taskClasses !== undefined && raw.taskClasses !== null) {
    const list = Array.isArray(raw.taskClasses) ? raw.taskClasses.map((c) => String(c).trim()).filter(Boolean) : [];
    if (!list.length) { warnOnce(`${where} (${id}) taskClasses must be a non-empty array of task source names; skipped`); return null; }
    taskClasses = [...new Set(list)];
  }
  return {
    id,
    gpu,
    // GPU_YIELD_APPS emptied: the yield-to-ComfyUI check watches the HOST GPU, not a remote endpoint's.
    env: {
      OLLAMA_URL: String(raw.ollamaUrl).trim(), LOCAL_MODEL: model, AGENT_MANAGER_GPU_YIELD_APPS: '',
      ...(numCtx ? { AGENT_MANAGER_LANE_NUM_CTX: String(numCtx) } : {}),
      ...(numBatch ? { AGENT_MANAGER_LANE_NUM_BATCH: String(numBatch) } : {}),
    },
    local: false,
    slow: raw.slow === true,
    numCtx,
    numBatch,
    reviewer: raw.reviewer === true,
    reviewerId: `reviewer-${gpu}`,
    preempt,
    taskClasses,
    model,
    tier,
    reserve,
  };
}

// -> [{ id, gpu, env, local, slow, numCtx, preempt, taskClasses, model, tier, reserve }]. `env` is the per-lane environment launch.sh / the watchdog must apply
// when spawning the lane ({} = inherit, i.e. the host's own Ollama). `taskClasses` null = claims any task.
function getLanes(env = process.env) {
  const local = slug(env.AGENT_MANAGER_LOCAL_GPU) || detectLocalGpu() || 'local';
  // The host lane's model is the base LOCAL_MODEL, which launch.sh also exports as AGENT_MANAGER_HOST_LOCAL_MODEL because a remote lane's
  // worker overrides LOCAL_MODEL in its own process. Without either signal the tier is unknown (null) and capability routing leaves it alone.
  const hostModel = env.AGENT_MANAGER_HOST_LOCAL_MODEL || (!env.AGENT_MANAGER_INSTANCE_ID || env.AGENT_MANAGER_INSTANCE_ID === `worker-${local}` ? env.LOCAL_MODEL : '') || null;
  const lanes = [{ id: `worker-${local}`, gpu: local, env: {}, local: true, slow: false, numCtx: null, numBatch: null, reviewer: true, reviewerId: 'reviewer', preempt: 'always', taskClasses: null, model: hostModel, tier: tierFromModel(hostModel), reserve: 'auto' }];
  if (env.AGENT_MANAGER_P40_OLLAMA_URL && env.AGENT_MANAGER_P40_MODEL) {
    lanes.push({
      id: 'worker-p40',
      gpu: 'p40',
      env: {
        OLLAMA_URL: env.AGENT_MANAGER_P40_OLLAMA_URL,
        LOCAL_MODEL: env.AGENT_MANAGER_P40_MODEL,
        AGENT_MANAGER_GPU_YIELD_APPS: '',
      },
      local: false,
      slow: true,
      numCtx: null,
      numBatch: null,
      reviewer: /^(1|true|yes|on)$/i.test(String(env.AGENT_MANAGER_P40_REVIEWER || '').trim()),
      reviewerId: 'reviewer-p40',
      preempt: 'never',
      taskClasses: null,
      model: env.AGENT_MANAGER_P40_MODEL,
      tier: tierFromModel(env.AGENT_MANAGER_P40_MODEL),
      reserve: 'auto',
    });
  }
  readRegistry(env).forEach((raw, i) => {
    const lane = laneFromEntry(raw, i);
    if (!lane) return;
    const at = lanes.findIndex((l) => l.id === lane.id);
    if (at >= 0) {
      // The host lane is never replaced by a remote definition (its identity IS the host's own Ollama); other lanes are.
      if (lanes[at].local) { warnOnce(`lanes registry entry ${lane.id} collides with the host lane; skipped`); return; }
      lanes[at] = lane;
    } else {
      lanes.push(lane);
    }
  });
  // A lane's Ollama endpoint is what the GPU arbiter serializes on (src/lib/ollama-lock-key.js): two lanes on one endpoint would
  // share one lock and one GPU, so refuse the later one rather than silently double-booking a card.
  const seen = new Map();
  return lanes.filter((l) => {
    const url = l.env.OLLAMA_URL;
    if (!url) return true;
    if (seen.has(url)) { warnOnce(`lane ${l.id} shares its Ollama endpoint ${url} with ${seen.get(url)}; skipped`); return false; }
    seen.set(url, l.id);
    return true;
  });
}

// The review daemons the pipeline runs: the host lane's plain `reviewer` first, then one `reviewer-<gpu>` per lane that opted in. Each entry
// carries the lane it runs on (its env decides which Ollama the votes go to).
function reviewerLanes(env = process.env) {
  return getLanes(env).filter((l) => l.reviewer).map((l) => ({ reviewerId: l.reviewerId, lane: l }));
}

function laneById(id, env = process.env) {
  return getLanes(env).find((l) => l.id === id) || null;
}

// May this lane claim a task of this source? A lane with no allowlist (host, P40, most registry lanes) claims anything. An unknown /
// unresolvable source name never matches a restricted lane (fail closed).
function laneAllowsSource(lane, sourceName) {
  if (!lane || !Array.isArray(lane.taskClasses)) return true;
  return typeof sourceName === 'string' && lane.taskClasses.includes(sourceName);
}

// Is `url` the Ollama endpoint of a lane marked slow? Used by the client modules, which only know their own OLLAMA_URL.
function isSlowEndpoint(url, env = process.env) {
  if (!url) return false;
  try { return getLanes(env).some((l) => l.slow && l.env.OLLAMA_URL === url); } catch { return false; }
}

// Is this lane id a slow lane? The legacy worker-p40 id counts even when its lane is not currently configured (a stale heartbeat
// from it must keep the long zombie threshold, exactly as before).
function isSlowLane(id, env = process.env) {
  if (id === 'worker-p40') return true;
  try { const l = laneById(id, env); return !!(l && l.slow); } catch { return false; }
}

module.exports = { reviewerLanes, getLanes, laneById, laneAllowsSource, isSlowEndpoint, isSlowLane, gpuSlugFromName, lanesRegistryPath };

if (require.main === module) {
  const [flag, arg] = process.argv.slice(2);
  const lanes = getLanes();
  if (flag === '--ids') {
    for (const l of lanes) console.log(l.id);
  } else if (flag === '--reviewers') {
    // "<reviewerId> <workerLaneId>" for every reviewer daemon EXCEPT the host's plain `reviewer` (launch.sh starts that one itself).
    for (const l of lanes) if (l.reviewer && !l.local) console.log(`${l.reviewerId} ${l.id}`);
  } else if (flag === '--json') {
    // The documented read surface for plugins (docs/PLUGIN_API.md): every lane with its tier, context/batch settings and allowlist. `env` is omitted
    // (it carries endpoint URLs and is launch plumbing, not part of the contract); `endpoint` is the Ollama URL a lane's calls go to.
    console.log(JSON.stringify(lanes.map((l) => ({
      id: l.id, gpu: l.gpu, model: l.model || null, tier: l.tier ?? null, numCtx: l.numCtx ?? null, numBatch: l.numBatch ?? null,
      slow: !!l.slow, local: !!l.local, reviewer: !!l.reviewer, reviewerId: l.reviewerId || null, preempt: l.preempt, taskClasses: l.taskClasses || null, reserve: l.reserve ?? 'auto',
      endpoint: (l.env && l.env.OLLAMA_URL) || null,
    })), null, 2));
  } else if (flag === '--env') {
    // KEY=VALUE lines for one lane, for `env "${lane_env[@]}" bash local-worker.sh <id>`.
    const lane = lanes.find((l) => l.id === arg);
    if (!lane) { console.error(`unknown lane: ${arg}`); process.exit(1); }
    for (const [k, v] of Object.entries(lane.env)) console.log(`${k}=${v}`);
  } else {
    console.log(JSON.stringify(lanes));
  }
}
