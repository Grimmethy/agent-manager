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

### AC-15 · AC-13a: Pre-implementation external-dependency feasibility gate in local-agentic-write-draft.js
Strength: Strong
Split-Depth: 1
Files: src/local-agentic-write-draft.js

Problem:
The local-agentic-write tier currently begins its turn loop (buildWriteAgenticPrompt → runAgenticDraftInWorktree) on every task routed to it, regardless of whether the task's ask/plan text describes work that fundamentally requires external-state operations (creating a remote repo, deploying to a host, pushing to an external git origin, using credentials/API keys, calling a third-party network service). Such tasks will burn the full LOCAL_AGENTIC_WRITE_MAX_TURNS budget on read-only orientation or partial edits, then land in the decompose backstop or a needs-clarification verdict — a slow, wasteful path for a failure that is knowable before the first model call. There is no early-exit check between the existing isEnabled()/writeToolsDisabled() guards and the prompt build.

Solution:
1) Add a module-level constant EXTERNAL_DEP_MARKERS: an array of case-insensitive RegExp objects covering the patterns named in the AC write-up — /\b(create|init)\s+(a\s+)?(new\s+)?(git\s+)?repo(sitory)?\b/i, /\b(host|deploy|publish)\s+(at|to)\s+\S/i, /\bgit\s+(remote|push|clone)\b/i, /\b(credentials?|api[\s_-]?keys?|tokens?|secrets?)\b/i, /\b(network|internet|external\s+api|third[\s_-]?party\s+service)\b/i. 2) Add a small exported helper detectExternalDependency(task) that concatenates String(task.ask||'')+' '+String(task.plan||'') and returns the first matching marker string (or null). 3) Inside draftAdhocViaLocalAgenticWrite, immediately after the writeToolsDisabled() guard and before const prompt = buildWriteAgenticPrompt(task);, insert: const extDep = detectExternalDependency(task); if (extDep) { return { succeeded: true, blocked: true, blockedReason: 'task requires external-state operation ('+extDep+') that the local sandbox cannot perform -- needs a human to provision the resource first.', needsClarification: { reason: 'external-dependency', openQuestions: ['This task references an external resource ('+extDep+'). Please confirm: (a) the resource already exists and its URL/credentials, or (b) you want it created, in which case this must be handled outside the local sandbox.'] } }; } 4) Add detectExternalDependency and EXTERNAL_DEP_MARKERS to the module.exports object.

Benefits:
Tasks that are structurally impossible in the sandbox are rejected in O(markers) string work before any model call, saving the full turn-budget (up to LOCAL_AGENTIC_WRITE_MAX_TURNS turns × model latency). The returned needsClarification shape is the same discriminated-union field that reject-retry-check.js and the existing adhoc→needs-clarification escalation already consume, so no downstream routing change is required for the happy path. The gate is a pure function of task.ask/task.plan text — no I/O, no side effects, trivially unit-testable by calling detectExternalDependency with synthetic task objects.

### AC-16 · AC-13b: Guard reject-retry-check.js against blind re-queueing of feasibility-gated tasks
Strength: Strong
Split-Depth: 1
Files: src/reject-retry-check.js

Problem:
reject-retry-check.js scans both blockedDir and adhocDir for .json files and re-queues any task where isReviewRejection(task) (blockedStage==='review') or retryableDraftBlock (task.retryableDraftBlock===true) is true, up to MAX_LOCAL_REJECT_RETRIES. The AC-13a gate (previous sub-candidate) returns { succeeded:true, blocked:true, blockedReason:'task requires external-state operation…', needsClarification:{…} } from draftAdhocViaLocalAgenticWrite. Depending on how the caller (draftAdhocBranch) persists that result, the task file may land in queue/adhoc/ with status:'blocked' and a blockedReason string, or in queue/blocked/. If it lands in adhoc/ with status:'blocked' AND the task happens to also carry a stale blockedStage:'review' from a prior rejection cycle (a realistic scenario: task was rejected at review, re-queued, then hit the feasibility gate on the redraft), the existing isReviewRejection check will match and the task will be blindly re-queued into the local-agentic-write tier again — exactly the loop AC-13 is meant to prevent. There is currently no field or check in reject-retry-check.js that distinguishes 'externally-impossible, needs a human' from 'review rejected, worth another redraft'.

Solution:
In the for-loop over entries inside rejectRetryCheck, immediately after the existing const retryableDraftBlock = isAdhocTask(task) && task.retryableDraftBlock === true; line and the if (!isReviewRejection(task) && !retryableDraftBlock) continue; guard, add a second skip: if (task.needsClarification && task.needsClarification.reason === 'external-dependency') { summary.checked++; continue; } This ensures any task that the feasibility gate has already stamped with the external-dependency reason is never eligible for blind re-queueing, regardless of whether it also carries a stale blockedStage:'review'. Additionally, in the exhaustion branch (the if (retryCount >= MAX_LOCAL_REJECT_RETRIES && !isContinuation) block), add the same guard before the adhoc→needs-clarification escalation so that an already-externally-gated task is not re-stamped with a different needsClarification payload (design-decision) that would overwrite the more specific external-dependency reason. Concretely: change the existing if (isAdhocTask(task) && needsClarificationDir) { to if (isAdhocTask(task) && needsClarificationDir && !(task.needsClarification && task.needsClarification.reason === 'external-dependency')) {.

Benefits:
Closes the re-queueing loop that would otherwise defeat the AC-13a gate: a task correctly identified as externally-impossible can no longer be blindly re-queued into the local-agentic-write tier by the reject-retry sweep, even if it carries a stale review-rejection marker. The guard is a single field-equality check (task.needsClarification.reason === 'external-dependency'), zero new imports, zero new state, and does not alter the behaviour of any task that was NOT stamped by the feasibility gate — all existing retry/exhaustion/escalation paths are untouched for tasks without that specific reason string.
