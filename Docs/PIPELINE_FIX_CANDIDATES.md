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

### AC-15 · Add strict-output and FALSE POSITIVE escape instructions to groupBJsonInstructions
Strength: Strong
Split-Depth: 1
Files: src/prompts.js

Problem:
The groupBJsonInstructions array (the shared implement-stage prompt for arch_review, trouble_log, adhoc/manual sources) has no explicit prohibition on meta-commentary or hedging prose, and no FALSE POSITIVE escape token. When the local model is uncertain or the finding is a false positive, it falls back to prose, which breaks the downstream JSON parse (parseJsonMaybeFenced in local-draft.js) and the draft gets blocked or wastes review votes. This is the primary contributor to the 0-shipped-over-7d metric on AC-14 observability_review.

Solution:
In the groupBJsonInstructions array, insert two new string elements immediately before the closing ].join('\n');. The first new element is a blank string '' for spacing. The second new element is the string: 'If the finding is a false positive (the code is already correct, the concern is not actionable, or the change would be a no-op), do NOT output a file-change JSON object. Output exactly this single line instead: FALSE POSITIVE -- <one-line justification>. Do NOT output meta-commentary, hedging, or prose descriptions of code in place of the JSON; the only valid outputs are the file-change JSON described above or the FALSE POSITIVE line.' The find target is the last existing array element followed by the join: the line starting with '"find" must be an EXACT substring that appears in the real current file content shown in your plan above' through the closing ].join('\n');. Insert the two new elements between that last element and the ].join('\n'); closing. Do not modify any other prompt stage, any other array, or any other function in this file.

Benefits:
Gives the model a valid, parseable output path for false positives (eliminating the prose-fallback that breaks parseJsonMaybeFenced), and explicitly forbids the meta-commentary and hedging that currently cause 0-shipped drafts. No other prompt stage is modified; the change is additive to one existing array.

### AC-16 · Add pre-critique structural gate for implement output compliance
Strength: Strong
Split-Depth: 1
Files: src/local-draft.js

Problem:
After the implement step returns its raw output string, there is no validation gate before the output is handed to the critique step. Non-compliant outputs (prose, hedging, missing JSON, missing FALSE POSITIVE token) flow straight into critique and review, wasting the review-vote budget and contributing to the 0-shipped-over-7d metric. Sub-candidate 1 (src/prompts.js, applied first) adds the FALSE POSITIVE escape token to the implement prompt; this gate enforces it structurally at the code level so a non-compliant output is caught and retried rather than forwarded.

Solution:
In the code path in local-draft.js where the implement step's raw output string is about to be passed to the critique step (the section that calls buildCritiquePrompt and runs the critique model call), insert a validation check immediately before that hand-off. The check works as follows: (a) test whether the raw output string, after trimming whitespace, yields a non-null result when passed through parseJsonMaybeFenced (already imported from ./json-fence.js at the top of this file); (b) test whether the trimmed string contains the exact case-sensitive token 'FALSE POSITIVE'. If NEITHER (a) nor (b) is satisfied, the output is non-compliant: do NOT forward it to the critique step; instead, re-run the implement step using the existing retry/re-run mechanism already present in this file for the implement stage (the same path that handles a degenerate implement response), passing the same prompt (which now includes the FALSE POSITIVE instruction added by sub-candidate 1). Log a structured warning via console.warn containing the task's subject/ID and the reason string 'missing JSON and missing FALSE POSITIVE token' so the 0-shipped-over-7d metric can be correlated. If the output IS compliant (parseJsonMaybeFenced returned non-null, OR the string contains 'FALSE POSITIVE'), allow it to proceed to the critique step unchanged. Do not modify the critique, revision, or review-voting logic itself; the gate is a single insertion point between implement and critique.

Benefits:
Catches non-compliant implement outputs before they consume critique and review-vote budget, triggers an immediate retry with the strengthened prompt (from sub-candidate 1) rather than silently blocking or wasting a review cycle, and produces a structured log line that can be correlated with the 0-shipped-over-7d metric for observability. The gate is a single insertion point and does not restructure existing flow.
