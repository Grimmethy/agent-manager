# Pipeline Fix Candidates

<!--
Confirmed root-cause fixes proposed by pipeline_forensics (src/pipeline-forensics.js).
Each `### AC-NNN` block is appended by applyForensicsReport (src/apply-group-a.js) once a
human confirms the forensic report at queue/awaiting-confirm/. The pipeline_forensics_fix
source (src/task-sources.js) consumes these into a real src/ diff on an agent/ branch for
manual merge. AC numbers are assigned at append time from this doc's current max; do not
renumber existing blocks (in-flight task-id dedup depends on them).
-->

### AC-1 · on-demand signature "manual::botched-decompose"
Strength: Strong
Signature: manual::botched-decompose
Files: src/reject-retry-check.js, src/local-tool-client.js

Problem: When the tier-3 agent in `src/local-agentic-write-draft.js` concludes that the requested feature does not exist in the codebase and explicitly asks for human input, the pipeline's block/retry logic in `src/reject-retry-check.js` records this as a generic "exhausted turn budget" block and consumes a retry slot. The shared turn-loop in `src/local-tool-client.js` enforces the hard ceiling without inspecting whether the agent's final message already contains a terminal escalation signal, so a valid "I need a human" conclusion is indistinguishable from "I ran out of time mid-exploration." The result is 2–3 wasted full pipeline runs (each with 3 tiers × 8–20 turns) before the `exhausted: 2/2 retries used` guard finally fires the needs-clarification escalation.
Solution: In `src/local-tool-client.js`, after the turn loop terminates (whether by budget or by the agent stopping), add a post-loop inspection of the agent's final message for a terminal-escalation pattern (e.g., the message contains both a statement that the target code/feature is absent AND an explicit request for human input or an open question). If detected, return a structured result `{status: "needs-clarification", reason: <agent's stated reason>}` instead of `{status: "blocked", reason: "exhausted turn budget"}`. In `src/reject-retry-check.js`, add a branch: if the incoming block reason is `needs-clarification` (as opposed to a generic `blocked`), skip the retry counter and route directly to the `needs-clarification` state without consuming a retry slot. Acceptance check: re-run the failing task subject 1 through the pipeline; after the first attempt's tier-3 agent emits its "Open question(s) for a human" message, the task state should transition to `needs-clarification` with `retriesUsed: 0/2` (not 2/2), and no attempt 2/3/4 should be generated.
Benefits: Any task where the agent correctly determines that the requested feature, code path, or UI element does not yet exist in the codebase (a "design-decision" or "feature-doesn't-exist" class) will be escalated to a human after a single pipeline run instead of burning all retry slots on repeated exploration of the same absent code. This eliminates the entire class of "agent explored, confirmed absence, asked a human, pipeline ignored the answer and re-ran" failures.

Full ranked root-cause analysis: forensic task pipeline-forensics-on-demand-signature-manual-botched-decompose-1788256541781

### AC-2 · on-demand signature "manual::empty-degenerate-draft"
Strength: Strong
Signature: manual::empty-degenerate-draft
Files: src/local-agentic-write-draft.js, src/local-draft.js

Model confidence: Worth exploring
Problem: The `local-agentic-write` tier does not enforce the `RESOLUTION:` line, causing blocks when the model omits it. The `plan` stage generates empty plans for complex tasks, causing immediate blocks. The review stage rejects non-functional drafts, but the pipeline lacks a robust mechanism to use rejection feedback to guide re-implementation.
Solution: 1. In `src/local-agentic-write-draft.js`, add a post-processing step that checks if the final message contains `RESOLUTION:` and, if not, appends a default `RESOLUTION: implemented` if the worktree has changes, or `RESOLUTION: failed` if not. 2. In `src/local-draft.js`, add a retry mechanism for the `plan` stage that, if the plan is empty, re-prompts the model with a more specific instruction to generate a non-empty plan. 3. In `src/local-draft.js`, when a draft is rejected at review, pass the rejection feedback back to the `implement` stage with a specific instruction to address the feedback and produce functional code. Acceptance check: Subject 2 attempt 1 should not block on "missing RESOLUTION line"; Subject 1 attempts 2 & 3 should not block on "Plan pass degenerate: empty"; Subject 3 should not be rejected 3 times for "ADR only" or "dead code".
Benefits: Tasks that fail due to missing RESOLUTION lines, empty plans, or non-functional drafts will be more likely to succeed, reducing the need for human intervention.

Full ranked root-cause analysis: forensic task pipeline-forensics-on-demand-signature-manual-empty-degenerate-draft-1788292772548

### AC-3 · on-demand signature "manual::no-resolution-line"
Strength: Strong
Signature: manual::no-resolution-line
Files: src/local-tool-client.js, src/local-agentic-write-draft.js

Problem: The multi-turn tool loop in src/local-tool-client.js enforces a hard 20-turn ceiling, and the local-agentic-write tier (src/local-agentic-write-draft.js) inherits that ceiling. When a task's complexity (multi-file investigation + implementation + verification) exceeds what the assigned model can accomplish in 20 turns, the model is still mid-investigation when the budget expires, the final message lacks a RESOLUTION line, and src/reject-retry-check.js blocks the task. Both failing subjects hit this exact wall; both winners avoided it by completing in a single-shot call that never entered the multi-turn loop.
Solution: In src/local-tool-client.js, inject a wrap-up system prompt at ~80% of the turn budget instructing the model to stop investigating and, in its remaining turns, finish any in-progress edit, run the required verification command, and emit a RESOLUTION line. Also route adhoc tasks that self-declare a verification requirement to the single-shot path the winners used rather than the multi-turn qwen tier. Acceptance check: a task that previously ran 20 turns of pure investigation now emits a RESOLUTION line (implemented | needs-clarification) within budget, and is not blocked on "did not end with a RESOLUTION: line".
Benefits: Adhoc tasks that need a verification command stop dead-ending at the 20-turn wall; the "did not end with a RESOLUTION line -> exhausted 2/2 retries -> needs-clarification" failure class is eliminated.

Full ranked root-cause analysis: forensic task pipeline-forensics-on-demand-signature-manual-no-resolution-line-1788259625401

### AC-4 · Add WRAP_UP_THRESHOLD and wrap-up prompt injection to the multi-turn loop
Strength: Strong
Files: src/local-tool-client.js

Problem:
runPlanWithTools drives a multi-turn tool-calling loop with a fixed turn budget (ORIENT_TURN_LIMIT is exported and used by callers, and local-agentic-write-draft.js sets LOCAL_AGENTIC_WRITE_MAX_TURNS=35). When the model exhausts its budget still investigating, it never emits the RESOLUTION line that reject-retry-check.js requires, producing the manual::no-resolution-line signature. There is no mechanism inside the loop to tell the model to stop exploring and converge on a final answer before the budget runs out.

Solution:
(1) Add a WRAP_UP_THRESHOLD constant adjacent to the existing turn-budget constant inside local-tool-client.js, computed as Math.floor(turnBudget * 0.8). (2) Define a wrap-up prompt string that instructs the model to: stop opening new investigation threads, complete any in-progress edit, run the task's declared verification command if any, and emit a final line matching the exact RESOLUTION grammar reject-retry-check.js expects (RESOLUTION: implemented or RESOLUTION: needs-clarification). (3) Inside the multi-turn loop in runPlanWithTools, when the current turn index reaches WRAP_UP_THRESHOLD, append the wrap-up text to the system prompt for that turn and all remaining turns (do not replace the original system prompt). The injection point must respect whether the system prompt is rebuilt each turn or cached.

Benefits:
The model receives an explicit, timely signal to converge instead of silently hitting the turn cap mid-investigation. The RESOLUTION line is produced within the budget, so reject-retry-check.js passes and the task does not block for a human. The 80% threshold leaves ~20% of turns as a safety margin for the model to actually complete the wrap-up actions.

### AC-5 · Add requiresVerification flag and route verification-required adhoc tasks to the single-shot path
Strength: Strong
Files: src/local-agentic-write-draft.js, src/local-tool-client.js

Problem:
Adhoc tasks that carry a declared verification command (e.g. py_compile, a specific test module) currently enter the same multi-turn qwen loop as all other tier-3 tasks. The local model tends to spend most of its budget on read-only orientation (grep, read_file, list_directory) and never reaches the verification step, so the RESOLUTION line is missing and the task fails. The single-shot /api/generate path in local-client.js (a plain prompt-in, text-out call with no tool loop) is better suited for a focused 'make the edit and run the check' task, but there is no routing condition that sends verification-required tasks there, and no guard preventing a retry from re-entering the single-shot path a second time.

Solution:
(1) In local-agentic-write-draft.js, where the task object is constructed before it is passed to runPlanWithTools, add a requiresVerification boolean field (true when the caller has declared a verification command). (2) In local-tool-client.js's dispatch/selection logic (the branch that currently sends the local-agentic-write tier into the multi-turn loop), add a condition: if the task is adhoc AND requiresVerification is true AND the task has not already been retried, route it to the existing single-shot call path (the /api/generate path in local-client.js) instead of entering the multi-turn loop. (3) Guard against double-routing: if the single-shot call also fails to produce a RESOLUTION line and reject-retry-check.js fires a retry, the retry must NOT re-enter the single-shot path a second time—fall through to the multi-turn loop or a clean decline instead.

Benefits:
Verification-required tasks get a focused single-shot attempt where the model can make the edit and run the check in one pass, rather than burning multi-turn budget on investigation. The retry guard prevents an infinite single-shot loop. The multi-turn path remains available for tasks that genuinely need iterative exploration, so no capability is lost.

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

### AC-9 · Add requiresVerification flag to the tier-3 task object
Strength: Strong
Files: src/local-agentic-write-draft.js

Problem:
Tier-3 adhoc tasks that carry a declared verification command (e.g. a py_compile string or a test-module path) are currently indistinguishable from tasks without one. The downstream dispatcher (runPlanWithTools in local-tool-client.js) has no way to know whether a task needs a focused single-shot verification pass before falling into the full multi-turn tool loop. The task object is assembled in local-agentic-write-draft.js just before it is passed to runPlanWithTools, but no boolean field marks verification intent.

Solution:
At the point in local-agentic-write-draft.js where the task object is finalised before the call to runPlanWithTools (the call site visible in the import `const { runPlanWithTools, ORIENT_TURN_LIMIT } = require('./local-tool-client.js')` and the downstream `runAgenticDraftInWorktree` usage), set a new boolean field `requiresVerification` on the task. The value is `true` iff the caller supplied a non-empty verification command (the exact key name for that command is whatever the existing prompt-building code already reads from `task` -- inspect `buildWriteAgenticPrompt` and the surrounding assembly code to find it). If no verification command is present, set `requiresVerification` to `false` explicitly. Do not alter any other field, the function signature, or the return type. If the task object passes through a JSON-serialisation whitelist before reaching local-tool-client.js, add `requiresVerification` to that whitelist.

Benefits:
Downstream code (the routing condition in local-tool-client.js) can use a simple `task.requiresVerification === true` truthiness check without undefined edge-cases. The flag is purely additive -- no existing behaviour changes for tasks that do not carry a verification command. The field survives reject-retry requeues because it is a plain boolean on the task object that draft-attempt-record.js already threads through task.draftAttempts.

### AC-10 · Route verification-required adhoc tasks to the single-shot path with a retry guard
Strength: Strong
Files: src/local-tool-client.js, src/local-agentic-write-draft.js

Problem:
Every tier-3 adhoc task currently enters the full multi-turn tool loop (runPlanWithTools) regardless of whether it carries a verification command. For tasks that only need a focused single-shot generation (e.g. produce a py_compile-clean patch), the multi-turn loop wastes the 35-turn budget on orientation turns before it ever attempts the edit. Additionally, if a single-shot attempt is tried and fails, the reject-retry mechanism re-dispatches the same task object back into the dispatcher, which would re-enter the single-shot path indefinitely (no marker distinguishes 'already tried single-shot' from 'first attempt').

Solution:
In the dispatch path that local-agentic-write-draft.js uses to invoke runPlanWithTools (the call site in local-agentic-write-draft.js, or the entry of runPlanWithTools in local-tool-client.js -- whichever is the natural guard point), insert a conditional BEFORE the multi-turn loop begins. The condition has three conjuncts: (a) the task is adhoc (use the existing discriminator -- `isLeafTask` or the tier/kind field already on the task; confirm by reading the assembly code in local-agentic-write-draft.js); (b) `task.requiresVerification === true`; (c) `task.singleShotAttempted !== true`. If all three hold, set `task.singleShotAttempted = true`, then invoke the existing single-shot /api/generate path (the function in local-client.js that local-tool-client.js already imports KEEP_ALIVE from -- find the actual generate call or add a thin wrapper that calls Ollama's /api/generate with the task's prompt text plus the verification command as a focused instruction). Parse the returned text for a RESOLUTION line (reuse whatever RESOLUTION-parsing helper already exists in the codebase; if none, check for the literal string 'RESOLUTION:'). If a RESOLUTION line is present, return the result as a resolved task. If absent, do NOT throw -- fall through to the existing failure/retry path so reject-retry-check.js requeues the task normally. Because `singleShotAttempted` is now `true`, the requeued task will skip the single-shot branch and enter the multi-turn loop as it does today. If any conjunct is false, proceed into the multi-turn loop with zero behavioural change.

Benefits:
Verification-required adhoc tasks get a fast, focused single-shot attempt before burning the 35-turn multi-turn budget. The singleShotAttempted marker guarantees at most one single-shot try per task lifetime, preventing infinite single-shot loops on retry. Non-verification and non-adhoc tasks are completely unaffected (all three conjuncts must hold). The change is purely additive to the dispatch path -- no existing multi-turn behaviour is altered for any task that does not carry requiresVerification.
