# Design Note: Task Atomization Plugin

**Status:** proposed (2026-10-18, Grimmethy + Claude). Nothing built.
**Builds on:** [capability-routing-and-benchmarking.md](capability-routing-and-benchmarking.md) (ledger, scorecard, probing, escalation, probe debrief).
**Related:** [ADR-0022](../adr/0022-core-is-a-platform-plugins-define-the-work.md), [PLUGIN_API.md](../PLUGIN_API.md), [repo-extraction-playbook.md](../agents/repo-extraction-playbook.md).

## Why

The capability system *finds out* which task classes fit which model and, through the probe debrief, *says why* one does not. Nothing yet *does the work of
making a task fit*. That work (splitting a task into stages or pieces, trimming its context, replacing a model call with a deterministic check, then proving
the smaller version holds up) is its own discipline with its own tooling, and it is "defining the work", which ADR-0022 assigns to plugins, not core.

**Goal.** Every hygiene task type eventually runs on the smallest lane that can do it well, with the larger lanes left for work that needs them. Starting point:
the 8B on the RX 580 does `brain_dump_sort` at 93% success / 85 s median. The hygiene plugin (`agent-manager-hygiene`, loaded via
`AGENT_MANAGER_REGISTER_PATH`) is the target set: 16 sources.

## Where the hygiene set stands today (measured, last 14 days, model_calls)

Per-call averages on the 27B/P40; "out" is generated tokens. At the 8B's measured 25 tok/s generation and ~180 tok/s prompt processing, a call costs roughly
`prompt/180 + out/25` seconds, against a 300 s ceiling and a 16,384-token context (prompt + output must fit).

| source (stage: avg prompt / max prompt / avg out) | class | read |
|---|---|---|
| `performance_review` (plan 1.0k/1.2k/1.4k, implement 1.5k/2.0k/0.3k) | review | already small; plan output is the cost |
| `observability_review` (plan 1.3k/1.6k/1.2k, implement 2.0k/2.3k/0.6k), `_digest` | review | already small |
| `function_length_review` (plan 3.4k/5.2k/2.7k, implement 2.0k/4.3k/1.1k) | review | small prompt, long plan output |
| `unused_export` / `deadcode_fix` | review / fix | not in the window's top rows; profile before assuming |
| `change_review` (plan 5.0k/7.0k/3.2k, implement 7.6k/**14.5k**/2.5k) | review | max prompt + output exceeds 16K ctx; the known timeout case |
| `arch_review` (implement 6.6k/**11.4k**/2.9k), `arch_import_review` | review | borderline at the top end |
| `arch_discovery` (plan 7.1k/7.9k/1.0k, critique 8.6k/**11.6k**) , `arch_import` | discovery | graph-wide context, largest prompts |
| `*_fix` (`change_review_fix` implement 9.0k/**16.7k**/2.9k, `function_length_fix` 7.3k/8.0k/2.9k, `observability_fix`, `performance_fix`) | fix | code edits through the agentic-write tiers; biggest and slowest (function_length_fix implement 619 s average) |

Three classes follow, and they need different atomization:

1. **Review / detect** (judgement on one finding or one change). Mostly small prompts; the limits are long plan output and, for `change_review`, a large diff.
   Techniques: window or split the input (per file, per hunk), cap or restructure the plan stage, turn the plan into a short checklist.
2. **Fix** (produce an edit). Large because the model must read the code it edits. Techniques: scope to one hunk or one function, separate "locate" from
   "write", verify with the existing deterministic checks, keep the large lane as the fallback.
3. **Discovery** (arch). Graph-wide. Techniques: split by community or file group, make candidate generation deterministic, keep only judgement for the model.
   Expect some to be marked "not shrinkable at this tier" and that is a valid outcome.

## Boundary

**Core keeps** (measurement and routing, already built): the ledger and scorecard, lane tiers and health, reservation / probing / escalation, the debrief bundle and
source, the hub kernel and the plugin SDK.

**The plugin (`agent-manager-atomize`) owns:**

- **Variant sources.** New, smaller task sources registered next to the originals (for example `change_review_hunk`, a per-hunk review) plus a coordinator
  that fans a parent task out as a hub and merges the children's results. The original source is never edited and stays the fallback for big lanes.
  This is deliberate: ADR-0022 names the "half-extraction" (a plugin reaching into core or sibling-plugin internals) as the worst outcome, and variants avoid it.
- **The replay lab.** A harness that replays recorded tasks against any model with no side effects and scores the result (below).
- **The proposal pipeline.** Turns approved `capability_debrief` proposals (and its own findings) into variant definitions, runs them through the lab,
  and promotes a variant when it clears the gate.
