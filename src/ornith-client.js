'use strict';

// Thin wrapper over the local Ollama HTTP API for the `ornith` model, encoding the
// mechanics and guardrails documented in Docs/agents/ornith-delegation.md so no caller
// has to rediscover them: explicit num_ctx/num_predict (the `ollama run` CLI silently
// truncates), a degenerate-output detector for the failure modes that fail *silently*
// (done_reason: stop, syntactically fine, semantically garbage), retry-on-degenerate
// (these have been observed to self-heal), and a majority-vote helper for judgment
// calls that are otherwise an invisible coin flip at default temperature.

const path = require('path');
const { postJson } = require('./ollama-http.js');
const inflightLock = require('./model-inflight-lock.js');
const gpuCapacity = require('./gpu-capacity.js');
const gpuVram = require('./gpu-vram.js');
const ornithThroughput = require('./ornith-throughput.js');

// Deliberately NOT config.js's getConfig() -- that throws if AGENT_MANAGER_REPO_ROOT is
// unset, which would turn every caller of this module (including test files that require
// it without setting up a full pipeline env) into a hard crash just from requiring
// ornith-client.js. Same pipelineDir-falls-back-to-repoRoot derivation config.js uses,
// just tolerant of "neither is set" (returns null -- the in-flight lock below then simply
// isn't taken, same as any other best-effort failure in acquire()).
function resolveInstancesDir() {
  const repoRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  if (!repoRoot) return null;
  const pipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR || repoRoot;
  return path.join(pipelineDir, 'instances');
}

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.ORNITH_MODEL || 'ornith';
// Without this, Ollama falls back to its own default unload window between calls --
// observed live 2026-07-18 paying a ~38-40s cold-load penalty on the very next call
// whenever a gap (between passes, or between tasks) outlasted it. Free to set generously
// since nothing else is competing for the model slot on this box (OLLAMA_MAX_LOADED_MODELS
// effectively 1 already, per ornith-worker.ps1's own comment on why concurrent instances
// must share one model tier).
const KEEP_ALIVE = process.env.ORNITH_KEEP_ALIVE || '30m';

function detectDegenerate(text, { allowEmpty = false } = {}) {
  if (!text || text.trim().length === 0) return allowEmpty ? null : 'empty';

  // Ornith sometimes writes the literal two-character JSON-style empty-string
  // representation ('""' or "''") instead of a genuinely empty response -- review-task.js's
  // own isEffectivelyEmpty() already treats these the same as a real empty string for its
  // review-stage check. Without the same handling here, this quirk skips the check above
  // entirely (text.trim().length is 2, not 0) and burns a full critique+revision cycle on
  // two characters. Treated identically to a genuinely empty response, respecting the same
  // allowEmpty escape hatch: a source explicitly told to output nothing when there's
  // nothing real to report can legitimately produce this quirky two-char form instead of a
  // truly empty string.
  const trimmed = text.trim();
  if (trimmed === '""' || trimmed === "''") return allowEmpty ? null : 'empty';

  // Repeated-character garbage (e.g. a literal run of "000000..." was observed for 20
  // straight calls in one documented overnight run).
  const charCounts = {};
  for (const ch of text) charCounts[ch] = (charCounts[ch] || 0) + 1;
  const dominant = Math.max(...Object.values(charCounts));
  if (text.length > 20 && dominant / text.length > 0.4) return 'repeated-character';

  // Verbatim-paragraph repetition loop leaking into the visible response.
  const words = text.trim().split(/\s+/);
  if (words.length > 30) {
    const chunk = words.slice(0, 8).join(' ');
    const repeats = text.split(chunk).length - 1;
    if (repeats >= 3) return 'repetition-loop';
  }

  // Multi-script / gibberish word-salad for what should be an English task.
  const nonAscii = [...text].filter((ch) => ch.charCodeAt(0) > 127).length;
  if (nonAscii / text.length > 0.3) return 'non-ascii-gibberish';

  return null;
}

// Live GPU-capacity snapshot, refreshed at most once per CAPACITY_TTL_MS -- nvidia-smi/
// /api/ps are cheap but not free, and every real call already pays a multi-second-plus
// network round trip, so a few minutes of staleness on the sizing inputs costs nothing while
// still tracking real changes (a different model loaded, more/less VRAM free) far faster than
// a human editing a constant ever would. Any failure anywhere in this chain resolves to
// `null` and every caller below falls back to this module's pre-existing fixed defaults.
const CAPACITY_TTL_MS = 5 * 60 * 1000;
let capacityCache = { snapshot: null, refreshedAt: 0 };

