'use strict';

// Thin wrapper over the local Ollama HTTP API for whichever model LOCAL_MODEL names,
// encoding the mechanics and guardrails documented in Docs/agents/local-delegation.md so
// no caller
// has to rediscover them: explicit num_ctx/num_predict (the `ollama run` CLI silently
// truncates), a degenerate-output detector for the failure modes that fail *silently*
// (done_reason: stop, syntactically fine, semantically garbage), retry-on-degenerate
// (these have been observed to self-heal), and a majority-vote helper for judgment
// calls that are otherwise an invisible coin flip at default temperature.

const fs = require('fs');
const path = require('path');
const { postJson } = require('./ollama-http.js');
const inflightLock = require('./model-inflight-lock.js');
const gpuCapacity = require('./gpu-capacity.js');
const localThroughput = require('./local-throughput.js');
const { currentDateLine } = require('./current-date-line.js');
const { injectSideFindingInstruction, extractSideFindings, writeSideFindingInbox } = require('./side-finding.js');
const { injectAmplificationInstruction, extractAmplificationRequests } = require('./incident-amplification-marker.js');
const { runAmplificationSweep } = require('./incident-amplification.js');
const { injectConceptBuildInstruction, extractConceptBuildReport, recordConceptBuildTally } = require('./concepts.js');
const { logPipelineEvent } = require('./pipeline-history.js');

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

// Same tolerant derivation as resolveInstancesDir() above, one level up (the pipelineDir
// itself rather than its instances/ subdir) -- side-finding inbox writes are just as
// best-effort as the in-flight lock, never a hard requirement to have a full pipeline env.
function resolvePipelineDir() {
  const repoRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  if (!repoRoot) return null;
  return process.env.AGENT_MANAGER_PIPELINE_DIR || repoRoot;
}

// Persistent, human-auditable trail of every degenerate plan/implement attempt (2026-09-06,
// Grimmethy: "can we use the same end of task logging developed for diagnosing the in app
// chat" -- local-tool-client.js's logContextAudit closed the identical problem for the
// agentic tool-calling loop: a real Chat run hit done_reason:"length" 3 times with nothing
// persisting WHY at each turn, so a later investigation meant re-deriving it from a
// transcript's own visible text after the fact. The plain plan/implement call() below --
// used by every non-agentic source (pipeline_debrief, observability_fix, change_review,
// pipeline_forensics_fix, ...) -- had the exact same blind spot, just one level lower: only
// task.blockedReason's own final string survived past a degenerate attempt, and every
// EARLIER attempt within the SAME call's retry loop left no trace at all. Confirmed live
// investigating a 37-task truncation cluster spanning 6+ different sources: reconstructing
// "does this always hit the same numPredict ceiling, or does it vary" required manually
// cross-referencing model-stats.db against each task's own JSON, one at a time. One NDJSON
// line per degenerate attempt (not just the final one) means that's `grep` from now on.
// Same file-writing shape as logContextAudit (best-effort, must never break the real call).
// 2026-09-08: now a thin wrapper over pipeline-history.js's unified writer -- see that
// file's own header for why the 4 separately-invented per-class log files (this one
// included) were consolidated into one NDJSON stream discriminated by `type`, mirroring
// dspy.settings.GLOBAL_HISTORY. Same call signature as before this change; no call site
// anywhere in this file needed to change.
// instanceId (2026-09-08, Grimmethy: "I want to see a log of every time an agent is run
// and the outcome of that run" -- the per-instance Workers-tab run log this feeds needed
// a way to attribute a FAILED run to the worker that made it, which neither this log nor
// hard-failure-audit's own entries carried before now; model-stats-client.js's recordCall
// already stamps the exact same env var onto every SUCCESSFUL call for the identical
// reason (see its own instanceId comment) -- stamped here in the wrapper, not at each call
// site, so no future caller of either logger can forget it.
function logDegenerateAudit(entry) {
  logPipelineEvent(resolvePipelineDir(), 'degenerate', { ...entry, instanceId: process.env.AGENT_MANAGER_INSTANCE_ID || null });
}

