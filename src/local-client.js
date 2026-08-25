'use strict';

// Thin wrapper over the local Ollama HTTP API for whichever model LOCAL_MODEL names,
// encoding the mechanics and guardrails documented in Docs/agents/local-delegation.md so
// no caller
// has to rediscover them: explicit num_ctx/num_predict (the `ollama run` CLI silently
// truncates), a degenerate-output detector for the failure modes that fail *silently*
// (done_reason: stop, syntactically fine, semantically garbage), retry-on-degenerate
// (these have been observed to self-heal), and a majority-vote helper for judgment
// calls that are otherwise an invisible coin flip at default temperature.

const path = require('path');
const { postJson } = require('./ollama-http.js');
const inflightLock = require('./model-inflight-lock.js');
const gpuCapacity = require('./gpu-capacity.js');
const localThroughput = require('./local-throughput.js');
const { currentDateLine } = require('./current-date-line.js');

// Deliberately NOT config.js's getConfig() -- that throws if AGENT_MANAGER_REPO_ROOT is
// unset, which would turn every caller of this module (including test files that require
// it without setting up a full pipeline env) into a hard crash just from requiring
// local-client.js. Same pipelineDir-falls-back-to-repoRoot derivation config.js uses,
// just tolerant of "neither is set" (returns null -- the in-flight lock below then simply
// isn't taken, same as any other best-effort failure in acquire()).
function resolveInstancesDir() {
  const repoRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  if (!repoRoot) return null;
  const pipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR || repoRoot;
  return path.join(pipelineDir, 'instances');
}

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
// No hardcoded fallback tag here on purpose (2026-08-22, Grimmethy: "The models are or
// should be fully interchangeable and their names should not be hardcoded anywhere") --
// this used to fall back to the bare literal string 'ornith', which isn't a real Ollama
// model tag at all (real tags are versioned, e.g. "ornith:35b"/"qwen3.8:27b-q4_K_M") and
// would have silently sent a bogus model name to Ollama's real API instead of failing
// clearly. An unset LOCAL_MODEL now surfaces as a real, loud Ollama "model not found"
// error at call time instead of a plausible-looking wrong one.
const MODEL = process.env.LOCAL_MODEL;
// Without this, Ollama falls back to its own default unload window between calls --
// observed live 2026-07-18 paying a ~38-40s cold-load penalty on the very next call
// whenever a gap (between passes, or between tasks) outlasted it. Free to set generously
// since nothing else is competing for the model slot on this box (OLLAMA_MAX_LOADED_MODELS
// effectively 1 already, per local-worker.ps1's own comment on why concurrent instances
// must share one model tier).
// 2026-08-24 (Grimmethy: "Ornith is no longer the default model... reference local
// instead") -- LOCAL_KEEP_ALIVE is the current name; ORNITH_KEEP_ALIVE still read as a
// fallback so an existing deployment's env doesn't silently stop working after this rename.
const KEEP_ALIVE = process.env.LOCAL_KEEP_ALIVE || process.env.ORNITH_KEEP_ALIVE || '30m';

function detectDegenerate(text, { allowEmpty = false } = {}) {
  if (!text || text.trim().length === 0) return allowEmpty ? null : 'empty';

  // The local model sometimes writes the literal two-character JSON-style empty-string
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

// 2026-08-23: this used to call getCapacitySnapshot() here -- a LIVE nvidia-smi + /api/ps
// read on every call, feeding gpuCapacity.computeMaxSafeNumCtx() to clamp num_ctx --
// removed after confirming live that it was the actual cause of the "pin num_ctx to one
// stable value" fix (gpu-capacity.js's own PINNED_NUM_CTX) not holding in practice: every
// real pipeline call is a FRESH node subprocess (no cross-process cache; capacityCache
// only ever helped within a single process's own lifetime, which no caller here has), so
// under concurrent GPU load (multiple worker/reviewer lanes, each spawning their own
// subprocess) the live VRAM reading is genuinely noisy call to call -- watched it directly:
// three consecutive model loads landed at three different context sizes (7168, 4096,
// 7168) purely from this clamp fluctuating, each triggering Ollama's own severe
// slow-reprocessing behavior for a context change. PINNED_NUM_CTX was already verified
// safe for this box's real VRAM headroom (see gpu-capacity.js's own comment) -- there is
// no remaining reason to re-derive a safety ceiling from a noisy per-call reading when the
// pinned value's own safety was already established once, not per call.
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4); // rough chars-per-token estimate -- only used to bucket a context window and a timeout budget, not to enforce a hard limit.
}