async function getCapacitySnapshot() {
  const now = Date.now();
  if (capacityCache.snapshot && (now - capacityCache.refreshedAt) < CAPACITY_TTL_MS) {
    return capacityCache.snapshot;
  }
  let snapshot = null;
  try {
    const vram = gpuVram.queryVram();
    const modelInfo = vram ? await gpuVram.queryLoadedModel(OLLAMA_URL, MODEL) : null;
    if (vram && modelInfo && modelInfo.numCtx > 0) {
      snapshot = gpuCapacity.computeMaxSafeNumCtx({
        totalVramMiB: vram.totalVramMiB,
        usedVramMiB: vram.usedVramMiB,
        modelWeightMiB: modelInfo.modelWeightMiB,
        currentNumCtx: modelInfo.numCtx,
      });
    }
  } catch {
    snapshot = null;
  }
  capacityCache = { snapshot, refreshedAt: now };
  return snapshot;
}

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4); // rough chars-per-token estimate -- only used to bucket a context window and a timeout budget, not to enforce a hard limit.
}

async function callOnce({ prompt, think = true, temperature = 0.4, numCtx, numPredict = 1200, repeatPenalty, format, model, timeoutMs }) {
  const promptTokens = estimateTokens(prompt);

  let resolvedNumCtx = numCtx;
  if (!resolvedNumCtx) {
    const capacity = await getCapacitySnapshot();
    resolvedNumCtx = capacity
      ? gpuCapacity.resolveNumCtx({ estimatedTokens: promptTokens, numPredict, maxSafeNumCtx: capacity.maxSafeNumCtx })
      : gpuCapacity.DEFAULT_NUM_CTX;
  }

  const options = { num_ctx: resolvedNumCtx, num_predict: numPredict, temperature };
  if (repeatPenalty) options.repeat_penalty = repeatPenalty;

  const body = { model: model || MODEL, prompt, think, stream: false, keep_alive: KEEP_ALIVE, options };
  // Grammar-constrained decoding. When `format` is set ("json", or a full JSON-schema object),
  // Ollama restricts the sampler to tokens valid for that grammar, so a malformed or
  // markdown-fenced response is *unrepresentable* rather than merely discouraged in the prompt.
  // This is the structural replacement for "Output ONLY the draft JSON"-style instructions that
  // the model is documented to ignore (Docs/agents/ornith-delegation.md — a real state_targets
  // implement draft came back ```json-fenced despite that exact instruction). The constraint
  // applies only to `response`; the `thinking` trace is left unconstrained.
  if (format) body.format = format;

  // In-flight lock (model-inflight-lock.js) -- held for the exact span of the real
  // network call, so agent-manager-common.sh's should_yield_for_model_swap can see "a
  // DIFFERENT model is actively being served right now" and refuse to swap Ollama's
  // resident model out from under it, regardless of what queue/pending/ backlog counts
  // say (see that guard's own updated comment for the race this closes). instancesDir
  // resolving to null (no pipeline env configured -- e.g. a bare unit-test require of
  // this module) just means no lock is taken, same as any other best-effort failure path
  // here.
  const instancesDir = resolveInstancesDir();
  const lockModel = model || MODEL;
  const lockPath = instancesDir ? inflightLock.acquire(instancesDir, lockModel, process.env.AGENT_MANAGER_INSTANCE_ID) : null;
  const resolvedTimeoutMs = timeoutMs || resolveRequestTimeoutMs({ promptTokens, numPredict, instancesDir });
  try {
    const result = await postJson(`${OLLAMA_URL}/api/generate`, body, resolvedTimeoutMs);
    ornithThroughput.recordSample(instancesDir, { evalCount: result.eval_count, evalDurationNs: result.eval_duration });
    return result;
  } finally {
    inflightLock.release(lockPath);
  }
}

// PER_CALL_TIMEOUT_CEILING_MS stays at the pipeline's pre-existing 4-minute ceiling, not
// ollama-http.js's full 5-minute hard ceiling -- dead-process-check.js's
// WORKER_ZOMBIE_THRESHOLD_SECONDS (20 min) was sized against "up to 4 sequential
// ornithCall()s per task, each individually bounded by 240s -- worst case ~960s" with
// deliberate slack to 1200s. Letting a single call float all the way to 300s would erase
// that slack (4*300s = 1200s, exactly the zombie threshold, zero margin) without anyone
// having revisited that math -- so a computed timeout here can come in BELOW 240s for cheap
// calls (failing faster, freeing a stuck lane sooner) but never above it. An explicit
// ORNITH_TIMEOUT_MS still overrides everything below, same as before this module existed.
const PER_CALL_TIMEOUT_CEILING_MS = 240_000;
const ENV_TIMEOUT_MS_OVERRIDE = Number(process.env.ORNITH_TIMEOUT_MS) || null;

function resolveRequestTimeoutMs({ promptTokens, numPredict, instancesDir }) {
  if (ENV_TIMEOUT_MS_OVERRIDE) return ENV_TIMEOUT_MS_OVERRIDE;
  const tokensPerSecond = ornithThroughput.getTokensPerSecond(instancesDir);
  return gpuCapacity.resolveTimeoutMs({
    promptTokens,
    numPredict,
    tokensPerSecond,
    ceilingMs: PER_CALL_TIMEOUT_CEILING_MS,
  });
}

