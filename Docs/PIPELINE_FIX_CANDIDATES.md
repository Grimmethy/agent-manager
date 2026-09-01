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
Files: src/reject-retry-check.js, src/local-tool-client.js

Problem: When the tier-3 agent in `src/local-agentic-write-draft.js` concludes that the requested feature does not exist in the codebase and explicitly asks for human input, the pipeline's block/retry logic in `src/reject-retry-check.js` records this as a generic "exhausted turn budget" block and consumes a retry slot. The shared turn-loop in `src/local-tool-client.js` enforces the hard ceiling without inspecting whether the agent's final message already contains a terminal escalation signal, so a valid "I need a human" conclusion is indistinguishable from "I ran out of time mid-exploration." The result is 2–3 wasted full pipeline runs (each with 3 tiers × 8–20 turns) before the `exhausted: 2/2 retries used` guard finally fires the needs-clarification escalation.
Solution: In `src/local-tool-client.js`, after the turn loop terminates (whether by budget or by the agent stopping), add a post-loop inspection of the agent's final message for a terminal-escalation pattern (e.g., the message contains both a statement that the target code/feature is absent AND an explicit request for human input or an open question). If detected, return a structured result `{status: "needs-clarification", reason: <agent's stated reason>}` instead of `{status: "blocked", reason: "exhausted turn budget"}`. In `src/reject-retry-check.js`, add a branch: if the incoming block reason is `needs-clarification` (as opposed to a generic `blocked`), skip the retry counter and route directly to the `needs-clarification` state without consuming a retry slot. Acceptance check: re-run the failing task subject 1 through the pipeline; after the first attempt's tier-3 agent emits its "Open question(s) for a human" message, the task state should transition to `needs-clarification` with `retriesUsed: 0/2` (not 2/2), and no attempt 2/3/4 should be generated.
Benefits: Any task where the agent correctly determines that the requested feature, code path, or UI element does not yet exist in the codebase (a "design-decision" or "feature-doesn't-exist" class) will be escalated to a human after a single pipeline run instead of burning all retry slots on repeated exploration of the same absent code. This eliminates the entire class of "agent explored, confirmed absence, asked a human, pipeline ignored the answer and re-ran" failures.

Full ranked root-cause analysis: forensic task pipeline-forensics-on-demand-signature-manual-botched-decompose-1788256541781

### AC-2 · on-demand signature "manual::empty-degenerate-draft"
Strength: Strong
Files: src/local-agentic-write-draft.js, src/local-draft.js

Model confidence: Worth exploring
Problem: The `local-agentic-write` tier does not enforce the `RESOLUTION:` line, causing blocks when the model omits it. The `plan` stage generates empty plans for complex tasks, causing immediate blocks. The review stage rejects non-functional drafts, but the pipeline lacks a robust mechanism to use rejection feedback to guide re-implementation.
Solution: 1. In `src/local-agentic-write-draft.js`, add a post-processing step that checks if the final message contains `RESOLUTION:` and, if not, appends a default `RESOLUTION: implemented` if the worktree has changes, or `RESOLUTION: failed` if not. 2. In `src/local-draft.js`, add a retry mechanism for the `plan` stage that, if the plan is empty, re-prompts the model with a more specific instruction to generate a non-empty plan. 3. In `src/local-draft.js`, when a draft is rejected at review, pass the rejection feedback back to the `implement` stage with a specific instruction to address the feedback and produce functional code. Acceptance check: Subject 2 attempt 1 should not block on "missing RESOLUTION line"; Subject 1 attempts 2 & 3 should not block on "Plan pass degenerate: empty"; Subject 3 should not be rejected 3 times for "ADR only" or "dead code".
Benefits: Tasks that fail due to missing RESOLUTION lines, empty plans, or non-functional drafts will be more likely to succeed, reducing the need for human intervention.

Full ranked root-cause analysis: forensic task pipeline-forensics-on-demand-signature-manual-empty-degenerate-draft-1788292772548

### AC-3 · on-demand signature "manual::no-resolution-line"
Strength: Strong
Files: src/local-tool-client.js, src/local-agentic-write-draft.js

Problem: The multi-turn tool loop in src/local-tool-client.js enforces a hard 20-turn ceiling, and the local-agentic-write tier (src/local-agentic-write-draft.js) inherits that ceiling. When a task's complexity (multi-file investigation + implementation + verification) exceeds what the assigned model can accomplish in 20 turns, the model is still mid-investigation when the budget expires, the final message lacks a RESOLUTION line, and src/reject-retry-check.js blocks the task. Both failing subjects hit this exact wall; both winners avoided it by completing in a single-shot call that never entered the multi-turn loop.
Solution: In src/local-tool-client.js, inject a wrap-up system prompt at ~80% of the turn budget instructing the model to stop investigating and, in its remaining turns, finish any in-progress edit, run the required verification command, and emit a RESOLUTION line. Also route adhoc tasks that self-declare a verification requirement to the single-shot path the winners used rather than the multi-turn qwen tier. Acceptance check: a task that previously ran 20 turns of pure investigation now emits a RESOLUTION line (implemented | needs-clarification) within budget, and is not blocked on "did not end with a RESOLUTION: line".
Benefits: Adhoc tasks that need a verification command stop dead-ending at the 20-turn wall; the "did not end with a RESOLUTION line -> exhausted 2/2 retries -> needs-clarification" failure class is eliminated.

Full ranked root-cause analysis: forensic task pipeline-forensics-on-demand-signature-manual-no-resolution-line-1788259625401