async function callOnce({ prompt, think = true, temperature = 0.4, numCtx, numPredict = 1200, repeatPenalty, format, model, timeoutMs, source }) {
  const datedPrompt = `${currentDateLine()}\n\n${prompt}`;
  const promptTokens = estimateTokens(datedPrompt);

  const resolvedNumCtx = numCtx || gpuCapacity.resolveNumCtx({ estimatedTokens: promptTokens, numPredict });

  const options = { num_ctx: resolvedNumCtx, num_predict: numPredict, temperature };
  if (repeatPenalty) options.repeat_penalty = repeatPenalty;

  const body = { model: model || MODEL, prompt: datedPrompt, think, stream: false, keep_alive: KEEP_ALIVE, options };
  // Grammar-constrained decoding. When `format` is set ("json", or a full JSON-schema object),
  // Ollama restricts the sampler to tokens valid for that grammar, so a malformed or
  // markdown-fenced response is *unrepresentable* rather than merely discouraged in the prompt.
  // This is the structural replacement for "Output ONLY the draft JSON"-style instructions that
  // the model is documented to ignore (Docs/agents/local-delegation.md — a real state_targets
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
  // Stable per-worker-lane session id (not per-call) so TokenFold sees these as a
  // continuing session instead of hashing each distinct prompt into its own one-off
  // session -- see postJson's extraHeaders doc for why that continuity is what lets its
  // dictionary bootstrap cost amortize at all across this pipeline's calls.
  const tokenFoldHeaders = { 'X-TokenFold-Session': `agent-manager-${process.env.AGENT_MANAGER_INSTANCE_ID || 'default'}` };
  // Per-task-type dictionary (Grimmethy, 2026-08-21: "Each job type could have it's own
  // folded dictionary") -- one worker lane's session bounces between many different
  // task sources (observability_review, arch_discovery, ...) whose PROMPT TEMPLATES
  // (prompts.js) are each internally consistent but very different from each other;
  // sharing one dictionary across all of them diluted every template's own real
  // repetition into a single mixed pool. `source` is optional (some callers, e.g. the
  // A/B eval harness, don't have a real task) -- falls through to TokenFold's own
  // default/global scope when omitted, same as it always did before this existed.
  if (source) tokenFoldHeaders['X-TokenFold-Scope'] = source;
  try {
    const result = await postJson(`${OLLAMA_URL}/api/generate`, body, resolvedTimeoutMs, tokenFoldHeaders);
    localThroughput.recordSample(instancesDir, { evalCount: result.eval_count, evalDurationNs: result.eval_duration });
    // 2026-08-23, Grimmethy: "we need a way to differentiate 'working' from 'loading'...
    // this isn't the first time a lack of verbosity has caused us confusion" -- Ollama's
    // own response already carries this exact breakdown (load_duration -- time spent
    // loading/reloading the model, e.g. a context-size swap, BEFORE any generation even
    // starts -- separate from prompt_eval_duration and eval_duration), but callOnce()
    // silently discarded it; only reasoning-bench.js's own offline benchmark ever read
    // it. Diagnosing the real Ollama-timeout root cause this session required
    // reconstructing this same signal after the fact from journalctl/ps aux archaeology
    // across a dozen ollama restarts -- this makes it visible directly in the caller's
    // own log (worker-1.log/review-runner.log, via their existing 2>>"$LOG_FILE"
    // redirect) for every real call going forward, no reconstruction needed next time.
    const loadMs = result.load_duration != null ? Math.round(result.load_duration / 1e6) : null;
    const promptEvalMs = result.prompt_eval_duration != null ? Math.round(result.prompt_eval_duration / 1e6) : null;
    const evalMs = result.eval_duration != null ? Math.round(result.eval_duration / 1e6) : null;
    const totalMs = result.total_duration != null ? Math.round(result.total_duration / 1e6) : null;
    console.error(`[local-client] call timing: model=${body.model} source=${source || 'none'} numCtx=${resolvedNumCtx} loadMs=${loadMs} promptEvalMs=${promptEvalMs} evalMs=${evalMs} totalMs=${totalMs}`);
    return result;
  } finally {
    inflightLock.release(lockPath);
  }
}

