'use strict';

// Lane health probe (2026-10-17). The capability ledger cannot tell a degraded GPU from a task that is too big: on 2026-10-17 the RX 580's memory
// clock stuck at 300 MHz and generation fell from 26 to 0.6 tok/s, so three brain_dump_sort attempts timed out and the ledger blamed the task. A
// timed-out call reports no tokens, so the failing attempts carry no speed of their own. This probes each lane's endpoint with one tiny fixed
// generation while the lane is idle and records tokens/s, so a slow lane shows up as a slow lane. Run from the watchdog tick; self-throttled.
//   AGENT_MANAGER_LANE_HEALTH=off        disable
//   AGENT_MANAGER_LANE_HEALTH_INTERVAL_SECS (600)   AGENT_MANAGER_LANE_HEALTH_MIN_FRACTION (0.5)   AGENT_MANAGER_LANE_HEALTH_TIMEOUT_SECS (90)
// Consumers: capability-routing (never reserve/probe around a degraded lane) and capability-debrief-bundle (a cluster on a degraded lane is suspect).

const fs = require('fs');
const path = require('path');
const { postJson } = require('./ollama-http.js');
const { logPipelineEvent } = require('./pipeline-history.js');
const { DEFAULT_PINNED_NUM_CTX } = require('./gpu-capacity.js');
const gpuGuard = require('./gpu-guard.js');
const { readWorkerModelOverrides, effectiveLaneModel } = require('./worker-model-override.js');

const MAX_SAMPLES = 50;
const FRESH_MS = 30 * 60 * 1000; // a verdict older than this is not trusted either way
const MIN_BASELINE_SAMPLES = 3;
const PROBE_PROMPT = 'Count from 1 to 20, separated by commas, and nothing else.';

function num(raw, dflt) {
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function healthConfig(env = process.env) {
  return {
    enabled: String(env.AGENT_MANAGER_LANE_HEALTH || '').trim().toLowerCase() !== 'off',
    intervalMs: num(env.AGENT_MANAGER_LANE_HEALTH_INTERVAL_SECS, 600) * 1000,
    minFraction: Math.min(1, num(env.AGENT_MANAGER_LANE_HEALTH_MIN_FRACTION, 0.5)),
    timeoutMs: num(env.AGENT_MANAGER_LANE_HEALTH_TIMEOUT_SECS, 90) * 1000,
  };
}

function statePath(instancesDir, laneId) { return path.join(instancesDir, `lane-health.${laneId}.json`); }

function readState(instancesDir, laneId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(instancesDir, laneId), 'utf8'));
    return { samples: Array.isArray(parsed.samples) ? parsed.samples : [], probingSince: parsed.probingSince || null, lastInconclusiveAt: parsed.lastInconclusiveAt || null };
  } catch (_) { return { samples: [], probingSince: null, lastInconclusiveAt: null }; }
}
function readSamples(instancesDir, laneId) { return readState(instancesDir, laneId).samples; }
function writeState(instancesDir, laneId, state) {
  try {
    fs.mkdirSync(instancesDir, { recursive: true });
    fs.writeFileSync(statePath(instancesDir, laneId), JSON.stringify(state));
  } catch (_) { /* best-effort */ }
}

function percentile(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null; }

// -> { baseline, latest, degraded, reason }. Baseline = 75th percentile of the lane's successful probe speeds (needs a few samples), so a lane that
// has always been slow is not "degraded"; the latest sample is degraded when it failed outright or ran below minFraction of that baseline.
function assess(samples, cfg = healthConfig()) {
  const list = samples || [];
  const latest = list.length ? list[list.length - 1] : null;
  const good = list.filter((s) => s.ok && s.tps > 0).map((s) => s.tps).sort((a, b) => a - b);
  const baseline = good.length >= MIN_BASELINE_SAMPLES ? percentile(good, 0.75) : null;
  if (!latest) return { baseline, latest: null, degraded: false, reason: 'no samples' };
  if (!latest.ok) return { baseline, latest, degraded: true, reason: `probe failed: ${latest.error || 'no response'}` };
  if (baseline && latest.tps < baseline * cfg.minFraction) {
    return { baseline, latest, degraded: true, reason: `probe ${latest.tps.toFixed(1)} tok/s vs baseline ${baseline.toFixed(1)}` };
  }
  return { baseline, latest, degraded: false, reason: 'ok' };
}

