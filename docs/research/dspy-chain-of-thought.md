# DSPy Chain of Thought: the real implementation is a 4-line schema change, not a prompting strategy

> Piece 2 follow-up (see `bits-ai-dual-surface-findings-2026-09-27.md` in this directory for the series context).
> Verified source: https://github.com/stanfordnlp/dspy/blob/f70d08a5b934400d236078143e3704934f2d5dd1/dspy/predict/chain_of_thought.py
> (pinned to commit f70d08a5b934, checked 2026-09-07T18:10:00.000Z)

## The real mechanism, verbatim

`ChainOfThought.__init__` does exactly this and nothing more:

```python
extended_signature = signature.prepend(name="reasoning", field=rationale_field, type_=rationale_field_type)
self.predict = dspy.Predict(extended_signature, **config)
```

`rationale_field`'s description defaults to the literal string `"${reasoning}"` — a placeholder, not real instructional prose telling the model HOW to reason. There is no "think step by step" text anywhere in this file. The ENTIRE chain-of-thought effect comes from: one extra output field named `reasoning`, PREPENDED so it is produced before the real answer field(s), inside ONE generation call. A modern instruction-tuned model, required to fill a field literally called `reasoning` before it is allowed to commit to `answer`, just does the reasoning — DSPy is not engineering that behavior with clever prompt text, it is exploiting an emergent property of instruction-following models via schema ordering alone.

## Direct comparison: agent-manager's plan-then-implement split

Agent-manager's `runPlanPass` → `runImplementPass` split (`src/local-draft.js`, both defined in that file) reaches for a similar goal ("reason before committing to the real answer") via a much heavier architecture: two separate model calls, hundreds of lines of prompt-building logic (`src/prompts.js`), seed-plan carryover across retries (`bestPriorPlan`, `src/local-draft.js:479`), grounding, and a dedicated critique/revision pass (`runPlanCritique`, `src/plan-critique.js`). DSPy gets a comparable effect from a four-line schema change.

## Why agent-manager did not (and probably should not) converge on DSPy's simpler shape

Three concrete, structural reasons:

1. **Lock-hold duration.** A single expanded-schema call holds the GPU single-flight lock (`src/single-flight-lock.js`) for the ENTIRE duration of both the reasoning and the real work. Agent-manager's implement pass can run many agentic turns over several minutes (`draftAdhocBranch` → `src/local-agentic-write-draft.js` with real `edit_file`/`run_bash` tool calls). `src/single-flight-lock.js`'s own header (2026-08-22 fix) documents that the lock is deliberately scoped to the specific local-model call only, released between plan and implement specifically to avoid starving other lanes. Folding both into one DSPy-style call would undo that fix.

2. **No seam for critique.** DSPy's reasoning field flows straight into the SAME generation stream as the answer — there is no natural point to inject a SEPARATE critique/revision pass between them, because there is no gap; it is one continuous completion. Agent-manager's `runPlanCritique` (`src/plan-critique.js`) exists precisely in the gap BETWEEN two separate calls. A single-call design has nowhere to put an equivalent check.

3. **No independent retry.** If the real output is bad, DSPy has to regenerate reasoning AND answer together in the next attempt — no way to keep a good `reasoning` and only retry the answer. Agent-manager's `bestPriorPlan` (`src/local-draft.js:479`, surfaced to prompts via `src/prompts.js`'s `seedPlanBlock`) explicitly reuses a good PRIOR plan across retries when only the implement step failed — exactly the kind of partial-retry DSPy's single-call shape cannot express.

## Conclusion

Consistent with the finding in `bits-ai-dual-surface-findings-2026-09-27.md`: DSPy's CoT is cheap and radically simple because it solves a narrower problem (one clean stateless call, no crash recovery to design for, no human gate to leave room for). Agent-manager's heavier two-call architecture is not a failure to discover DSPy's trick — it is the correct shape for a DIFFERENT set of constraints (durable, resumable, human-gated, GPU-lock-scoped) that DSPy's typical use case never has to solve.

Worth remembering as a general lens for the rest of this DSPy pass: when a DSPy mechanism looks surprisingly simple, check whether it is simple because it ignores a constraint agent-manager cannot ignore, before assuming it is something to adopt.

## Noted for a later pass (not explored yet)

The same `dspy/predict/` source directory also has `best_of_n.py`, `refine.py`, `retry.py`, and `code_act.py` — none of these were mentioned on the Modules docs page at all. `best_of_n`/`refine`/`retry` in particular sound directly relevant to agent-manager's own retry-vs-block and critique-and-revision logic and are worth a dedicated look in a future piece.
