# Capability-ceiling pattern (2026-09-16)

## Shared failure shape

Two separately-investigated structured-analysis formats on the local-model tier fail the same way. Each asks a small local model to produce a multi-part output in one pass: a ranked or justified list, plus a cross-reference back to specific evidence.

1. **pipeline_debrief SO WHAT citation.** The SO WHAT section must cite a real evidence item (a `COMPLETED N` block, a real task id, or a unique slug fragment). The model often writes a generic aggregate claim with no citation. Gate: `src/pipeline-debrief-so-what-check.js` (`runSoWhatCitationCheck`, `citesEvidence`).
2. **pipeline_forensics ranked root cause with contrast set.** The report must rank root causes and justify each against a contrast set of succeeding tasks. Contract: `src/pipeline-forensics.js` header (contrast-set line, verify exact line in the file).

Both investigations concluded these are local-model capability ceilings, not gating or wiring defects. The gates correctly reject malformed output. Nothing was filed as a bug.

## Options for a human decision

**Option (a): simplify the output format.** Drop the citation-back-to-evidence requirement from the model's output, and attach citations with a deterministic pass. This is partly built: `citationTokensFor` and `attachSoWhatCitation` in `src/pipeline-debrief-so-what-check.js` are pure helpers that return the real closed set of tokens and append an `Evidence:` line. They are not wired into `postImplementCheck`, so no verdict changes. Wiring them in, and whether to attach or still reject, is a human decision. The forensics contract (`src/pipeline-forensics.js`) would need a separate decision and is not changed here. Routing and prompt changes are out of scope for this pass (verify `src/prompts.js` for the drafting prompt text).

**Option (b): escalate these two source types to a reasoning-tier model.** Both run periodically or on demand, not per-task at high volume, so the cost may be justified. Choosing the model tier and the routing site (verify in `src/local-draft.js` and `src/task-sources.js`) is a model-selection decision, not a code-level fix.

## Status

- Helpers added and exported, unwired: `src/pipeline-debrief-so-what-check.js`.
- Test: `test/pipeline-debrief-so-what-citation.test.js` (node:test).
- No change to the `postImplementCheck` verdict path or to `src/pipeline-forensics.js`.

## Recommendation

Decide between (a) and (b) before further one-off gate tightening. Option (a) is cheaper and already partly built. Option (b) is simpler but costs more per run. Either choice needs a human owner.

**Next step:** a human chooses (a), (b), or a mix, and the chosen option is scoped as its own task.