// Sync, cheap: is this lane's most recent (fresh) probe degraded? Unknown / stale / disabled = false, so this never blocks work on its own.
function laneDegraded(instancesDir, laneId, { now = Date.now(), cfg = healthConfig() } = {}) {
  if (!cfg.enabled || !instancesDir) return false;
  const samples = readSamples(instancesDir, laneId);
  const latest = samples.length ? samples[samples.length - 1] : null;
  if (!latest || now - Date.parse(latest.at) > FRESH_MS) return false;
  return assess(samples, cfg).degraded;
}

// Was this lane degraded at any probe inside [fromIso, toIso] (padded by one probe interval)? For the debrief to discount a cluster.
function laneDegradedBetween(instancesDir, laneId, fromIso, toIso, cfg = healthConfig()) {
  const from = Date.parse(fromIso) - cfg.intervalMs;
  const to = Date.parse(toIso) + cfg.intervalMs;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  const samples = readSamples(instancesDir, laneId);
  return samples.some((s, i) => {
    const t = Date.parse(s.at);
    return t >= from && t <= to && assess(samples.slice(0, i + 1), cfg).degraded;
  });
}

// The probe MUST look exactly like the lane's own calls: Ollama reloads a resident model when num_ctx changes, so a probe at a different context
// would evict the lane's pinned model (a 27B reload is ~100 s, longer than the probe timeout) and make a healthy lane look dead and busy. Same
// num_ctx / num_batch / keep_alive as the lane's real requests (src/gpu-capacity.js pins, lane registry numCtx/numBatch, LOCAL_KEEP_ALIVE).
async function probeEndpoint({ url, model, numCtx = DEFAULT_PINNED_NUM_CTX, numBatch = null, keepAlive = '30m', post = postJson, timeoutMs = 90000 }) {
  const started = Date.now();
  try {
    const r = await post(`${String(url).replace(/\/$/, '')}/api/generate`, {
      model, prompt: PROBE_PROMPT, stream: false, think: false, keep_alive: keepAlive,
      options: { num_predict: 48, temperature: 0, num_ctx: numCtx, ...(numBatch ? { num_batch: numBatch } : {}) },
    }, timeoutMs);
    const evalNs = Number(r && r.eval_duration);
    const evalCount = Number(r && r.eval_count);
    const tps = evalNs > 0 && evalCount > 0 ? evalCount / (evalNs / 1e9) : 0;
    return { ok: tps > 0, tps, totalMs: Date.now() - started, error: tps > 0 ? null : 'no tokens reported' };
  } catch (e) {
    return { ok: false, tps: 0, totalMs: Date.now() - started, error: String((e && e.message) || e).slice(0, 120) };
  }
}

