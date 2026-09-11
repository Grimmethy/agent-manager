'use strict';

// Tracks this machine's own recently observed generation throughput (tokens/sec) from real
// completed Ollama calls, so gpu-capacity.js's resolveTimeoutMs calibrates to actual hardware
// performance instead of an assumed constant that silently goes stale the moment the model,
// quant, or GPU changes. Self-correcting instead of something a human has to remember to
// re-tune -- see gpu-capacity.js's header for the standing directive this exists to satisfy.

const fs = require('fs');
const path = require('path');

const DEFAULT_TPS = 15; // conservative floor, used only until real samples exist.
const EMA_ALPHA = 0.25; // recent calls weighted more than old ones, but one slow/fast outlier can't swing the estimate on its own.

// 2026-09-11 (screaminggoatclubmt, "p40 is entirely blocked by ollama timeouts"): this
// state used to be ONE file for every local model call regardless of which Ollama
// endpoint served it. Same shape as yesterday's model-residency bug (agent-manager-
// common.sh's should_yield_for_model_swap): fine when there was one shared GPU, wrong
// the moment worker-p40/worker-reasoning-p40 started calling a physically separate,
// much slower Ollama instance on the P40 VM. Root-caused live via pipeline-history.log:
// the shared EMA read 34.8 tok/s (the local RTX 3090's real speed, dominant because the
// three local lanes call far more often than the two P40 lanes) while the P40 itself was
// actually generating at ~9.3 tok/s (confirmed from Ollama's own per-token timing on the
// VM) -- gpu-capacity.js's resolveTimeoutMs then calibrated every P40 call's timeout to
// hardware 3.5x faster than what was running it. Every single worker-p40/worker-
// reasoning-p40 draft call was hitting OLLAMA_TIMEOUT, 100% reproducible, not
// intermittent. Keyed by endpoint (like gpu-arbiter.js's lockKey) so each physically
// distinct GPU's throughput estimate is isolated -- also protects the local GPU's own
// estimate from being dragged down by the P40's slower samples, an equally real
// bidirectional harm the shared file caused.
function statePath(instancesDir, endpoint) {
  const key = endpoint ? `.${String(endpoint).replace(/[^A-Za-z0-9]/g, '_')}` : '';
  return path.join(instancesDir, `.local-throughput${key}.json`);
}

// evalCount/evalDurationNs come straight off Ollama's /api/generate response
// (eval_count, eval_duration) -- the model's own report of how many tokens it generated and
// how long that took, no separate measurement needed.
function recordSample(instancesDir, { evalCount, evalDurationNs, endpoint } = {}) {
  if (!instancesDir || !(evalCount > 0) || !(evalDurationNs > 0)) return;
  const tps = evalCount / (evalDurationNs / 1e9);
  if (!Number.isFinite(tps) || tps <= 0) return;

  const p = statePath(instancesDir, endpoint);
  let prevTps = null;
  try {
    const prev = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Number.isFinite(prev.tokensPerSecond) && prev.tokensPerSecond > 0) prevTps = prev.tokensPerSecond;
  } catch {
    // no prior sample (or unreadable) -- start fresh from this one.
  }

  const next = prevTps ? (EMA_ALPHA * tps + (1 - EMA_ALPHA) * prevTps) : tps;
  try {
    fs.mkdirSync(instancesDir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      tokensPerSecond: next,
      lastSampleTokensPerSecond: tps,
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    // best-effort -- a failed write here must never fail the caller's real work.
  }
}

function getTokensPerSecond(instancesDir, endpoint) {
  if (!instancesDir) return DEFAULT_TPS;
  try {
    const data = JSON.parse(fs.readFileSync(statePath(instancesDir, endpoint), 'utf8'));
    if (Number.isFinite(data.tokensPerSecond) && data.tokensPerSecond > 0) return data.tokensPerSecond;
  } catch {
    // no samples yet, or unreadable -- fall back to the conservative floor.
  }
  return DEFAULT_TPS;
}

module.exports = { recordSample, getTokensPerSecond, DEFAULT_TPS };