// Calls Ornith once, retrying up to maxRetries times if the degenerate-output detector
// fires — per the doc, degeneracy is usually a transient inference-state glitch that
// self-heals on a later call with identical input, not a stable property of the prompt.
//
// opts.allowEmpty: several prompt templates (archDiscoveryImplementPrompt,
// deepDiveImplementPrompt, archImportImplementPrompt, projectSearchImplementPrompt --
// see prompts.js) explicitly instruct Ornith to "output the empty string and nothing
// else" when there is genuinely nothing to report, rather than force a fabricated
// candidate. Without this flag, detectDegenerate's 'empty' check can't tell that apart
// from a real empty-output failure, so a correct "nothing applies here" response burned
// 3 attempts (all correctly empty) before permanently blocking the task with
// "Implement pass degenerate: empty" -- confirmed live 2026-08-16: 64 of 181 blocked
// tasks, the single largest group in queue/blocked/, were exactly this -- Ornith
// following its own instructions, not a model or resource problem.
async function call(opts, maxRetries = 2) {
  let lastDegenerate = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await callOnce(opts);
    const degenerate = detectDegenerate(result.response, { allowEmpty: opts.allowEmpty });
    if (!degenerate) return { ...result, degenerate: null, attempts: attempt + 1 };
    lastDegenerate = degenerate;
  }
  return { response: '', thinking: '', degenerate: lastDegenerate, attempts: maxRetries + 1 };
}

// Majority-vote helper for qualitative judgment calls. Runs the SAME prompt `n` times
// at low temperature and returns the majority verdict, requiring an ABSOLUTE count of
// agreeing REAL (non-degenerate) votes (`minAgreeing`), not a relative comparison of
// two buckets that can both be small — that relative-comparison bug once let 1 genuine
// verdict + 2 degenerate "unclear" votes pass as a confident 1-0 consensus.
async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2 }) {
  const votes = [];
  for (let i = 0; i < n; i++) {
    const result = await call({ prompt, think: false, temperature }, 1);
    if (result.degenerate) continue;
    const verdict = classify(result.response);
    if (verdict) votes.push({ verdict, response: result.response });
  }

  const tally = {};
  for (const v of votes) tally[v.verdict] = (tally[v.verdict] || 0) + 1;

  let winner = null;
  let winnerCount = 0;
  for (const [verdict, count] of Object.entries(tally)) {
    if (count > winnerCount) {
      winner = verdict;
      winnerCount = count;
    }
  }

  return {
    verdict: winnerCount >= minAgreeing ? winner : null,
    confident: winnerCount >= minAgreeing,
    votes,
    realVoteCount: votes.length,
    requestedVotes: n,
  };
}

module.exports = { call, callOnce, majorityVote, detectDegenerate };

// CLI: node ornith-client.js <request.json>
// request.json: { prompt, think, temperature, numCtx, numPredict, repeatPenalty, maxRetries,
//                 format, mode: "single" | "majority-vote", classifyMarkers: [string, ...] }
//   format: "json" (or a JSON-schema object) grammar-constrains the response — use for passes
//           that must emit pure JSON (e.g. the state_targets implement pass drafting index.json).
// Writes the JSON result to stdout.
if (require.main === module) {
  const fs = require('fs');
  const requestPath = process.argv[2];
  if (!requestPath) {
    console.error('usage: node ornith-client.js <request.json>');
    process.exit(1);
  }
  const req = JSON.parse(fs.readFileSync(requestPath, 'utf8'));

  (async () => {
    try {
      if (req.mode === 'majority-vote') {
        const markers = req.classifyMarkers || [];
        const minReasoningChars = req.minReasoningChars || 0;
        const classify = (text) => {
          const lower = text.toLowerCase();
          const marker = markers.find((m) => lower.includes(m.toLowerCase()));
          if (!marker) return null;
          if (minReasoningChars > 0) {
            // Strip the marker itself (plus a following colon) and require real reasoning
            // text beyond it -- a bare "APPROVE" with the marker removed leaves nothing,
            // and should not count as a real vote. Added 2026-08-03: repeated live cases
            // where 3/3 bare "APPROVE" (zero reasoning) outvoted one correctly-reasoned
            // REJECT that specifically identified real bugs in the draft -- the model was
            // never asked to justify an APPROVE the way it was asked to justify a REJECT,
            // so it never did. Votes failing this check are excluded from the tally
            // entirely (same treatment as a degenerate vote), not counted as a weaker
            // APPROVE -- an unreasoned vote carries no signal either way.
            const stripped = text.replace(new RegExp(marker + '\\s*:?', 'i'), '').trim();
            if (stripped.length < minReasoningChars) return null;
          }
          return marker;
        };
        const result = await majorityVote({ ...req, classify });
        process.stdout.write(JSON.stringify(result));
      } else {
        const result = await call(req, req.maxRetries ?? 2);
        process.stdout.write(JSON.stringify(result));
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