// 2026-09-08, Second Brain [[dspy]] research applied (dspy/utils/exceptions.py's typed
// LMError hierarchy, plus ollama-http.js's new OLLAMA_ERROR_CODES tagging): a HARD call
// failure (timeout, connection refused, non-200) used to just get re-thrown after
// call()'s retries were exhausted, with zero persistent trail -- unlike degenerate OUTPUT
// just above, which this same file already logs per-attempt. This session diagnosed
// THREE completely different root causes (P40 thermal throttling, host RAM starvation, a
// model load-order eviction bug) that all surfaced as the identical generic symptom
// ("Ollama request timed out") and each needed a fresh, multi-hour LIVE investigation to
// tell apart. One NDJSON line per hard-failed attempt (not just the final re-thrown
// error), tagged with ollama-http.js's own error `code`, means the NEXT occurrence of
// this symptom is a `grep instances/hard-failure-audit.log` away from knowing which of
// the known classes it is, or that it's a genuinely new one -- same "make it grep-able
// instead of manual archaeology" discipline as logDegenerateAudit and every other audit
// log this pipeline has accumulated. Deliberately a SEPARATE file from degenerate-audit.log
// -- a call that never got a response at all and a call that got a real-but-bad response
// are different failure classes with different fixes. 2026-09-08: now a thin wrapper over
// pipeline-history.js's unified writer, same reasoning as logDegenerateAudit above.
function logHardFailureAudit(entry) {
  logPipelineEvent(resolvePipelineDir(), 'hard-failure', { ...entry, instanceId: process.env.AGENT_MANAGER_INSTANCE_ID || null });
}

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
// 2026-09-11 (screaminggoatclubmt, "p40 is entirely blocked by ollama timeouts"):
// worker-p40/worker-reasoning-p40 set OLLAMA_URL to the P40 VM's Ollama instance
// (AGENT_MANAGER_P40_OLLAMA_URL) -- when this process's OLLAMA_URL matches it, this IS
// the P40 lane, confirmed by comparing the two resolved env vars directly rather than
// guessing from a hostname pattern.
const IS_P40_ENDPOINT = !!process.env.AGENT_MANAGER_P40_OLLAMA_URL && OLLAMA_URL === process.env.AGENT_MANAGER_P40_OLLAMA_URL;
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
// 2026-08-31: exported so local-tool-client.js's /api/chat calls (the agentic tool loop --
// Chat panel + every local agentic draft tier) send the SAME keep_alive. Until then that
// path sent none at all and inherited Ollama's 5-minute default, so a single agentic turn
// that outran 5 min (model reasoning + a 240s run_bash + the GPU lock held elsewhere in
// between) paid a full cold reload (~114s observed) on the next turn.
const KEEP_ALIVE = process.env.LOCAL_KEEP_ALIVE || process.env.ORNITH_KEEP_ALIVE || '30m';