// PER_CALL_TIMEOUT_CEILING_MS stays at the pipeline's pre-existing 4-minute ceiling, not
// ollama-http.js's full 5-minute hard ceiling -- dead-process-check.js's
// WORKER_ZOMBIE_THRESHOLD_SECONDS (20 min) was sized against "up to 4 sequential
// localCall()s per task, each individually bounded by 240s -- worst case ~960s" with
// deliberate slack to 1200s. Letting a single call float all the way to 300s would erase
// that slack (4*300s = 1200s, exactly the zombie threshold, zero margin) without anyone
// having revisited that math -- so a computed timeout here can come in BELOW 240s for cheap
// calls (failing faster, freeing a stuck lane sooner) but never above it. An explicit
// LOCAL_TIMEOUT_MS (or the older ORNITH_TIMEOUT_MS name) still overrides everything below,
// same as before this module existed.
const PER_CALL_TIMEOUT_CEILING_MS = 240_000;
const ENV_TIMEOUT_MS_OVERRIDE = Number(process.env.LOCAL_TIMEOUT_MS || process.env.ORNITH_TIMEOUT_MS) || null;

function resolveRequestTimeoutMs({ promptTokens, numPredict, instancesDir }) {
  if (ENV_TIMEOUT_MS_OVERRIDE) return ENV_TIMEOUT_MS_OVERRIDE;
  const tokensPerSecond = localThroughput.getTokensPerSecond(instancesDir);
  return gpuCapacity.resolveTimeoutMs({
    promptTokens,
    numPredict,
    tokensPerSecond,
    ceilingMs: PER_CALL_TIMEOUT_CEILING_MS,
  });
}

// Calls the local model once, retrying up to maxRetries times if the degenerate-output
// detector fires — per the doc, degeneracy is usually a transient inference-state glitch
// that self-heals on a later call with identical input, not a stable property of the
// prompt.
//
// opts.allowEmpty: several prompt templates (archDiscoveryImplementPrompt,
// deepDiveImplementPrompt, archImportImplementPrompt, projectSearchImplementPrompt --
// see prompts.js) explicitly instruct the local model to "output the empty string and
// nothing else" when there is genuinely nothing to report, rather than force a
// fabricated candidate. Without this flag, detectDegenerate's 'empty' check can't tell
// that apart from a real empty-output failure, so a correct "nothing applies here"
// response burned 3 attempts (all correctly empty) before permanently blocking the task
// with "Implement pass degenerate: empty" -- confirmed live 2026-08-16: 64 of 181
// blocked tasks, the single largest group in queue/blocked/, were exactly this -- the
// local model
// following its own instructions, not a model or resource problem.
// 2026-08-23, Grimmethy: "Why are 17 tasks sitting in review instead of being processed
// fully?" -- traced to review-runner's majorityVote() aborting its ENTIRE 3-vote call the
// instant the FIRST vote's callOnce() throws (a real network/timeout error, not a
// degenerate-content retry, which this loop already handled) -- confirmed live: 59 of the
// last 62 review attempts failed this way, each report showing only ONE timeout even
// though up to 3 votes were supposed to run, because the very first one killed the whole
// attempt before the other two ever got a chance. This loop already retries maxRetries
// times for a bad-content (degenerate) response; a hard network failure got zero retry
// benefit at all, propagating immediately on attempt 0 regardless of maxRetries. Now a
// hard failure is retried exactly the same as a degenerate one -- lastError is tracked
// separately from lastDegenerate so, if every attempt hard-fails with no usable response
// at all, the real error still propagates (existing callers -- draft's infra-requeue
// regex match, review-runner's own equivalent -- depend on receiving a real thrown Error
// with the actual message, e.g. "Ollama request timed out...", not a swallowed one).
async function call(opts, maxRetries = 2) {
  let lastDegenerate = null;
  let lastError = null;
  let gotAnyResponse = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let result;
    try {
      result = await callOnce(opts);
    } catch (e) {
      lastError = e;
      continue;
    }
    gotAnyResponse = true;
    const degenerate = detectDegenerate(result.response, { allowEmpty: opts.allowEmpty });
    if (!degenerate) return { ...result, degenerate: null, attempts: attempt + 1 };
    lastDegenerate = degenerate;
  }
  // Only propagate the hard error if NO attempt ever got a real response, degenerate or
  // not -- a degenerate response on an earlier attempt followed by a hard failure on a
  // later retry is still a real, legitimate degenerate outcome, not an infra failure.
  if (!gotAnyResponse && lastError) throw lastError;
  return { response: '', thinking: '', degenerate: lastDegenerate, attempts: maxRetries + 1 };
}

