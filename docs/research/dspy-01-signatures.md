# DSPy signatures — research document (HUB0102 · 1/2)

Date of this pass: 2026-10-01. Method: every DSPy-side claim was checked against files fetched from GitHub at the pinned commit (HTTP 200 for each, listed in the provenance block) and against the signatures docs page at the same commit; every in-repo citation was re-checked against `master` on the same date.
Scope: DSPy's declarative signature module (typed input→output field specs), its parse-failure handling (typed parse errors + optional-field fallback), and the single-call vs two-call chain-of-thought call topology — each contrasted against the equivalent hand-built mechanisms in agent-manager.

## Provenance block (pinned-commit URLs)

Pinned commit: `f70d08a5b934400d236078143e3704934f2d5dd1` (https://github.com/stanfordnlp/dspy/commit/f70d08a5b934). Raw base: `https://raw.githubusercontent.com/stanfordnlp/dspy/f70d08a5b934400d236078143e3704934f2d5dd1/`. Each row below was fetched on 2026-10-01 and read; the status is the HTTP status actually returned.

| Path at the pinned commit | HTTP | Used for |
|---|---|---|
| `dspy/signatures/signature.py` | 200 | Signature as a data object: `input_fields` / `output_fields` / `fields`, `with_instructions`, `prepend`, `append`, `dump_state` / `load_state` (Section 1) |
| `docs/docs/learn/programming/signatures.md` | 200 | The two "don't hand-tune keywords" tips at lines 33 and 128 (Section 2) |
| `dspy/utils/exceptions.py` | 200 | `AdapterParseError` at line 246 (Section 3) |
| `dspy/adapters/utils.py` | 200 | `apply_output_field_defaults`, optional-field fallback at lines 44-45 (Section 3) |
| `dspy/predict/chain_of_thought.py` | 200 | `ChainOfThought` is one call (Section 4) |
| `dspy/adapters/two_step_adapter.py` | 200 | `TwoStepAdapter`, the real two-call mechanism (Section 4) |
| `dspy/signatures.py` | **404** | Does not exist at this commit; the module is the package `dspy/signatures/` (an earlier draft of this document cited this path without fetching it) |

Live site: https://dspy.ai and https://dspy.ai/learn/programming/signatures/ both returned **HTTP 200** on 2026-10-01. (An earlier draft said the site was 404; that was wrong.) Claims below are grounded in the pinned source, not the live site, so a later docs revision does not change them.

## 1. Declarative I/O Specification

A DSPy signature is a declarative mapping of **named input fields to named output fields**, e.g. `Question -> Answer`, with each field declared through `dspy.InputField` / `dspy.OutputField` and typed with an ordinary Python annotation (`str`, `int`, `list[str]`, a Pydantic model, ...), and carrying an optional per-field description that becomes part of the prompt the adapter renders. A signature can be written inline (`"question -> answer"`) or as a class, and the docs page lists examples such as `"question, choices: list[str] -> reasoning: str, selection: int"`. The signature is a *data object*: it can be stored, passed as a constructor argument (`dspy.Predict(signature)`), inspected programmatically (`input_fields`, `output_fields`, `fields`, all in `dspy/signatures/signature.py`), edited into new signatures (`with_instructions`, `prepend`, `append`), serialised (`dump_state` / `load_state`), and later compiled by an optimizer against a labeled corpus — none of which requires touching a string.

Contrast with agent-manager today: the equivalent "contract" is scattered plain-text directives and prose conventions inside prompt strings (see the `brainDumpDirective` / `decomposeMoveDirective` interpolations in `src/prompts.js:286` and `src/prompts.js:302`) plus output-shape expectations that only exist as comments and as the downstream heuristics that detect when the model broke them (Section 3). There is no single inspectable object that says "this call takes X and must return Y." That single-object shape is the whole bet DSPy signatures make: the I/O contract is *data*, not prose. (Grounded in `dspy/signatures/signature.py` at the pinned commit.)

## 2. Anti-Hand-Tuning Rationale

The in-repo record already states the principle this document applies. From `src/review-task.js:166` (verbatim comment, 2026-09-08, "Second Brain [[dspy-deterministic-prompt-tuning]] research applied"):

> "DSPy's optimizer family compiles a signature against a real, labeled corpus of outcomes rather than trusting a hand-tuned heuristic's own self-assessment."

DSPy's own documentation says the same thing twice. `docs/docs/learn/programming/signatures.md` line 33: "start simple and don't prematurely optimize keywords! Leave that kind of hacking to the DSPy compiler." and line 128: "don't prematurely tune the keywords of your signature by hand. The DSPy optimizers will likely do a better job (and will transfer better across LMs)." That comment was written precisely because the same file's `NON_IMPL_PATTERNS` gate (`src/review-task.js:281`, applied at `src/review-task.js:1082`) is a hand-tuned regex list whose false-positive rate was only discovered by "manually grepping every historical hard-block and hand-auditing each one -- there was no standing record of this gate's own real true/false-positive rate at all." The same rationale extends to the prompt-string directives this task's sibling research targets: `brainDumpDirective` (`src/prompts.js:286`) and `decomposeMoveDirective` (`src/prompts.js:302`) are hand-authored prose injected by branching JavaScript — their behavior can only be evaluated by reading what they produce, not by inspecting them. A declarative signature plus a compiled, corpus-grounded prompt is the structural answer: the "heuristic" is a typed object with measured behavior, not an unmeasured string.

## 3. Parse-Failure Handling: Heuristics vs. Structured Errors

**agent-manager (this repo) — regex/length heuristics.** `detectDegenerate` at `src/local-client.js:174` — signature `function detectDegenerate(text, { allowEmpty = false, doneReason, isDraft = false } = {})` — is a four-stage ordered heuristic:

1. `doneReason === 'length'` → `'truncated'` (unconditional, even ahead of `allowEmpty`; 2026-09-05 root-cause comment re: the blocked `pipeline_forensics_fix`-style AC-4/6/8/20 cluster where Ollama cut generation at `num_predict` and the truncation was silently accepted).
2. `isDraft && isDraftTruncated(text)` → `'truncated'` (the AC-70 gate from 2026-09-25, delegating to `src/draft-truncation-guard.js`: unclosed markdown table row, missing IMPLEMENT body, odd code-fence count — deliberately gated because the same shapes can be *legitimate* final lines on non-draft review/analysis calls).
3. `!text || text.trim().length === 0` → `allowEmpty ? null : 'empty'`.
4. The two-char `'""'` / `"''"` quirk (mirroring `review-task.js`'s `isEffectivelyEmpty`), handled identically to a genuinely empty response.

Every stage is a text-shape guess about what the model meant, added one incident at a time — the comment history at `src/local-client.js:174` is a changelog of that.

**DSPy (pinned commit) — typed errors + per-field presence.** When the model's raw output cannot be parsed into the declared output fields, the adapter raises an `AdapterParseError` (`dspy/utils/exceptions.py:246`, carrying the adapter name, the signature, the raw LM response and any partial parse): a *typed exception* the caller can catch, retry, or fall back on — the failure is about the declared contract, not about text that "looks" degenerate. Complementary to that, **optional-field fallback** (`apply_output_field_defaults`, `dspy/adapters/utils.py:44-45`) means an output field that declares a default, a default factory, or an annotation allowing `None` takes that fallback when it is missing from the parsed response, while the rest of the structured output still lands — partial structured success instead of an all-or-nothing string verdict.

Synthesis: DSPy turns "did the model emit garbage?" from a regex/length heuristic into a typed exception plus a per-field presence check against a declared schema.

## 4. Single-Call vs. Two-Call Structured Output

Two different DSPy mechanisms are easy to conflate here, and an earlier draft of this document conflated them.

- **`dspy.Predict`: one call, answer fields only.** One model invocation produces all declared output fields.
- **`dspy.ChainOfThought`: still ONE call.** `dspy/predict/chain_of_thought.py` builds `extended_signature = signature.prepend(name="reasoning", field=rationale_field, ...)` (default field description `${reasoning}`) and runs a single `dspy.Predict` on it (lines 45-49). The reasoning becomes a *named output field* that the same call emits before the answer fields. The cost is more output tokens, not an extra round trip, and the trace is a typed field that can be logged, validated or dropped rather than living inside an unstructured string.
- **`TwoStepAdapter`: the real two-call mechanism** (`dspy/adapters/two_step_adapter.py`). The main LM answers a simpler, more natural prompt with no structure imposed; then a second, usually smaller, extraction LM driven by a chat adapter turns that response into the declared fields (its docstring: "particularly useful when interacting with reasoning models as the main LM since reasoning models are known to struggle with structured outputs"). A parse failure in the second step surfaces as `AdapterParseError` with `adapter_name="TwoStepAdapter"`. The file's own header notes a limitation: the second-step signature is built on the fly with no demonstrations, so it cannot be optimized.

The trade-off against agent-manager: this repo's `think:true` / reasoning-budget incidents (the `num_predict` truncation class behind `detectDegenerate`'s stage 1 at `src/local-client.js:174`) are what happens when "reason before answering" is a hidden model setting that shares one output budget with the answer. DSPy offers two explicit alternatives: declare the reasoning as a field in the same call (`ChainOfThought`, one budget, one failure point), or separate the reasoning model from the formatting model (`TwoStepAdapter`, two budgets, two failure points, each retryable on its own).

## 5. Open Questions

1. **Migration order:** beyond `brainDumpDirective` (`src/prompts.js:286`), `decomposeMoveDirective` (`src/prompts.js:302`), and `NON_IMPL_PATTERNS` (`src/review-task.js:281`), which other in-repo prompt strings or output-shape expectations are signature candidates — and in what order should they migrate (highest false-positive rate first, or lowest blast radius first)?
2. **`detectDegenerate`'s fate:** if `AdapterParseError` + optional-field fallback cover the "did the model emit garbage?" cases, is stage 1 (`doneReason === 'length'`) redundant — or does the AC-70 draft-truncation gate (stage 2) survive because a *truncated but parseable* draft is a failure mode a declared schema cannot express at all?
3. **Which of the two shapes fits the existing state machine?** The `doneReason` / `isDraft` / `allowEmpty` parameters threaded through `src/local-client.js` assume one opaque call per stage. `ChainOfThought` keeps that shape (one call, but the `reasoning` text now counts against the same `num_predict` budget as the answer, so a `doneReason === 'length'` truncation can land inside the reasoning and hide a perfectly good answer-in-waiting). `TwoStepAdapter` would give each stage its own call and its own `detectDegenerate` verdict, at the price of the second step being un-optimizable per the file header. Which failure is cheaper for this pipeline?
4. **`NON_IMPL_PATTERNS` migration path:** constrained `dspy.Predict` output (declare the fields, let the adapter enforce presence) vs. keeping it as a post-hoc validator over a signature's output — which preserves the existing NDJSON audit trail at `src/review-task.js:1082`?
5. **Optimizer grounding:** the rationale in Section 2 depends on compiling against a "real, labeled corpus of outcomes." What is the labeled corpus in this repo — the hard-failure NDJSON stream — and does it actually carry the labels (true positive vs false positive of each gate) needed, or is that a separate data-collection task first?
6. **Pin durability:** every DSPy-side claim cites the full commit `f70d08a5b934400d236078143e3704934f2d5dd1`, which resolved on 2026-10-01. DSPy's layout has moved before (`dspy/signatures.py` became the package `dspy/signatures/`), so when this document is revisited, re-fetch the six files in the provenance table rather than trusting the line numbers.

## Cross-reference

See HUB0102 · 2/2 for the `concepts.json` entry that registers this research document.

## URL / status log

| URL | Status | Date | Finding |
|---|---|---|---|
| https://github.com/stanfordnlp/dspy/commit/f70d08a5b934 | pinned commit | 2026-10-01 | grounding commit for all DSPy-side claims |
| raw.githubusercontent.com/stanfordnlp/dspy/f70d08a5b934400d236078143e3704934f2d5dd1/ + the six paths in the provenance table | 200 each | 2026-10-01 | fetched and read |
| .../dspy/signatures.py (same raw base) | 404 | 2026-10-01 | path does not exist at the pinned commit |
| https://dspy.ai | 200 | 2026-10-01 | live docs reachable |
| https://dspy.ai/learn/programming/signatures/ | 200 | 2026-10-01 | live copy of the signatures page |
