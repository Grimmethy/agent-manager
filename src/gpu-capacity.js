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
// this fixes. ONE value for every local-model call on a lane: Ollama fully reloads the
// model (~55-100s for the 27B) on ANY num_ctx change, so a value that varies by call
// (a smaller bucket per prompt, an "extended" tier for the big ones, a small utility
// model's 8192) turns into a reload every time two kinds of call alternate.
//
// RAISED 16384 -> 24576 (2026-09-07), then 24576 -> 49152 (2026-09-20, Grimmethy: "we need
// to raise the ceiling on the write pass. Go ahead and remove the small helper as well").
// The 24576 figure was sized so the 27B could stay resident ALONGSIDE the qwen2.5:3b
// utility model (brain_dump_sort's, ~2.72 GB). That model is gone -- every call site now
// falls through to LOCAL_MODEL -- so its reservation is free and the old "extended" tier
// (which unloaded it for one call) is folded in: the two-tier scheme is why the Chat
// (49152) and the workers (24576) reloaded the model whenever they alternated.
//
// Sizing, from direct measurement of the real 3090 (qwen3.8:27b-q4_K_M ~16.55 GB base +
// ~0.061 MB/token of context; anchors num_ctx=8192 -> 17.05 GB, 32768 -> 18.55 GB) and
// the 15% SAFETY_MARGIN_FRACTION: 24576 MiB - 15% (3.69 GB) = 20.89 GB budget for the
// 27B alone. 49152 tokens costs ~19.5 GB by that formula (~20% margin) and is the value
// the Chat already ran on this card, with the small model evicted, before this change.
// 65536 (~20.55 GB) is inside the budget by the same formula but only ~1.6% under it and
// past the last measured anchor -- re-measure with the card idle and raise it only then.
// The P40 lane's card is the same 24 GB, so it gets the same value.
const PINNED_NUM_CTX = 49152;

// Kept so existing callers keep working: there is no longer a separate, larger tier.
const EXTENDED_NUM_CTX = PINNED_NUM_CTX;

// ollama-http.js documents a hard-won 5-minute ceiling (docs/pipeline-incident-2026-07-19.md):
// a call legitimately needing longer than this is a signal to change the workload, not to
// raise the number. A computed timeout must respect that ceiling, never exceed it.
const HARD_TIMEOUT_CEILING_MS = 300_000;
// 2026-08-26, Grimmethy: "The GPU isn't running... looks like the GPU fired up for a
// little bit then it crashed again" -- root-caused live: this floor was calibrated
// against lock-QUEUEING contention (see its original 2026-08-20 comment, preserved
// below), never against a genuine COLD MODEL LOAD, which resolveTimeoutMs's whole
// formula has no separate term for at all (baseOverheadMs below is about queueing, not
// disk I/O). Measured directly against this exact model (qwen3.8:27b-q4_K_M) via
// isolated /api/generate calls once every worker/reviewer process was stopped: a clean,
// uncontended cold load took 51s; the SAME load under two-lane contention (worker-1 +
// worker-reasoning both cold-loading at once, competing for disk I/O) took 90s. The old
// 45s floor was already short of the *clean* case, let alone the contended one -- any
// short/cheap call (small prompt, small numPredict, e.g. this box's own diagnostic
// pings) whose computed timeout got clamped up to just this floor was cancelling the
// connection mid-load, every single time, which is exactly what "aborting load: client
// connection closed before llama-server finished loading" in Ollama's own log means.
// Once a lane hangs up early, Ollama frees the partial load and the model never
// actually becomes resident, so the NEXT call needs another full cold load too -- a
// livelock that never recovers on its own. Raised well past the worst contended
// measurement above, with real margin, while staying under this file's existing
// 240s/300s ceilings so nothing else here needs to change.
const MIN_TIMEOUT_MS = 150_000; // floor, not a target -- was 45_000 ("even a 20-token ping can sit queued behind real contention on this single-GPU box well past 30s before generation even starts," confirmed live 2026-08-20), too short for a genuine cold model load as this same comment's 2026-08-26 update above found live.
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
  // 2026-09-11 (screaminggoatclubmt, "p40 is entirely blocked by ollama timeouts"): the
  // 300s HARD_TIMEOUT_CEILING_MS below is docs/pipeline-incident-2026-07-19.md's
  // formalized, deliberately-never-silently-raised rule -- correct for the local RTX
  // 3090 this pipeline was built around. It is NOT correct for a categorically
  // different, ~3.5x slower, physically isolated endpoint (the P40 VM): at its real
  // measured ~9.3 tok/s, a 2800-token plan-pass generation needs ~301s for generation
  // ALONE, before this function's own 2.5x safety margin, so the 300s hard floor makes
  // every such call fail 100% of the time, confirmed live via pipeline-history.log.
  // hardCeilingMs is an explicit, named escape hatch for exactly this case -- a caller
  // must deliberately pass it (default preserves the original hard-won 300s for every
  // other caller unchanged); see local-client.js's P40_PER_CALL_TIMEOUT_CEILING_MS for
  // the one caller that does, and its own comment for why 900s specifically. This is
  // the "revisit this reasoning first" the incident doc itself asks for, not a silent
  // bump of the shared constant.
  hardCeilingMs = HARD_TIMEOUT_CEILING_MS,
}) {
  const tps = tokensPerSecond > 0 ? tokensPerSecond : 15; // conservative floor for a cold/unmeasured machine -- replaced by real measurements after the first few calls (local-throughput.js).
  const prefillMs = (promptTokens / prefillTokensPerSecond) * 1000;
  const genMs = (numPredict / tps) * 1000;
  const computed = baseOverheadMs + (prefillMs + genMs) * safetyFactor;
  return Math.min(Math.max(computed, MIN_TIMEOUT_MS), Math.min(ceilingMs, hardCeilingMs));
}

module.exports = {
  computeMaxSafeNumCtx,
  resolveNumCtx,
  resolveTimeoutMs,
  SAFETY_MARGIN_FRACTION,
  MIN_NUM_CTX,
  DEFAULT_NUM_CTX,
  PINNED_NUM_CTX,
  EXTENDED_NUM_CTX,
  HARD_TIMEOUT_CEILING_MS,
  MIN_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
};