function detectDegenerate(text, { allowEmpty = false, doneReason } = {}) {
  // 2026-09-05, Grimmethy: root-caused a whole cluster of blocked pipeline_forensics_fix
  // tasks (AC-4/6/8/20) whose PLAN pass came back non-empty, real-looking, non-degenerate
  // text that just... stopped mid-sentence ("**Scope:** `src/local-tool-client.js` only.
  // No other", "in `src/prompts.js` (imported via `require('./prompts.js')") -- Ollama's
  // own done_reason:"length" (num_predict reached before the model emitted a real stop
  // token, likely `think:true` reasoning eating most of the budget before any visible
  // answer) was silently accepted as a complete, trustworthy response because nothing
  // here ever looked at it. The truncated plan then fed a real implement call nothing
  // coherent to work from, which failed its OWN separate way ("Implement pass degenerate:
  // empty") 3 attempts running -- the actual root cause was one call earlier and
  // invisible. done_reason:"length" is UNAMBIGUOUS (Ollama only sets it when generation
  // was cut off before a natural stop, never for a genuinely complete response), so this
  // checks it first, unconditionally (even ahead of allowEmpty) and feeds the SAME
  // existing retry-on-degenerate loop callOnce()'s caller already runs for every other
  // degenerate reason -- no new mechanism, just closing a blind spot in this one.
  if (doneReason === 'length') return 'truncated';
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

async function callOnce({ prompt, think = true, temperature = 0.4, numCtx, numPredict = 1200, repeatPenalty, format, model, timeoutMs, source, allowSideFindings = true, allowAmplification = false, conceptId = null }) {
  // Pipeline-wide side-finding capture (2026-09-05, see side-finding.js's own header):
  // tell the model the SIDE-FINDING: convention exists, unless this specific call needs
  // clean/parseable-only output (allowSideFindings: false -- set by known strict-schema
  // callers: brain_dump_sort's classify pass, digest-verdict parsing, decompose's JSON
  // response, path-prefetch-resolve) OR the call is already grammar-constrained
  // (`format` set) -- a constrained decode literally cannot emit free text, so the
  // instruction would just be wasted prompt tokens.
  let effectivePrompt = (allowSideFindings && !format) ? injectSideFindingInstruction(prompt) : prompt;
  // Incident Amplification (2026-09-08, see incident-amplification-marker.js's own
  // header): unlike SIDE-FINDING, this is opt-in (default false) -- it's a heavier,
  // deliberate action (a real broad grep sweep + N filed brain-dump entries), not a cheap
  // flag, so it shouldn't be prompted on every routine call, only where a caller has
  // explicitly opted in (the Chat panel).
  if (allowAmplification && !format) effectivePrompt = injectAmplificationInstruction(effectivePrompt);
  // Concept-build self-report (2026-09-06, see concepts.js's own header): only injected
  // when the CALLER opted this specific task into concept tracking (conceptId set) --
  // unlike side-finding, never on by default, since this is a deliberate audit tag, not
  // a general-purpose channel.
  if (conceptId && !format) effectivePrompt = injectConceptBuildInstruction(effectivePrompt);
  const datedPrompt = `${currentDateLine()}\n\n${effectivePrompt}`;
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
  const resolvedTimeoutMs = timeoutMs || resolveRequestTimeoutMs({ promptTokens, numPredict, instancesDir, model: lockModel });
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
    localThroughput.recordSample(instancesDir, { evalCount: result.eval_count, evalDurationNs: result.eval_duration, endpoint: OLLAMA_URL, model: lockModel });
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

// 2026-09-11 (screaminggoatclubmt, "p40 is entirely blocked by ollama timeouts"): the
// 240s ceiling above was sized for the local RTX 3090's throughput. Confirmed live via
// pipeline-history.log: 100% of real worker-p40/worker-reasoning-p40 draft calls hit
// OLLAMA_TIMEOUT at exactly 240000ms once a plan pass needed the 2800-token budget
// (computePlanNumPredict) -- at the P40's real measured ~9.3 tok/s, 2800 tokens of
// generation alone takes ~301s, already past this ceiling before the 2.5x safety
// margin or prompt-eval time. This is structural, not intermittent: a fixed wall-clock
// cap doesn't scale with hardware that is ~3.5x slower. Raised for the P40 endpoint
// specifically (see IS_P40_ENDPOINT above) rather than for every caller, since a
// generously long ceiling on the FAST local GPU would just let a genuinely hung call
// sit for 15 minutes before anyone notices. dead-process-check.js's
// WORKER_ZOMBIE_THRESHOLD_SECONDS has a matching P40-specific exception so a legitimately
// still-generating P40 worker isn't SIGKILL'd mid-call by the watchdog -- the two values
// must be changed together (see that file's own comment on the worst-case chain math).
// A deliberate, named exception to docs/pipeline-incident-2026-07-19.md's formalized
// "nothing in this pipeline should exceed 5 minutes" rule -- that rule was calibrated to
// the local RTX 3090; the P40 VM is a categorically different, ~3.5x slower, physically
// isolated endpoint (see gpu-capacity.js's resolveTimeoutMs hardCeilingMs param for the
// mechanism this passes through). This is the "revisit this reasoning first" the
// incident doc itself requires before exceeding its ceiling, not a silent bump.
const P40_PER_CALL_TIMEOUT_CEILING_MS = 900_000;
const ENV_TIMEOUT_MS_OVERRIDE = Number(process.env.LOCAL_TIMEOUT_MS || process.env.ORNITH_TIMEOUT_MS) || null;

function resolveRequestTimeoutMs({ promptTokens, numPredict, instancesDir, model }) {
  if (ENV_TIMEOUT_MS_OVERRIDE) return ENV_TIMEOUT_MS_OVERRIDE;
  const tokensPerSecond = localThroughput.getTokensPerSecond(instancesDir, OLLAMA_URL, model);
  return gpuCapacity.resolveTimeoutMs({
    promptTokens,
    numPredict,
    tokensPerSecond,
    ceilingMs: IS_P40_ENDPOINT ? P40_PER_CALL_TIMEOUT_CEILING_MS : PER_CALL_TIMEOUT_CEILING_MS,
    hardCeilingMs: IS_P40_ENDPOINT ? P40_PER_CALL_TIMEOUT_CEILING_MS : undefined,
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
// 2026-09-06: logDegenerateAudit's very first real production data (the mechanism it
// was built to enable) showed this loop's blind spot immediately -- two brain-dump-
// spawned adhoc plan passes each hit doneReason:"length" on ALL 3 attempts with
// evalCount === numPredict every single time, identically. Unlike the other degenerate
// classes (empty/repeated-character/non-ascii-gibberish/repetition-loop), which the
// module doc above correctly calls "usually a transient inference-state glitch" worth
// retrying unchanged, a numPredict ceiling is not transient: the SAME ceiling on the
// SAME prompt reproduces the SAME cutoff deterministically, so retrying identically
// burns the entire retry budget for zero chance of success. Escalating numPredict
// (not numCtx -- resolveNumCtx already ignores numPredict and returns the fixed
// PINNED_NUM_CTX/24576 regardless, so there is always ample headroom left for a
// bigger numPredict on the same prompt) on a truncated retry gives a REAL chance the
// next attempt actually completes, at the same latency cost the identical-retry
// approach was already paying either way.
const TRUNCATION_RETRY_MULTIPLIER = 2;
const TRUNCATION_RETRY_NUM_PREDICT_CEILING = 8000;

async function call(opts, maxRetries = 2) {
  let lastDegenerate = null;
  let lastError = null;
  let gotAnyResponse = false;
  let callOpts = opts;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let result;
    try {
      result = await callOnce(callOpts);
    } catch (e) {
      lastError = e;
      logHardFailureAudit({
        source: opts.source, taskId: opts.taskId, stage: opts.stage, attempt: attempt + 1, maxRetries,
        model: opts.model || MODEL, code: e.code || null, message: String(e.message || e).slice(0, 300),
        timeoutMs: e.timeoutMs, statusCode: e.statusCode, nodeCode: e.nodeCode,
      });
      continue;
    }
    gotAnyResponse = true;
    // Extract any SIDE-FINDING: block(s) BEFORE degenerate-detection judges the response,
    // so a response that's otherwise degenerate/empty except for a stray finding isn't
    // misjudged either way, and so the caller's own downstream RESOLUTION:/JSON parsing
    // never sees the raw marker text.
    if (opts.allowSideFindings !== false && result.response && result.response.includes('SIDE-FINDING:')) {
      const { cleanText, findings } = extractSideFindings(result.response);
      result = { ...result, response: cleanText };
      if (findings.length) {
        const pipelineDir = resolvePipelineDir();
        for (const finding of findings) {
          writeSideFindingInbox(finding, { source: opts.source, taskId: opts.taskId, stage: opts.stage, pipelineDir });
        }
      }
    }
    if (opts.allowAmplification && result.response && result.response.includes('AMPLIFY:')) {
      const { cleanText, requests } = extractAmplificationRequests(result.response);
      result = { ...result, response: cleanText };
      if (requests.length) {
        const pipelineDir = resolvePipelineDir();
        for (const req of requests) {
          runAmplificationSweep({
            rootCauseSummary: req.rootCauseSummary, query: req.query, dir: req.dir,
            excludeFiles: req.exclude, pipelineDir, source: opts.source, taskId: opts.taskId,
          });
        }
      }
    }
    if (opts.conceptId && result.response && result.response.includes('CONCEPT-BUILD:')) {
      const { cleanText, report } = extractConceptBuildReport(result.response);
      result = { ...result, response: cleanText };
      if (report) {
        recordConceptBuildTally(resolvePipelineDir(), opts.conceptId, report.kind);
      }
    }
    const degenerate = detectDegenerate(result.response, { allowEmpty: opts.allowEmpty, doneReason: result.done_reason });
    if (!degenerate) return { ...result, degenerate: null, attempts: attempt + 1 };
    lastDegenerate = degenerate;
    // Logged for THIS attempt, not just once the whole call gives up -- so a later
    // investigation can see the retry PATTERN (e.g. all 3 attempts hit numPredict
    // identically vs. attempt 1 empty then 2-3 truncated), not just the final verdict
    // task.blockedReason alone preserves today.
    logDegenerateAudit({
      source: opts.source, taskId: opts.taskId, stage: opts.stage, attempt: attempt + 1, maxRetries,
      model: opts.model || MODEL, numPredict: callOpts.numPredict, doneReason: result.done_reason,
      degenerate, promptEvalCount: result.prompt_eval_count, evalCount: result.eval_count,
    });
    if (degenerate === 'truncated' && callOpts.numPredict) {
      const escalated = Math.min(
        Math.round(callOpts.numPredict * TRUNCATION_RETRY_MULTIPLIER),
        TRUNCATION_RETRY_NUM_PREDICT_CEILING,
      );
      if (escalated > callOpts.numPredict) callOpts = { ...callOpts, numPredict: escalated };
    }
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
// allowSideFindings:false -- a majorityVote() is always a BINARY CLASSIFIER (CONFIRM/DENY,
// APPROVE/REJECT), never an exploratory pass, so the SIDE-FINDING: channel is pure noise
// here: the vote model free-associates commentary about its own prompt instead of voting.
// Confirmed live -- the entire needs_clarification_triage brain-dump family (serials
// 644-669, all taskId:null, serial 644 "Different Scope" dedup-counted to 406, several
// promoted to dud tasks against already-resolved work; two even echoed the instruction's
// own "<1-3 sentences of detail>" placeholder verbatim). false suppresses BOTH the prompt
// injection and the response extraction. Real problems with what's being voted on go
// through the verdict itself (a REJECT reason), not a side-finding.
// taskId/stage are still threaded through for call()'s hard-failure-audit log
// (logHardFailureAudit keys off opts.taskId).
async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2, source, model, numCtx, numPredict, taskId, stage }) {
  const votes = [];
  const voteErrors = [];
  for (let i = 0; i < n; i++) {
    let result;
    try {
      result = await call({ prompt, think: false, temperature, source, model, numCtx, numPredict, taskId, stage, allowSideFindings: false }, 1);
    } catch (e) {
      // This ONE vote hard-failed (e.g. a network timeout that survived call()'s own
      // retry above) -- must not abort the other n-1 votes, which may well succeed under
      // exactly the same slow-but-not-dead conditions. See this function's own 2026-08-23
      // header note: 59 of the last 62 real review attempts failed this way, each
      // discarding whatever votes DID land because the first failure killed the whole
      // majorityVote() call outright.
      console.warn(`[local-client] majorityVote: vote ${i + 1}/${n} hard-failed: ${e.message}`);
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

module.exports = { call, callOnce, majorityVote, detectDegenerate, logDegenerateAudit, logHardFailureAudit, KEEP_ALIVE, PER_CALL_TIMEOUT_CEILING_MS, P40_PER_CALL_TIMEOUT_CEILING_MS, IS_P40_ENDPOINT, resolveRequestTimeoutMs };

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
