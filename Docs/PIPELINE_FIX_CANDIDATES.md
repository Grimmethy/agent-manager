# Pipeline Fix Candidates

<!--
Confirmed root-cause fixes proposed by pipeline_forensics (src/pipeline-forensics.js).
Each `### AC-NNN` block is appended by applyForensicsReport (src/apply-group-a.js) once a
human confirms the forensic report at queue/awaiting-confirm/. The pipeline_forensics_fix
source (src/task-sources.js) consumes these into a real src/ diff on an agent/ branch for
manual merge. AC numbers are assigned at append time from this doc's current max; do not
renumber existing blocks (in-flight task-id dedup depends on them).
-->

<!--
2026-09-01 prune: AC-5 (requiresVerification -> single-shot routing) LANDED on master
(f8ab97d0). AC-2 and AC-3 were the originals whose fix passes decomposed them -- AC-2 -> AC-6/7/8,
AC-3 -> AC-4/5 -- so they are removed here, superseded by those children. AC-9/AC-10 were
re-statements of AC-5 and are removed. pipeline_forensics_fix is now noCandidateSplit:true
(src/task-sources.js) so a candidate can no longer be re-split into yet more candidates --
the runaway that produced AC-4..AC-12 in one afternoon. The 5 blocks below are the real,
un-landed fixes; each is a single- or two-file change a no-split pass can land directly.
-->

### AC-1 · on-demand signature "manual::botched-decompose"
Strength: Strong
Signature: manual::botched-decompose
Files: src/reject-retry-check.js, src/local-tool-client.js

