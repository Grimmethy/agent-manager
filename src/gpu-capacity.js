'use strict';

// Computes context-window sizing and call-timeout budgets from live measurements instead of
// fixed constants, so these numbers scale automatically as hardware, model, or workload
// changes instead of needing a human to notice and hand-edit a magic number.
// Grimmethy, 2026-08-20: "we are going to scale this system... rely on doing the math rather
// than setting a specific threshold... flexible instead of rigid."
//
// Pure math only -- no GPU/network access here (see gpu-vram.js for the live query side and
// local-throughput.js for the rolling per-machine throughput calibration this consumes).
// Every function degrades to a safe, previously-hardcoded-equivalent value when its inputs
// are missing, matching the rest of this pipeline's "a capability check failing must never
// block the tick" rule (agent-manager-common.sh's check_budget_healthy, gpu-guard.js).

const SAFETY_MARGIN_FRACTION = 0.15; // unclaimed headroom, proportional to total VRAM (not a fixed MiB carve-out) -- scales with card size instead of being tuned for one specific GPU.
const MIN_NUM_CTX = 2048;
const DEFAULT_NUM_CTX = 8192; // fallback when no live VRAM reading is available at all -- the value this system used before this module existed.

// 2026-08-23, Grimmethy: "Go ahead with option B" (one-time reload to a larger fixed
// context, then hold it steady) -- see resolveNumCtx()'s own comment for the incident
// this fixes. Sized for review-task.js's own worst-case verdictPrompt (plan + implement
// draft + fact-check JSON + up to 40KB of grounding text, confirmed live to need ~14K
// tokens for a real large draft) with real margin, not review's typical case -- this
// value is meant to almost never need to grow again, since growing is exactly what
// triggers the hang this fix exists to avoid.
const PINNED_NUM_CTX = 16384;

// ollama-http.js documents a hard-won 5-minute ceiling (docs/pipeline-incident-2026-07-19.md):
// a call legitimately needing longer than this is a signal to change the workload, not to
// raise the number. A computed timeout must respect that ceiling, never exceed it.
const HARD_TIMEOUT_CEILING_MS = 300_000;
const MIN_TIMEOUT_MS = 45_000; // floor, not a target -- confirmed live 2026-08-20: even a 20-token ping can sit queued behind real contention on this single-GPU box well past 30s before generation even starts.
const DEFAULT_TIMEOUT_MS = 240_000; // fallback when throughput hasn't been measured yet -- this system's previous fixed value.

// overheadMiB = VRAM Ollama is using beyond the model weights themselves (KV cache + prompt
// cache) at currentNumCtx. Empirically observed 2026-08-20 on this box: modelWeightMiB
// ~17047, totalUsedMiB ~17501 at numCtx=8192 -> overhead ~454 MiB -- Ollama's own
// context-shift cache tracks context length roughly linearly for a given model/quant, so one
// live sample is enough to derive a per-token cost ratio without hardcoding it per-GPU.
function computeMaxSafeNumCtx({ totalVramMiB, usedVramMiB, modelWeightMiB, currentNumCtx, safetyMarginFraction = SAFETY_MARGIN_FRACTION }) {
  if (!(totalVramMiB > 0) || !(currentNumCtx > 0) || !(usedVramMiB >= 0) || !(modelWeightMiB >= 0)) return null;

  const overheadMiB = Math.max(usedVramMiB - modelWeightMiB, 1);
  const miBPerCtxToken = overheadMiB / currentNumCtx;
  const reserveMiB = totalVramMiB * safetyMarginFraction;
  const freeMiB = totalVramMiB - usedVramMiB;
  const usableMiB = Math.max(freeMiB - reserveMiB, 0);
  const additionalCtx = Math.floor(usableMiB / miBPerCtxToken);

  return {
    maxSafeNumCtx: Math.max(currentNumCtx + additionalCtx, MIN_NUM_CTX),
    miBPerCtxToken,
    usableMiB,
  };
}

// 2026-08-23 incident: this used to round UP to a power-of-two-ish bucket sized to THIS
// call's own prompt (a 300-token adhoc prompt got 2048, a 6000-token harness-grounded one
// got 8192, ...), which sounds like sensible VRAM economy but is what caused a severe,
// silent hang -- confirmed live: ANY request whose num_ctx exceeds whatever Ollama
// currently has resident hangs indefinitely (not a clean reload, not a graceful clamp --
// the request never even reaches llama-server's own slot/generate logging, reproduced
// identically with and without TokenFold in the path) until the CLIENT's own timeout
// eventually fires. review-task.js's own verdictPrompt (plan + implement draft +
// fact-check JSON + up to 40KB of grounding text) routinely needs more than whatever
// smaller bucket an earlier, smaller call had left resident, so nearly every review call
// was hitting this -- 59 of 62 real attempts failed the same night this was found.
//
// Fixed by pinning num_ctx to ONE stable value (PINNED_NUM_CTX) and never varying it by
// prompt size again -- estimatedTokens/numPredict are accepted for API compatibility but
// deliberately unused now. maxSafeNumCtx (live VRAM headroom) still clamps DOWN on a
// smaller/more contended box where PINNED_NUM_CTX genuinely isn't affordable; a call
// needing more than the resulting ceiling falls back to Ollama's own --context-shift
// truncation (a real but rare-case tradeoff -- the old per-call bucket path risked this
// same truncation for any oversized prompt too, just via the far more common growth-hang
// instead of a clean truncation).
function resolveNumCtx({ estimatedTokens, numPredict, maxSafeNumCtx }) {
  void estimatedTokens;
  void numPredict;
  if (maxSafeNumCtx > 0) return Math.min(PINNED_NUM_CTX, Math.max(maxSafeNumCtx, MIN_NUM_CTX));
  return PINNED_NUM_CTX;
}

// Expected call duration scales with the actual work requested -- prefill (fast, scales with
// prompt size) plus generation (slow, scales with numPredict at THIS machine's own observed
// tokens/sec, not an assumed constant) -- rather than one flat ceiling that's needlessly
// generous for a 100-token task and too tight for a context-heavy one.
function resolveTimeoutMs({
  promptTokens = 0,
  numPredict = 0,
  tokensPerSecond,
  prefillTokensPerSecond = 150, // conservative floor for prefill -- real prefill on this box has been observed at 400-600+ tok/s on a warm cache, this only needs to not be *too fast*.
  baseOverheadMs = 20_000, // covers real queueing time behind the single Ollama generation slot under contention -- confirmed live 2026-08-20: a trivial 20-token call still took >30s wall-clock while another lane held the model.

  safetyFactor = 2.5,
  ceilingMs = HARD_TIMEOUT_CEILING_MS,
}) {
  const tps = tokensPerSecond > 0 ? tokensPerSecond : 15; // conservative floor for a cold/unmeasured machine -- replaced by real measurements after the first few calls (local-throughput.js).
  const prefillMs = (promptTokens / prefillTokensPerSecond) * 1000;
  const genMs = (numPredict / tps) * 1000;
  const computed = baseOverheadMs + (prefillMs + genMs) * safetyFactor;
  return Math.min(Math.max(computed, MIN_TIMEOUT_MS), Math.min(ceilingMs, HARD_TIMEOUT_CEILING_MS));
}

module.exports = {
  computeMaxSafeNumCtx,
  resolveNumCtx,
  resolveTimeoutMs,
  SAFETY_MARGIN_FRACTION,
  MIN_NUM_CTX,
  DEFAULT_NUM_CTX,
  PINNED_NUM_CTX,
  HARD_TIMEOUT_CEILING_MS,
  MIN_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
};