// Majority-vote helper for qualitative judgment calls. Runs the SAME prompt `n` times
// at low temperature and returns the majority verdict, requiring an ABSOLUTE count of
// agreeing REAL (non-degenerate) votes (`minAgreeing`), not a relative comparison of
// two buckets that can both be small — that relative-comparison bug once let 1 genuine
// verdict + 2 degenerate "unclear" votes pass as a confident 1-0 consensus.
// 2026-08-24: model/numCtx/numPredict added -- previously silently dropped, so a
// model-profile-registry.js profile naming a specific model/context/output-length had no
// way to actually reach a vote (majorityVote is the only caller of call() review-task.js
// uses). All three are plain pass-throughs to the same-named callOnce() options this
// function's own internal call() already accepts; omitted entirely (undefined) preserves
// today's exact behavior (call()'s own defaults / this module's MODEL const) for every
// existing caller that doesn't pass them.
async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2, source, model, numCtx, numPredict }) {
  const votes = [];
  const voteErrors = [];
  for (let i = 0; i < n; i++) {
    let result;
    try {
      result = await call({ prompt, think: false, temperature, source, model, numCtx, numPredict }, 1);
    } catch (e) {
      // This ONE vote hard-failed (e.g. a network timeout that survived call()'s own
      // retry above) -- must not abort the other n-1 votes, which may well succeed under
      // exactly the same slow-but-not-dead conditions. See this function's own 2026-08-23
      // header note: 59 of the last 62 real review attempts failed this way, each
      // discarding whatever votes DID land because the first failure killed the whole
      // majorityVote() call outright.
      voteErrors.push(e.message);
      continue;
    }
    if (result.degenerate) continue;
    const verdict = classify(result.response);
    if (verdict) votes.push({ verdict, response: result.response });

    // Early-exit once any verdict has mathematically already secured minAgreeing votes
    // -- no remaining vote can change the outcome (adding to a losing verdict's tally, or
    // starting a fresh one, can never overtake a count that's already >= minAgreeing out
    // of n total). 2026-08-23, Grimmethy: "Are there opportunities to make the actual
    // review more efficient?" -- the common 2-of-3-agree case was still always paying for
    // a full 3rd real generation call whose result could never change the verdict, pure
    // wasted GPU time on every single review. Safe for any n/minAgreeing combination, not
    // just the default 3/2 -- a verdict's own count can only ever go UP as more votes
    // come in, never down, so "already >= minAgreeing" is a permanent, not provisional,
    // fact once observed.
    const earlyCounts = {};
    for (const v of votes) earlyCounts[v.verdict] = (earlyCounts[v.verdict] || 0) + 1;
    if (Object.values(earlyCounts).some((c) => c >= minAgreeing)) break;
  }

  // Only when EVERY vote hard-failed (zero real responses of any kind, not even a
  // degenerate one) is this a genuine infra failure rather than a legitimate "no
  // consensus reached" outcome -- rethrow so the caller's existing infra-requeue
  // detection (the same real-error-message match draft's own path already relies on)
  // still catches it, instead of silently reporting a false "inconclusive" verdict for
  // what was actually zero real votes cast.
  if (voteErrors.length === n) {
    throw new Error(voteErrors[voteErrors.length - 1]);
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
    voteErrors,
  };
}

module.exports = { call, callOnce, majorityVote, detectDegenerate };

// CLI: node local-client.js <request.json>
// request.json: { prompt, think, temperature, numCtx, numPredict, repeatPenalty, maxRetries,
//                 format, mode: "single" | "majority-vote", classifyMarkers: [string, ...] }
//   format: "json" (or a JSON-schema object) grammar-constrains the response — use for passes
//           that must emit pure JSON (e.g. the state_targets implement pass drafting index.json).
// Writes the JSON result to stdout.
if (require.main === module) {
  const fs = require('fs');
  const requestPath = process.argv[2];
  if (!requestPath) {
    console.error('usage: node local-client.js <request.json>');
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