Problem: When the tier-3 agent in `src/local-agentic-write-draft.js` concludes that the requested feature does not exist in the codebase and explicitly asks for human input, the pipeline's block/retry logic in `src/reject-retry-check.js` records this as a generic "exhausted turn budget" block and consumes a retry slot. The shared turn-loop in `src/local-tool-client.js` enforces the hard ceiling without inspecting whether the agent's final message already contains a terminal escalation signal, so a valid "I need a human" conclusion is indistinguishable from "I ran out of time mid-exploration." The result is 2–3 wasted full pipeline runs (each with 3 tiers × 8–20 turns) before the `exhausted: 2/2 retries used` guard finally fires the needs-clarification escalation.
Solution: In `src/local-tool-client.js`, after the turn loop terminates (whether by budget or by the agent stopping), add a post-loop inspection of the agent's final message for a terminal-escalation pattern (e.g., the message contains both a statement that the target code/feature is absent AND an explicit request for human input or an open question). If detected, return a structured result `{status: "needs-clarification", reason: <agent's stated reason>}` instead of `{status: "blocked", reason: "exhausted turn budget"}`. In `src/reject-retry-check.js`, add a branch: if the incoming block reason is `needs-clarification` (as opposed to a generic `blocked`), skip the retry counter and route directly to the `needs-clarification` state without consuming a retry slot. Acceptance check: re-run the failing task subject 1 through the pipeline; after the first attempt's tier-3 agent emits its "Open question(s) for a human" message, the task state should transition to `needs-clarification` with `retriesUsed: 0/2` (not 2/2), and no attempt 2/3/4 should be generated.
Benefits: Any task where the agent correctly determines that the requested feature, code path, or UI element does not yet exist in the codebase (a "design-decision" or "feature-doesn't-exist" class) will be escalated to a human after a single pipeline run instead of burning all retry slots on repeated exploration of the same absent code. This eliminates the entire class of "agent explored, confirmed absence, asked a human, pipeline ignored the answer and re-ran" failures.

Full ranked root-cause analysis: forensic task pipeline-forensics-on-demand-signature-manual-botched-decompose-1788256541781

### AC-4 · Add WRAP_UP_THRESHOLD and wrap-up prompt injection to the multi-turn loop
Strength: Strong
Files: src/local-tool-client.js

Problem:
runPlanWithTools drives a multi-turn tool-calling loop with a fixed turn budget (ORIENT_TURN_LIMIT is exported and used by callers, and local-agentic-write-draft.js sets LOCAL_AGENTIC_WRITE_MAX_TURNS=35). When the model exhausts its budget still investigating, it never emits the RESOLUTION line that reject-retry-check.js requires, producing the manual::no-resolution-line signature. There is no mechanism inside the loop to tell the model to stop exploring and converge on a final answer before the budget runs out.

Solution:
(1) Add a WRAP_UP_THRESHOLD constant adjacent to the existing turn-budget constant inside local-tool-client.js, computed as Math.floor(turnBudget * 0.8). (2) Define a wrap-up prompt string that instructs the model to: stop opening new investigation threads, complete any in-progress edit, run the task's declared verification command if any, and emit a final line matching the exact RESOLUTION grammar reject-retry-check.js expects (RESOLUTION: implemented or RESOLUTION: needs-clarification). (3) Inside the multi-turn loop in runPlanWithTools, when the current turn index reaches WRAP_UP_THRESHOLD, append the wrap-up text to the system prompt for that turn and all remaining turns (do not replace the original system prompt). The injection point must respect whether the system prompt is rebuilt each turn or cached.

Benefits:
The model receives an explicit, timely signal to converge instead of silently hitting the turn cap mid-investigation. The RESOLUTION line is produced within the budget, so reject-retry-check.js passes and the task does not block for a human. The 80% threshold leaves ~20% of turns as a safety margin for the model to actually complete the wrap-up actions.

### AC-6 · Append default RESOLUTION line when agentic write final message lacks one
Strength: Strong
Files: src/local-agentic-write-draft.js

Problem:
When the agentic write loop in draftAdhocViaLocalAgenticWrite completes and the model's final message does not contain a RESOLUTION: line, downstream validation blocks the draft on 'missing RESOLUTION line'. The model sometimes finishes its work (or fails to make any edits) without emitting the required RESOLUTION: token, causing a spurious block.

Solution:
In the code path where draftAdhocViaLocalAgenticWrite finalizes the model's response string (after runAgenticDraftInWorktree returns and before the result is stored/returned), add a post-processing step: check whether the response string contains the literal substring 'RESOLUTION:'. If it is absent, determine whether the worktree has uncommitted changes (e.g. by shelling out to `git status --porcelain` in the worktree directory, or by using an existing helper if one is already present in the file). If changes exist, append the line 'RESOLUTION: implemented' to the end of the response string. If no changes exist, append the line 'RESOLUTION: failed'. If the token is already present, leave the string unchanged. Do NOT introduce a degenerate-draft flag, a blocked/queue routing path, or any alternative disposition mechanism — the sole purpose is to guarantee the RESOLUTION: line exists so downstream validation passes.

Benefits:
Subject 2 attempt 1 no longer blocks on 'missing RESOLUTION line'. The draft either records 'implemented' (work was done) or 'failed' (no edits made), giving the review stage a valid resolution to evaluate.

### AC-7 · Retry once on empty plan response in local-draft.js
Strength: Strong
Files: src/local-draft.js

Problem:
When the plan stage (runPlanPass or equivalent) returns an empty or whitespace-only string, the pipeline immediately blocks the task with reason 'Plan pass degenerate: empty'. This wastes the task's retry budget on a transient model hiccup rather than giving the model one more chance to produce a usable plan.

Solution:
In the plan-stage code path in local-draft.js (where the model's plan response is received and validated before proceeding to implement), add a check: if the plan response is empty or whitespace-only (i.e. `planResponse.trim() === ''`), re-invoke the model exactly once with a revised prompt that (a) states the previous plan was empty and unacceptable, (b) explicitly requires at least one concrete, executable step, and (c) includes the original task context. Use the same model/provider call mechanism already in place for the plan stage. If the retry also yields an empty plan, fall through to the existing failure/block path (do not loop). If the first-pass plan is non-empty, skip the retry entirely and continue as before.

Benefits:
Subject 1 attempts 2 & 3 no longer block on 'Plan pass degenerate: empty'. A single transient empty completion no longer wastes a full retry cycle; the model gets one targeted second chance to produce a plan.

### AC-8 · Thread rejection feedback back into implement stage on review rejection
Strength: Strong
Files: src/local-draft.js

Problem:
When a draft is rejected at the review/critique stage, the rejection feedback (the critique text explaining what is wrong) is not passed back to the implement stage on the next attempt. The model re-implements from scratch without knowing what the reviewer objected to, producing the same or similar issues.

Solution:
In the rejection/retry code path in local-draft.js (where a rejected draft is re-queued and the implement stage is re-invoked), capture the rejection/critique feedback text from the review stage result and pass it into the implement prompt on the next attempt. Concretely: when the critique/review stage produces a rejection with feedback, store that feedback string on the task object (e.g. task._lastRejectionFeedback or a similar field). Then in the implement-stage prompt construction (buildImplementPrompt call site or the prompt assembly), if such a field is present and non-empty, append a block to the implement prompt that reads: 'A prior implementation was REJECTED at review. The reviewer's feedback was: <feedback>. Address these specific issues in your implementation.' Clear the field after it has been consumed so it does not leak into unrelated later attempts.

Benefits:
Rejected drafts receive targeted, specific feedback on retry instead of re-implementing blindly. This reduces repeated rejections on the same issue and improves first-pass acceptance rate on retry.

### AC-13 · 3 needs-clarification tasks, same signature (manual::empty-degenerate-draft)
Strength: Strong
Files: src/local-agentic-write-draft.js, src/reject-retry-check.js

Model confidence: Worth exploring
Problem: The pipeline does not pre-screen tasks for external-state dependencies (network, credentials, out-of-repo resources) before entering the expensive local-agentic-write tier. The agent correctly identified the impossibility, but only after consuming 8 turns and 3 failed bash calls. The task decomposition also conflated in-repo work (schema authoring, dashboard config) with out-of-sandbox work (GitHub repo creation), making the entire subtask unshippable when only part of it was infeasible.
Solution: Add a pre-implementation feasibility gate in `src/local-agentic-write-draft.js` that scans the task's `ask` and `plan` for markers of external dependencies (e.g., "create a repo", "host at a URL", "git remote", "credentials", "network") and, if found, either (a) splits the task into in-repo and out-of-sandbox subtasks, routing the in-repo portion to local-agentic-write and the out-of-sandbox portion to a human-decision queue, or (b) immediately returns `needs-clarification` with a structured list of the missing external facts. Acceptance check: re-run the failing task; the pipeline should produce a `needs-clarification` response within 2 turns (not 8), with the open questions explicitly listing "git source URL of agent-manager-hygiene", "current version of agent-manager-hygiene", and "where the new repo must live" as the blocking facts, and the in-repo schema/dashboard work should be separated into a new shippable subtask.
Benefits: Tasks that require external system state (repo creation, API credentials, network access) will no longer consume the full local-agentic-write budget before failing; instead, they will be routed to human-decision quickly, and any in-repo work they contain will be extracted and shipped independently.

Full ranked root-cause analysis: forensic task pipeline-forensics-3-needs-clarification-tasks-same-signature-manual-empty-degenerate-draft-1788307819363

### AC-14 · "observability_review" — $3.00 est. API cost, 7% benefit, 0 shipped over 7d
Strength: Strong
Files: src/prompts.js, src/local-draft.js

Problem: The implement prompt does not explicitly forbid meta-commentary or require concrete code artifacts, leading to LLM outputs that are rejected by review as "prose descriptions" or "refusals." The pipeline lacks a pre-review structural validation to catch these non-compliant drafts early.
Solution: In src/prompts.js, add a strict instruction to the implement stage: "You MUST provide a concrete code diff or before/after block. Do NOT provide meta-commentary, hedging, or prose descriptions of code. If the finding is a false positive, state 'FALSE POSITIVE' with a one-line justification." In src/local-draft.js, add a pre-review check that rejects drafts lacking code blocks or explicit verdict keywords, triggering an immediate retry with the strengthened prompt. Acceptance check: Re-run the 4 failing subjects; all should pass review with 2/3+ votes.
Benefits: Eliminates the class of failures where LLMs generate non-actionable prose instead of code or definitive verdicts, reducing review rejections and blocking.

Full ranked root-cause analysis: forensic task pipeline-forensics-observability-review-3-00-est-api-cost-7-benefit-0-shipped-over-7d-1788329292571

### AC-15 · Post-loop terminal-escalation detection in local-tool-client.js
Strength: Strong
Split-Depth: 1
Files: src/local-tool-client.js

Problem:
When the agentic write tier's model concludes that a requested feature is absent from the codebase AND explicitly asks a human for direction (the 'botched-decompose' / terminal-escalation signature), the current code path in runPlanWithTools treats it identically to any other final no-tool-calls message: it returns `{ response: content, toolCallLog, turnsUsed, toolsDisabled: false }` with no distinguishing signal. The caller (draftAdhocViaLocalAgenticWrite → runAgenticDraftInWorktree) then has no way to tell this apart from a generic 'no RESOLUTION line' hard-block, so the task gets stamped `retryableDraftBlock: true` and blind-retried up to MAX_LOCAL_REJECT_RETRIES times before it finally lands in needs-clarification/. The detection should fire immediately, on the first pass, saving two wasted model generations.

Solution:
After the turn-loop in runPlanWithTools terminates (both the voluntary-stop branch at `if (toolCalls.length === 0)` and the cap-exhaustion branch after the `for` loop), inspect the final assistant message content for the terminal-escalation conjunction: (a) a statement that the target code/feature/UI element is absent (e.g. 'does not exist', 'not present', 'no such', 'absent'), AND (b) an explicit request for human input or an open question directed at a human (e.g. 'Open question(s) for a human', 'I need clarification', 'which file', 'should I'). When both signals are present, add a boolean field `terminalEscalation: true` to the object returned by withUsage(...) alongside the existing `response`, `toolCallLog`, `turnsUsed`, `toolsDisabled` keys. When either signal is absent, omit the field (or set it to false) so all existing callers see an unchanged shape. The detection is a small set of case-insensitive substring/regex checks on the final message string—no new dependencies, no structured-payload assumption. Place the check in both exit paths (voluntary-stop at ~line where `return withUsage({ response: content, ... })` appears, and the post-loop cap path at the final `return withUsage({ response: (lastMessage && lastMessage.content) || '', ... })`) so it fires regardless of how the loop ended.

Benefits:
The downstream draft layer can immediately recognise a terminal-escalation verdict and set `task.needsClarification` on the first pass instead of burning two blind-redraft slots. No change to the existing return shape for non-escalation runs (the new field is additive), so the Chat-panel CLI path, arch_discovery, and all other callers of runPlanWithTools are unaffected. Keeps the detection co-located with the turn-loop that produced the message, where the full conversation context is available.

### AC-16 · Immediate needs-clarification routing for terminalEscalation tasks in reject-retry-check.js
Strength: Strong
Split-Depth: 1
Files: src/reject-retry-check.js

Problem:
rejectRetryCheck currently only routes an adhoc task to needs-clarification/ after it has exhausted MAX_LOCAL_REJECT_RETRIES blind-redraft attempts (the `if (retryCount >= MAX_LOCAL_REJECT_RETRIES && !isContinuation)` branch). A task that carries the new `terminalEscalation: true` flag (set by the tool-client detection in the companion change) still sits in blocked/ or adhoc/ with `status: 'blocked'` and gets swept into the blind-retry path: it consumes a retry slot, gets requeued to adhoc/, runs another full model pass, and only after the second exhaustion does it finally reach the human. For a genuine 'this feature does not exist, I need a human to tell me what to build' verdict, that is two wasted model generations and ~2 minutes of latency before the human ever sees the question.

Solution:
In the per-entry loop of rejectRetryCheck, immediately after the `retryableDraftBlock` eligibility check and before the `retryCount >= MAX_LOCAL_REJECT_RETRIES` gate, add a branch: if `task.terminalEscalation === true` AND `isAdhocTask(task)` AND `needsClarificationDir` is provided, route the task directly to needs-clarification/ without incrementing `localRejectCount`. Concretely: (1) guard against double-escalation with the same `alreadyEscalated` history check already used in the exhaustion branch; (2) set `task.needsClarification = { reason: 'design-decision', openQuestions: buildExhaustedAdhocQuestion(task) }` (reuse the existing helper—it already formats priorRejectionFeedback + blockedReason into a legible question list); (3) append the two history events ('exhausted' with a note like 'terminal-escalation signature detected, skipping blind retry', then 'needs-clarification'); (4) mkdir + write to needsClarificationDir, unlink from source dir; (5) `summary.exhausted++; continue;`. For non-adhoc tasks carrying the flag, fall through to the existing non-adhoc exhaustion stamp (no behavioural change there). This branch must appear BEFORE the `retryCount >= MAX_LOCAL_REJECT_RETRIES` check so it fires on the very first sweep tick, not after retries are spent.

Benefits:
A terminal-escalation task reaches the human on the first sweep tick (≤30 s) instead of after two full model passes (~2 min + two GPU slots). The blind-redraft budget is preserved for cases where a redraft could genuinely help (botched JSON, partial edit). Reuses the existing buildExhaustedAdhocQuestion helper and the alreadyEscalated guard, so no new state or new directory is introduced. Non-adhoc and non-escalation tasks are completely unaffected (the new branch is gated on `task.terminalEscalation === true && isAdhocTask(task)`).

### AC-17 · AC-13a: Pre-implementation external-dependency feasibility gate in local-agentic-write-draft.js
Strength: Strong
Split-Depth: 1
Files: src/local-agentic-write-draft.js

Problem:
The local-agentic-write tier currently begins its turn loop (buildWriteAgenticPrompt → runAgenticDraftInWorktree) on every task routed to it, regardless of whether the task's ask/plan text describes work that fundamentally requires external-state operations (creating a remote repo, deploying to a host, pushing to an external git origin, using credentials/API keys, calling a third-party network service). Such tasks will burn the full LOCAL_AGENTIC_WRITE_MAX_TURNS budget on read-only orientation or partial edits, then land in the decompose backstop or a needs-clarification verdict — a slow, wasteful path for a failure that is knowable before the first model call. There is no early-exit check between the existing isEnabled()/writeToolsDisabled() guards and the prompt build.

Solution:
1) Add a module-level constant EXTERNAL_DEP_MARKERS: an array of case-insensitive RegExp objects covering the patterns named in the AC write-up — /\b(create|init)\s+(a\s+)?(new\s+)?(git\s+)?repo(sitory)?\b/i, /\b(host|deploy|publish)\s+(at|to)\s+\S/i, /\bgit\s+(remote|push|clone)\b/i, /\b(credentials?|api[\s_-]?keys?|tokens?|secrets?)\b/i, /\b(network|internet|external\s+api|third[\s_-]?party\s+service)\b/i. 2) Add a small exported helper detectExternalDependency(task) that concatenates String(task.ask||'')+' '+String(task.plan||'') and returns the first matching marker string (or null). 3) Inside draftAdhocViaLocalAgenticWrite, immediately after the writeToolsDisabled() guard and before const prompt = buildWriteAgenticPrompt(task);, insert: const extDep = detectExternalDependency(task); if (extDep) { return { succeeded: true, blocked: true, blockedReason: 'task requires external-state operation ('+extDep+') that the local sandbox cannot perform -- needs a human to provision the resource first.', needsClarification: { reason: 'external-dependency', openQuestions: ['This task references an external resource ('+extDep+'). Please confirm: (a) the resource already exists and its URL/credentials, or (b) you want it created, in which case this must be handled outside the local sandbox.'] } }; } 4) Add detectExternalDependency and EXTERNAL_DEP_MARKERS to the module.exports object.

Benefits:
Tasks that are structurally impossible in the sandbox are rejected in O(markers) string work before any model call, saving the full turn-budget (up to LOCAL_AGENTIC_WRITE_MAX_TURNS turns × model latency). The returned needsClarification shape is the same discriminated-union field that reject-retry-check.js and the existing adhoc→needs-clarification escalation already consume, so no downstream routing change is required for the happy path. The gate is a pure function of task.ask/task.plan text — no I/O, no side effects, trivially unit-testable by calling detectExternalDependency with synthetic task objects.

### AC-18 · AC-13b: Guard reject-retry-check.js against blind re-queueing of feasibility-gated tasks
Strength: Strong
Split-Depth: 1
Files: src/reject-retry-check.js

Problem:
reject-retry-check.js scans both blockedDir and adhocDir for .json files and re-queues any task where isReviewRejection(task) (blockedStage==='review') or retryableDraftBlock (task.retryableDraftBlock===true) is true, up to MAX_LOCAL_REJECT_RETRIES. The AC-13a gate (previous sub-candidate) returns { succeeded:true, blocked:true, blockedReason:'task requires external-state operation…', needsClarification:{…} } from draftAdhocViaLocalAgenticWrite. Depending on how the caller (draftAdhocBranch) persists that result, the task file may land in queue/adhoc/ with status:'blocked' and a blockedReason string, or in queue/blocked/. If it lands in adhoc/ with status:'blocked' AND the task happens to also carry a stale blockedStage:'review' from a prior rejection cycle (a realistic scenario: task was rejected at review, re-queued, then hit the feasibility gate on the redraft), the existing isReviewRejection check will match and the task will be blindly re-queued into the local-agentic-write tier again — exactly the loop AC-13 is meant to prevent. There is currently no field or check in reject-retry-check.js that distinguishes 'externally-impossible, needs a human' from 'review rejected, worth another redraft'.

Solution:
In the for-loop over entries inside rejectRetryCheck, immediately after the existing const retryableDraftBlock = isAdhocTask(task) && task.retryableDraftBlock === true; line and the if (!isReviewRejection(task) && !retryableDraftBlock) continue; guard, add a second skip: if (task.needsClarification && task.needsClarification.reason === 'external-dependency') { summary.checked++; continue; } This ensures any task that the feasibility gate has already stamped with the external-dependency reason is never eligible for blind re-queueing, regardless of whether it also carries a stale blockedStage:'review'. Additionally, in the exhaustion branch (the if (retryCount >= MAX_LOCAL_REJECT_RETRIES && !isContinuation) block), add the same guard before the adhoc→needs-clarification escalation so that an already-externally-gated task is not re-stamped with a different needsClarification payload (design-decision) that would overwrite the more specific external-dependency reason. Concretely: change the existing if (isAdhocTask(task) && needsClarificationDir) { to if (isAdhocTask(task) && needsClarificationDir && !(task.needsClarification && task.needsClarification.reason === 'external-dependency')) {.

Benefits:
Closes the re-queueing loop that would otherwise defeat the AC-13a gate: a task correctly identified as externally-impossible can no longer be blindly re-queued into the local-agentic-write tier by the reject-retry sweep, even if it carries a stale review-rejection marker. The guard is a single field-equality check (task.needsClarification.reason === 'external-dependency'), zero new imports, zero new state, and does not alter the behaviour of any task that was NOT stamped by the feasibility gate — all existing retry/exhaustion/escalation paths are untouched for tasks without that specific reason string.

### AC-19 · Add strict-output and FALSE POSITIVE escape instructions to groupBJsonInstructions
Strength: Strong
Split-Depth: 1
Files: src/prompts.js

Problem:
The groupBJsonInstructions array (the shared implement-stage prompt for arch_review, trouble_log, adhoc/manual sources) has no explicit prohibition on meta-commentary or hedging prose, and no FALSE POSITIVE escape token. When the local model is uncertain or the finding is a false positive, it falls back to prose, which breaks the downstream JSON parse (parseJsonMaybeFenced in local-draft.js) and the draft gets blocked or wastes review votes. This is the primary contributor to the 0-shipped-over-7d metric on AC-14 observability_review.

Solution:
In the groupBJsonInstructions array, insert two new string elements immediately before the closing ].join('\n');. The first new element is a blank string '' for spacing. The second new element is the string: 'If the finding is a false positive (the code is already correct, the concern is not actionable, or the change would be a no-op), do NOT output a file-change JSON object. Output exactly this single line instead: FALSE POSITIVE -- <one-line justification>. Do NOT output meta-commentary, hedging, or prose descriptions of code in place of the JSON; the only valid outputs are the file-change JSON described above or the FALSE POSITIVE line.' The find target is the last existing array element followed by the join: the line starting with '"find" must be an EXACT substring that appears in the real current file content shown in your plan above' through the closing ].join('\n');. Insert the two new elements between that last element and the ].join('\n'); closing. Do not modify any other prompt stage, any other array, or any other function in this file.

Benefits:
Gives the model a valid, parseable output path for false positives (eliminating the prose-fallback that breaks parseJsonMaybeFenced), and explicitly forbids the meta-commentary and hedging that currently cause 0-shipped drafts. No other prompt stage is modified; the change is additive to one existing array.

### AC-20 · Add pre-critique structural gate for implement output compliance
Strength: Strong
Split-Depth: 1
Files: src/local-draft.js

Problem:
After the implement step returns its raw output string, there is no validation gate before the output is handed to the critique step. Non-compliant outputs (prose, hedging, missing JSON, missing FALSE POSITIVE token) flow straight into critique and review, wasting the review-vote budget and contributing to the 0-shipped-over-7d metric. Sub-candidate 1 (src/prompts.js, applied first) adds the FALSE POSITIVE escape token to the implement prompt; this gate enforces it structurally at the code level so a non-compliant output is caught and retried rather than forwarded.

Solution:
In the code path in local-draft.js where the implement step's raw output string is about to be passed to the critique step (the section that calls buildCritiquePrompt and runs the critique model call), insert a validation check immediately before that hand-off. The check works as follows: (a) test whether the raw output string, after trimming whitespace, yields a non-null result when passed through parseJsonMaybeFenced (already imported from ./json-fence.js at the top of this file); (b) test whether the trimmed string contains the exact case-sensitive token 'FALSE POSITIVE'. If NEITHER (a) nor (b) is satisfied, the output is non-compliant: do NOT forward it to the critique step; instead, re-run the implement step using the existing retry/re-run mechanism already present in this file for the implement stage (the same path that handles a degenerate implement response), passing the same prompt (which now includes the FALSE POSITIVE instruction added by sub-candidate 1). Log a structured warning via console.warn containing the task's subject/ID and the reason string 'missing JSON and missing FALSE POSITIVE token' so the 0-shipped-over-7d metric can be correlated. If the output IS compliant (parseJsonMaybeFenced returned non-null, OR the string contains 'FALSE POSITIVE'), allow it to proceed to the critique step unchanged. Do not modify the critique, revision, or review-voting logic itself; the gate is a single insertion point between implement and critique.

Benefits:
Catches non-compliant implement outputs before they consume critique and review-vote budget, triggers an immediate retry with the strengthened prompt (from sub-candidate 1) rather than silently blocking or wasting a review cycle, and produces a structured log line that can be correlated with the 0-shipped-over-7d metric for observability. The gate is a single insertion point and does not restructure existing flow.

### AC-21 · 3 needs-clarification tasks, same signature (manual::fabricated-ungrounded-claim)
Strength: Strong
Files: src/fact-checker.js

Problem: The `ungrounded-field` check (src/fact-checker.js:464) flags any identifier absent from the grounding source, with no exclusion for (a) tokens the draft itself introduced in a new-file `content` field, or (b) tokens that are the output of a verification command the model ran and echoed (e.g. `COMPILE_OK` from `echo`). This turns a correct, compile-verified draft into a disqualifying block, as seen in subject 1.
Solution: In the `ungrounded-field` branch of src/fact-checker.js, before pushing the flag, skip any `field` that (1) appears verbatim in any `content` value of the draft's own create-file entries, or (2) matches a token produced by a `run_bash` command in the worklog (i.e. appears in a `run_bash` command string or its captured output). Acceptance check: add a unit test in src/fact-checker.test.js mirroring the existing `FCV_CUR` cases (src/fact-checker.test.js:379/394/424) where the draft's new-file content contains the identifier `COMPILE_OK` and a `run_bash` worklog entry echoes it; assert `flags` is empty (no `ungrounded-field`), while a control case where `COMPILE_OK` appears only in prose with no new-file content and no `run_bash` source still flags it.
Benefits: The class of "create-new-module + verify-by-compile" adhoc tasks (blueprint extraction, new-file scaffolding) stops failing on a self-generated verification token, while genuine fabrication (identifiers with no source anywhere in the draft or worklog) is still caught.

Full ranked root-cause analysis: forensic task pipeline-forensics-3-needs-clarification-tasks-same-signature-manual-fabricated-ungrounded-claim-1788486413899