- **Its own views** (a dashboard tab, optional later): per source, the variant list, replay results, current small-lane share.

## The replay lab

Input: a *corpus* of recorded tasks for one source, taken from `queue/done`, `task-logs` and `model_calls` (the same material the debrief bundle reads; tasks
are local and gitignored, so the corpus is local). Run: for each task, build the source's prompts, call a chosen model/lane with the lane's real `numCtx` /
`numBatch`, and capture the output without applying, filing, ledger-recording or touching the queue. Score each output on:

1. **Gate pass.** The source's own deterministic checks (`postImplementCheck`, parse and validate steps, `deterministicReviewValidate`). Cheap, objective.
2. **Agreement with the recorded accepted output**, on the fields that matter per source (verdict, flagged line, file list). This is a proxy, not ground truth;
   the recorded output came from a 27B and was itself accepted by a vote.
3. **Cost.** Wall time, prompt and output tokens, whether it fit the context.

A *variant* is the unit under test: same corpus, original vs variant on the small model. The 20- and 24-entry comparisons done by hand for `brain_dump_sort`
(2026-10-17/18) are the manual form of this and found real defects (placeholder tags, an invented project label) that the format check missed, which is the
point of the lab.

**Promotion gate.** A variant is promoted when it passes the gate on at least `N` replays (default 30) at or above the parent's 27B rate minus a margin, with no
class of failure the parent does not have, and a human has read a sample (default 10). After promotion the live ledger takes over: the variant's scorecard row
is read together with its parent's, and capability routing (reservation, probing, escalation) applies unchanged.

## What core must add (three small hooks, to be added to PLUGIN_API.md)

1. **`variantOf: '<parent source>'` on a source registration.** The scorecard, reservation and probing treat a variant and its parent as one task class with two
   shapes; the dashboard groups them.
2. **A supported dry-run call.** Run one recorded task's prompts on a named lane/model and return the raw outputs, with a guarantee of no ledger, queue,
   work-log or apply side effects. Today the lab would have to reach into `local-client` and the prompt builders directly, which is the deep-import wart.
3. **A stable read surface for measurement:** `lanes.js --json` (tiers, numCtx, numBatch, health) and the scorecard/ledger JSON, documented in `PLUGIN_API.md`
   with a test, so the plugin never parses internals.

## Phases (the hygiene set, in order of expected payoff)

0. **This note, then the three hooks and an in-tree replay lab.** No new repo yet. The lab is useful to core and the plugin alike.
1. **Pilot: `change_review`.** The known failure (14.5k max prompt, 3.2k-token plans, 300 s timeouts). Candidate variants: per-hunk review, a short-checklist plan stage.
   Proves variant registration, hub fan-out and merge, replay and promotion end to end.
2. **Remaining review sources** (`function_length_review`, `performance_review`, `observability_review`/`_digest`, `unused_export`, `arch_review`). Mostly stage
   shaping and plan-output caps; these are the quick wins and should move large volumes to the 8B.
3. **Fix sources** (`*_fix`, `deadcode_fix`). Scoped-hunk variants and a locate/write split. Gated on the agentic-write tiers working on the small lane at all.
4. **Discovery** (`arch_discovery`, `arch_import`). Hardest. Some outcomes will be "not shrinkable at this tier", recorded by the debrief.
5. **Extract to `agent-manager-atomize`** following the extraction playbook once phases 1 and 2 have settled the contract.

**Success measure:** share of hygiene-source attempts completed on the smallest capable lane (from the ledger), at a pass rate no worse than the parent's on
the 27B. Report it per source and overall.

## Risks and open questions

- **Merging partial results.** Per-hunk or per-file children must merge into one parent verdict/diff; `change_review` verdicts merge naturally, edits need
  conflict handling. The hub kernel already files children but merge semantics are per source.
- **Quality proxy.** Replay scores agreement with a 27B output and a deterministic gate; neither is ground truth. The human sample in the promotion gate is the backstop.
- **Corpus size and drift.** Rare sources may have fewer than `N` recorded tasks; the lab should say "insufficient corpus" instead of promoting.
- **Plan stages.** Many hygiene sources spend most of their time on a long plan output (2-3k tokens). Whether to shrink the plan, skip it, or move it to
  deterministic code is a per-source question the debrief and lab should answer, not this note.
- **Ownership of fixes.** A debrief proposal that changes an *existing* source (rather than adding a variant) still lands as an ordinary task in the repo that owns
  that source; the plugin only owns variants.
- **Name and repo.** `agent-manager-atomize` is a working name.
