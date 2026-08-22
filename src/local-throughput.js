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

function statePath(instancesDir) {
  return path.join(instancesDir, '.ornith-throughput.json');
}

// evalCount/evalDurationNs come straight off Ollama's /api/generate response
// (eval_count, eval_duration) -- the model's own report of how many tokens it generated and
// how long that took, no separate measurement needed.
function recordSample(instancesDir, { evalCount, evalDurationNs }) {
  if (!instancesDir || !(evalCount > 0) || !(evalDurationNs > 0)) return;
  const tps = evalCount / (evalDurationNs / 1e9);
  if (!Number.isFinite(tps) || tps <= 0) return;

  const p = statePath(instancesDir);
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

function getTokensPerSecond(instancesDir) {
  if (!instancesDir) return DEFAULT_TPS;
  try {
    const data = JSON.parse(fs.readFileSync(statePath(instancesDir), 'utf8'));
    if (Number.isFinite(data.tokensPerSecond) && data.tokensPerSecond > 0) return data.tokensPerSecond;
  } catch {
    // no samples yet, or unreadable -- fall back to the conservative floor.
  }
  return DEFAULT_TPS;
}

module.exports = { recordSample, getTokensPerSecond, DEFAULT_TPS };