// Which models does this Ollama endpoint have resident right now? -> array of names, or null when it cannot be asked (down, slow, unparsable).
// A model swap is the one thing a health probe must not cause or misread: loading a big model can take minutes (ornith:35b from the HDD: ~470 s,
// the dense 27B ~107 s), longer than the probe timeout.
async function residentModels(url, { fetchFn = fetch, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetchFn(`${String(url).replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return (Array.isArray(body && body.models) ? body.models : []).map((m) => String((m && (m.name || m.model)) || '')).filter(Boolean);
  } catch (_) { return null; }
}

function laneIdleNow(instancesDir, laneId, now) {
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(instancesDir, `${laneId}.json`), 'utf8'));
    const age = now - Date.parse(hb.lastHeartbeat);
    return hb.status === 'idle' && Number.isFinite(age) && age >= 0 && age <= 90 * 1000;
  } catch (_) { return false; }
}

// Probe every lane that is idle and due. `lanes` come from lanes.js (the host lane has env {} and is served by process OLLAMA_URL / LOCAL_MODEL).
async function runDueProbes({ lanes, instancesDir, pipelineDir, env = process.env, now = Date.now(), probe = probeEndpoint, leaseHeldFor = gpuGuard.leaseHeldFor, resident = residentModels, overrides } = {}) {
  const cfg = healthConfig(env);
  const out = [];
  if (!cfg.enabled) return out;
  const hostUrl = env.AGENT_MANAGER_HOST_OLLAMA_URL || env.OLLAMA_URL || 'http://localhost:11434';
  // The model a lane is really running includes a dashboard override; only the live process environment reads the live settings file (tests pass env: {}).
  const modelOverrides = overrides !== undefined ? overrides : (env === process.env ? readWorkerModelOverrides() : {});
  for (const lane of lanes || []) {
    // A cloud lane has no tokens/s to judge (the gateway reports no eval_duration, so every probe would read as a failure) and each probe would be a billed call.
    if (lane.cloud) continue;
    const url = (lane.env && lane.env.OLLAMA_URL) || hostUrl;
    const model = effectiveLaneModel(lane, modelOverrides);
    if (!model || !laneIdleNow(instancesDir, lane.id, now)) continue;
    // A leased card belongs to its lease holder for now (a KaggleForge eval, a Forge session): a probe is a model call, and it would reload the model the holder evicted.
    if (leaseHeldFor(url)) continue;
    const { samples, probingSince, lastInconclusiveAt } = readState(instancesDir, lane.id);
    const last = samples.length ? samples[samples.length - 1] : null;
    if (last && now - Date.parse(last.at) < cfg.intervalMs) continue;
    if (lastInconclusiveAt && now - Date.parse(lastInconclusiveAt) < cfg.intervalMs) continue;
    // The watchdog runs this in the background every tick; a probe still in flight (it can take up to the timeout) must not be doubled.
    if (probingSince && now - Date.parse(probingSince) < cfg.timeoutMs + 15000) continue;
    // Never probe over a different resident model: the probe would evict it and wait out a load longer than its own timeout (2026-10-27).
    const before = await resident(url);
    if (before && before.length && !before.includes(model)) {
      out.push({ lane: lane.id, skipped: `a different model is resident (${before.join(', ')}), not probing ${model}` });
      continue;
    }
    writeState(instancesDir, lane.id, { samples, probingSince: new Date(now).toISOString(), lastInconclusiveAt });
    const r = await probe({ url, model, numCtx: lane.numCtx || DEFAULT_PINNED_NUM_CTX, numBatch: lane.numBatch || null, keepAlive: env.LOCAL_KEEP_ALIVE || env.ORNITH_KEEP_ALIVE || '30m', timeoutMs: cfg.timeoutMs });
    // A probe that failed while its model was NOT resident (or was replaced mid-probe) measured a model load, not the lane's speed: inconclusive, no sample,
    // retried after the normal interval. A failure with the model resident, or with the endpoint unreachable, is still a real failure.
    if (!r.ok) {
      const after = await resident(url);
      if (after && !after.includes(model)) {
        writeState(instancesDir, lane.id, { samples, lastInconclusiveAt: new Date(now).toISOString() });
        logPipelineEvent(pipelineDir, 'lane-health', { lane: lane.id, model, ok: false, inconclusive: true, reason: `${r.error}; ${model} was not resident afterwards (resident: ${after.join(', ') || 'none'})` });
        out.push({ lane: lane.id, inconclusive: true, error: r.error, resident: after });
        continue;
      }
    }
    const sample = { at: new Date(now).toISOString(), ok: r.ok, tps: Math.round(r.tps * 100) / 100, totalMs: r.totalMs, error: r.error };
    const next = [...samples, sample].slice(-MAX_SAMPLES);
    writeState(instancesDir, lane.id, { samples: next });
    const verdict = assess(next, cfg);
    const wasDegraded = samples.length ? assess(samples, cfg).degraded : false;
    logPipelineEvent(pipelineDir, 'lane-health', { lane: lane.id, model, tps: sample.tps, ok: sample.ok, degraded: verdict.degraded, reason: verdict.reason, transition: verdict.degraded !== wasDegraded });
    out.push({ lane: lane.id, ...sample, degraded: verdict.degraded, reason: verdict.reason });
  }
  return out;
}

module.exports = { healthConfig, assess, laneDegraded, laneDegradedBetween, probeEndpoint, runDueProbes, readSamples, residentModels, PROBE_PROMPT };

// CLI: `node src/lane-health.js` runs due probes (what the watchdog calls) and prints one JSON line; `--status` prints each lane's latest verdict.
if (require.main === module) {
  (async () => {
    const { getLanes } = require('./lanes.js');
    const { sharedInstancesDir } = require('./instances-dir.js');
    const pipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();
    const instancesDir = sharedInstancesDir(pipelineDir);
    const lanes = getLanes();
    if (process.argv.includes('--status')) {
      for (const l of lanes) {
        const a = assess(readSamples(instancesDir, l.id));
        console.log(`${l.id}: ${a.degraded ? 'DEGRADED' : 'ok'} (${a.reason}) latest=${a.latest ? a.latest.tps : '-'} tok/s baseline=${a.baseline ? a.baseline.toFixed(1) : '-'}`);
      }
      return;
    }
    console.log(JSON.stringify(await runDueProbes({ lanes, instancesDir, pipelineDir })));
  })().catch((e) => { console.error(e); process.exit(0); });
}
