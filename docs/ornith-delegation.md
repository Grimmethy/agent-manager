# Delegating to Ornith

Ornith (`ornith:9b` / `ornith:latest` in local Ollama) is a free, local, CPU-bound model on
this machine (RX 580/Polaris has no ROCm or Vulkan path in this Ollama build — confirmed
2026-07-05). It costs no API tokens to run, but each call takes ~7-8 minutes wall-clock.
It has **no tool access**: no filesystem, no DB, no network, no code execution. Every call
is a single stateless text completion — it can only reason over what's in the prompt, and
someone else (Claude) has to apply anything it produces.

This doc exists so the pattern is repeatable without re-deriving it each session. Update it
when the pattern changes — this is a living doc, not a one-time writeup.

## Invocation mechanics (all verified 2026-07-05 — don't rediscover these the hard way)

- **Use the Ollama HTTP API (`POST http://localhost:11434/api/generate`), not the `ollama run`
  CLI.** The CLI silently applies small default `num_ctx`/`num_predict` limits and truncates
  long answers mid-sentence with no error. Always pass explicit
  `options: { num_ctx: 16384, num_predict: 1200-1800, temperature: 0.5-0.6 }` in the request body.
- **Run it as a detached OS process, not a PowerShell background job.** `Start-Job` dies when
  the calling shell session ends between tool calls (shell state doesn't persist here).
  Write the API call into a `.ps1` script, launch it with
  `Start-Process powershell.exe -ArgumentList "-File",script -WindowStyle Hidden -PassThru`,
  save the PID, then `Wait-Process -Id $pid -Timeout <n>` in a later tool call.
- **Build the JSON body with `[System.IO.File]::ReadAllText()`, not `Get-Content -Raw` piped
  through a variable.** The latter can return a PSObject wrapping the string rather than a
  plain string, which `ConvertTo-Json` then serializes as `{"prompt":{"value":"..."}}` —
  silently bloating the body ~170x and breaking the request. Confirmed reproducible bug.
- **Feed context via shell concatenation (`cat CONTEXT.md >> prompt.txt`), never by reading
  the file into Claude's own context first.** Ornith has no filesystem access, so it needs
  the actual file contents pasted into the prompt — but building that prompt via `cat`/heredoc
  costs Claude ~0 tokens, versus reading the file into Claude's context to then re-type it.
- Read back only `response` and `thinking` fields (`Read` with a small `limit`) — the JSON
  also contains a `context` field (thousands of raw token IDs for conversation continuation)
  that is large and never useful to read. (Beyond token-waste: reading a large raw-token-ID
  array back into Claude's own context has tripped the usage-policy classifier and hard-blocked
  a turn — a big numeric blob reads like obfuscated content. Strip `context` before reading.)

### Constrained (grammar) decoding for pure-data output — set `format`, and it REQUIRES `think:false`

When a pass must emit pure structured data (e.g. the `state_targets` implement pass drafting an
`index.json`), pass Ollama's `format` parameter (`"json"`, or a full JSON schema) so the decoder
is grammar-constrained and a markdown-fenced or preamble-wrapped response becomes *unrepresentable*
rather than merely discouraged. This is the structural fix for the documented failure where
Ornith ignored "Output ONLY the draft JSON" and returned ```json-fenced text anyway.

**Hard gotcha, verified live 2026-07-08:** `format:"json"` + `think:true` returns an **empty
`response`** on this model — even at `num_predict: 1500` (so it is NOT a budget problem; the
model emits a few tokens into `thinking` and nothing into the constrained channel). `format:"json"`
+ `think:false` returns clean, fence-free, first-try parseable JSON (`done_reason: stop`,
`degenerate: null`). So: **constrained-JSON passes must use `think:false`.** That's fine for a
mechanical pass (corrected-plan → JSON needs no reasoning trace); keep `think:true` only for
prose/reasoning passes, which stay unconstrained. `ornith-client.js`'s `callOnce` now takes a
`format` passthrough; `ornith-worker.ps1` sets `format:'json' + Think:$false` for the
`state_targets` implement pass only.

### Deterministic pre-filters before the Claude review pass (`agent-pipeline/fact-checker.js`)

Four cheap, non-LLM tiers now flag an Ornith draft before the review pass spends tokens — each
"necessary but not sufficient," i.e. an empty flag list does NOT mean the draft is correct:
(1) file-existence, (2) claimed-relationship grep, (3) **blast-radius bias** (broad/heavy-change
language with no scoping acknowledgment — targets the "proposes the heavier fix" failure), and
(4) **grounded-value** (any URL or ALLCAPS_UNDERSCORE GIS-field token in the draft that appears
in NONE of the inputs Ornith was given — the structural catch for fabrication, which constrained
decoding *cannot* prevent since a hallucinated value is still valid JSON). Tier 4 caught a real
historical fabrication on its first run: the AZ Maricopa draft renamed the units table from the
stub's real `AZ_PUC` to an invented `AZ_MARICOPA_PUC_BANDS`. A golden-dataset regression suite
(`agent-pipeline/eval-harness.js`) re-probes these failure modes against fixed known-answer
fixtures; run `node eval-harness.js --with-ornith` when Ornith is free to set/refresh the baseline.

## What Ornith is actually good at

- **Reasoning over facts already handed to it.** Given real code + real DB state, it
  independently converged on the correct root cause of a live bug (a registry-key mismatch)
  from raw evidence alone — no hints, matched Claude's independent diagnosis exactly.
  This is the strongest observed case.
- **Following an explicit, narrow instruction to flag uncertainty.** When told "flag unknowns,
  don't invent," it mostly complied — it declined to invent a URL it didn't have, and hedged
  a legal-scope question appropriately.
- **Producing a structured first-draft plan** when given a concrete sibling example to model
  against (a real adapter's `index.json` to imitate), as a starting point for review — not
  as something to apply directly.
- **Retracting a specific, named claim when confronted with direct counter-evidence.**
  When shown a raw HTTP transcript that directly contradicted a fabricated claim (see below),
  it corrected cleanly, engaged with the actual evidence rather than restating a softened
  version of the wrong answer, and — notably — resisted inventing a replacement fallback when
  the honest answer was "no reliable signal exists in this data." **This "targeted correction"
  pattern (fix one specific flagged claim, evidence attached) has succeeded every time it's
  been tried** — it's the most reliable mode found so far, more reliable than either the
  original Plan or the original Implement pass.

## What Ornith is bad at — watch for these specifically

- **Confident fabrication when asked to recall facts from training instead of from a given
  source.** Invented classification codes, invented filenames, asserted contradictory claims
  in adjacent sentences (worst without CONTEXT.md loaded, but recurred even with it).
- **Defaults to a generic/template answer instead of checking real precedent it can't see.**
  Recommended a placeholder value (`portal_pending`) that was actually the project's
  *not-yet-built* marker, when the real terminal value (`portal_scrape`) was sitting one
  file-read away in a sibling county. It cannot grep the codebase, so it never finds this
  on its own.
- **Ignores investigative leads it's explicitly handed.** Given an unconfirmed-but-flagged
  alternative data source to consider, it didn't engage with it at all in its plan.
- **Proposes the architecturally heavier fix over the narrow one**, with no apparent sense of
  blast radius. Given a bug traceable to one wrong value in one file, it proposed rewriting
  shared registry-loading code that every county depends on.
- **States an assumption as settled fact after being told explicitly it was unconfirmed.**
  Told "assume X pending live verification," it wrote X into permanent adapter notes as if
  proven, and separately fabricated a specific vendor attribution (called a plain ASP app a
  "Tyler portal") with no basis for it anywhere in the prompt.

- **Degenerates on large, one-shot code-generation asks, independent of whether the facts are
  correct.** Asked to write a full, real ~150-line Node.js file in one call (all needed facts
  given directly, a sibling file to model on, nothing to invent) — first attempt got stuck in
  a verbatim repetition loop in its own reasoning and burned its entire output budget without
  emitting any code (`response` came back empty, 12,727 input tokens spent). This is a
  **different failure mode from fact-fabrication** — it's not confidently wrong, it's stuck.
  Confirmed 2026-07-05: full county-adapter ingest script, two attempts, described in detail
  in "Generation parameter sensitivity" below.

**The throughline:** Ornith cannot verify anything, so its failure mode is usually not "I don't
know" — it's producing something plausible-shaped instead. Never apply its output directly;
every claim of fact needs an independent check before it's trusted, and every plan needs an
architecture-review pass before implementation. The one exception is large-generation tasks,
where it fails *visibly* (empty output or incoherent text) rather than plausibly — easy to
catch, but currently a dead end rather than something to tune around (see below).

## Generation parameter sensitivity (confirmed 2026-07-05 — don't re-tune blind)

Asked to write a real, complete ingest script (~9,000 input tokens: full context, a sibling
script to model, and exact HTML/HTTP evidence — nothing left to invent), two attempts in a
row failed at the generation-parameter level, not the reasoning level:

1. **Default sampling** (`temperature: 0.3`, default `repeat_penalty`): got stuck in a verbatim
   repetition loop in its `thinking` field (the same paragraph, "Now I'm thinking through the
   rate limiting strategy...", repeated ~8 times back to back) and never produced any `response`
   text at all — burned the entire `num_predict` budget on the loop. 12,727 input tokens, 0
   output tokens of actual use.
2. **Retuned to fix it** (`temperature: 0.55`, `repeat_penalty: 1.3`, explicit "keep thinking
   under 150 words" instruction): broke the loop, but overcorrected into incoherent word-salad
   (`"** in a is49ys2xx;: -1857036 ( for zip: 2xyz can inM = ..."`) — not valid English, let
   alone code. 10,723 input tokens, 364 output chars of garbage.

**Combined cost of this failure: ~23,450 tokens of Ornith's own compute, ~15-16 minutes
wall-clock, ~3,000 Claude-side tokens (mostly reading the repeated-thinking transcript before
recognizing the pattern), zero usable output.** Worse than every "expensive" research round in
the cost-economics section below, because those at least produced something to correct.

**Untested next steps, in priority order, before trying full-file code-gen again:**
- Try a smaller `repeat_penalty` step (1.15–1.2) instead of jumping straight to 1.3 — the
  two data points bracket a working value but neither hit it.
- Try `mirostat: 2` (Ollama-supported adaptive perplexity control, purpose-built for this
  exact failure mode) instead of hand-tuning `repeat_penalty`.
- **Break the task into smaller sequential asks** rather than one large file — e.g., "write
  the session+pagination fetch loop" as its own call, "write the HTML row parser" as another,
  rather than the whole file at once. This matches the one pattern proven to work well
  (targeted, scoped corrections) versus the one proven to fail twice (large one-shot
  generation) — task *size*, independent of whether facts are given, looks like its own axis
  of difficulty, distinct from the research-vs-reasoning axis below.

## The workflow: Plan → Architecture review → Implement

This is Ornith's version of the `/grill-me` → `/improve-codebase-architecture` → `/implement`
sequence documented in `CONTEXT.md`'s "Development workflow" section — same three stages,
but Claude stands in as the architecture-review gate instead of a skill, because Ornith's
output needs fact-checking that only someone with real codebase/live-source access can do.

1. **Plan (Ornith).** Feed it CONTEXT.md + the task + any already-verified facts. Ask for a
   numbered plan, explicitly forbid code, explicitly ask it to separate "certain" from
   "inferred."
2. **Architecture review (Claude).** Check every concrete claim against the real codebase
   (grep for the actual convention, read the actual sibling example) and any live source
   (WebFetch, browser). Correct what's wrong. This step cannot be skipped or delegated back
   to Ornith — Ornith cannot check its own work.
3. **Implement (Ornith).** Feed it back the *corrected* plan explicitly (not just "try
   again") plus a concrete sibling file to model the output on. It will still introduce new
   errors in this pass — review the output with the same rigor as the plan, don't assume a
   corrected plan produces a correct implementation.
4. **Apply (Claude).** Ornith cannot write files or run anything. Claude applies whatever
   survives review.

## Cost economics (real numbers from 2026-07-05, methodology: `chars ÷ 4 ≈ tokens`, since
there's no token-counter tool — treat as estimates, not exact)

Cheap rounds (~1,200-1,300 Claude-side tokens): diagnosis and planning, when Claude already
had the ground-truth facts *before* prompting Ornith (had already read the real code, or had
a real sibling example on hand).

Expensive rounds (~4,000-8,000 Claude-side tokens): open-ended research, where Ornith's
claims required a full independent verification pass afterward (a legal statute, a state tax
code table, a hallucinated URL) — that verification costs the same whether Ornith prompted it
or Claude went looking on its own initiative, so delegating didn't save anything there.

**Rule of thumb: gather facts first (Claude's own tools), delegate reasoning/planning second
(Ornith).** Used as a first-pass open-ended researcher, Ornith adds a ~7-8 min wait without
reducing what still has to be independently verified. Used to reason over facts already
established, its overhead is small and it functions as a legitimately cheap second opinion.

## Toward a longer, less-supervised loop (open problem, not yet solved)

The goal is a self-reinforcing Plan/Review/Implement loop that runs for hours without a human
in every step. The current hard blocker: Ornith cannot verify its own claims, and its failure
mode (confident fabrication, not visible uncertainty) means the architecture-review step
cannot be skipped or automated away without a real verification capability standing in for it.

Three levers worth pulling, in the order they're likely to pay off (none fully solved yet):

- **Scope every round to fact-reasoning-only, and keep each ask small.** Two separate findings
  point the same direction: (1) it's cheap and reliable reasoning over facts already gathered,
  expensive and unreliable recalling/researching facts itself; (2) it degenerates on large
  one-shot generation even when facts are fully given, but succeeds reliably on small, targeted
  "fix this one flagged thing" asks. Combined rule: **hand it small, fact-complete, narrowly-scoped
  units of work** — a plan section, one function, one specific correction — never an open-ended
  research question or a whole file in one shot.
- **Tune generation parameters properly instead of guessing.** The `repeat_penalty` experiment
  bracketed a working value without finding it (1.1 default loops, 1.3 breaks coherence) —
  worth a real sweep (1.15, 1.2, 1.25) or trying `mirostat: 2` before concluding code-gen is a
  dead end for this model. Not yet done.
- **Build a lightweight automated verification harness** (grep the codebase for a claimed
  convention, hit a claimed URL, check a claimed DB value) that runs between Ornith's Plan and
  Implement steps without a human reading every line — only escalating to a human when the
  harness itself can't confirm or deny a claim. Not built yet; would need to be scoped
  narrowly (a handful of checkable claim types) rather than general-purpose fact-checking.

Until these exist, keep a human (or Claude acting as one) in the review step for anything
that gets applied to real code or real client data — and prefer many small delegated asks
over one large one, since that's the one lever already confirmed to move the needle.

## Update 2026-07-05: raw counting is a distinct, separate failure mode from code-gen

Tried delegating a different kind of task — tallying ~20-55 cross-community edges from a
graphify dependency graph by target community — and found failure patterns that don't match
anything above (that section is all about *generation*; this is about *counting given data*).

- **`think: false` fixes the "stuck, empty response" failure directly.** With thinking on
  (default), a 54-line tally task burned its entire `num_predict` budget re-deriving the same
  count three separate times inside the `thinking` field (visibly flip-flopping on which
  target community a line belonged to) and returned `""` for `response` — a dead loss, ~4.3
  minutes wall-clock. Passing `think: false` on the identical task returned a complete, correctly-
  *shaped* answer in well under a minute. If a task doesn't need the reasoning trace, turn
  thinking off — don't just raise `num_predict` and hope it finishes the loop.
- **But `think:false` doesn't fix accuracy — it just fails faster and more legibly.** Across
  three separate small-batch tally trials (25, 51, and 23 edges), the pattern was consistent:
  categories with 1-3 items came back exactly right every time; categories with 16+ items were
  wrong every time, by a lot (claimed 37 vs actual 16; claimed 9 vs actual 8; claimed 26 vs
  actual... the list of misses always landed on the *largest* bucket in the batch). **The
  count you most need to trust — the biggest one — is the one it's worst at.** Splitting into
  smaller batches didn't fix this; the failure tracks the size of an individual category, not
  the size of the batch.
- **Checking the total is not sufficient verification.** One trial had two categories off by
  one in opposite directions (+1, -1) that canceled in the sum — the total was exactly right
  while 2 of 10 rows were wrong. A total-only check would have falsely certified it. Verify
  every row, or don't trust the tally at all.
- **Conclusion: don't delegate raw counting/aggregation to Ornith, even in small batches.**
  This is a different capability gap than the code-gen one — it's not about task size, it's
  that language models are unreliable at exact enumeration once a run gets past a handful of
  repetitive items. Do counting/aggregation with a deterministic script; reserve Ornith for
  the reasoning/design layer on top of numbers you already trust.

## Update 2026-07-05: qualitative judgment calls are also not stable — use majority vote

Ran the *identical* prompt (same community data, "is this genuine architectural coupling or
an already-correct shared utility?") twice at temperature 0.35 and got opposite verdicts —
once "genuine coupling, build an interface," once "clean hub, leave it alone." Nothing about
the input changed; only the sampling draw did. A single-shot qualitative verdict from Ornith
is a coin flip you can't see, not a fact.

**Fix that worked well in practice:** lower temperature to ~0.2 and run the same assessment
3 times independently, then take the majority verdict before doing anything with it. In a
same-day retest at temp 0.2, 3/3 runs agreed (all "genuine coupling"), and — notably — all
three *independently* converged on flagging the same real anomaly in the data (a duplicate
`SelectedPropertyContext.tsx` file) without being told to look for it, which is a much
stronger signal than any one of them alone. Cost: 3x the calls for the assessment step. Worth
it for any judgment call that will gate a further, more expensive step (like a design pass) —
not worth it for throwaway/low-stakes questions.

## Update 2026-07-05: hubs vs. seams — a metric trap

Ranking communities by raw cross-community edge count to find "the most architecturally
tangled area" surfaced two false positives first: a shadcn/ui `cn()` className-merge helper
(imported by ~70 component files) and a Python scraper-adapter registry (`scraper_registry.py`
+ `ScraperResult` contract, fanning out to ~20 county adapters by design). Both are legitimate,
already-correct "many callers, one clean provider" patterns — high connectivity there is a
*sign of good design*, not a smell. **Raw edge count measures "most widely used," not "messiest
to clean up" — those are different questions.** A cheap discriminator that worked well: compute
edges-per-own-file for each community (total cross-community edges ÷ number of distinct files
the community's nodes live in). Hubs have a small number of files serving a huge, wide fan-out/
fan-in (ratio in the teens or higher); genuine multi-file tangles have a lower ratio (single
digits) because the coupling is spread across many files roughly equally rather than funneled
through one shared provider. Filter hubs out before ranking, or the top of the list will always
be infrastructure that's already fine.

## Update 2026-07-05 (morning follow-up): the hub-filter wasn't nearly aggressive enough

The hub filter above only caught the crudest case (a tiny module with an enormous fan-out,
like `cn()`). Once actually implementing the "top verified candidates," a much broader and
sneakier version of the same problem showed up: **of ~13 "genuine coupling" designs checked
against real code, 12 were false positives**, for reasons the edges-per-file heuristic can't
see at all:

- **A barrel/re-export file already existed** (`frontend/src/api/index.ts` re-exporting every
  API module) — every consumer already imported through it, so the graph's edges (which trace
  through the barrel to the concrete defining file) *looked* like scattered direct coupling
  when the actual import statements were all clean, single-line, barrel-only.
- **Named imports of exactly what's needed from one shared file** is completely normal and not
  a coupling problem at all — several files each importing 1-2 specific functions from a larger
  shared module (no barrel, just plain named ES imports) is what correct module boundaries look
  like, not a smell.
- **Same function name, different implementation by design** — a factory+strategy pattern
  (two counties' tax scrapers both defining a local `_taxable()` with the same name but
  genuinely different formulas, because their data sources differ) looks like duplication to a
  first-draft LLM design step but is actually the correct shape for that pattern. Unifying it
  would have been a real bug.
- **A route/controller file importing from many services** is what a controller is *supposed*
  to do — high fan-out there isn't a design flaw, it's the job description.
- **The proposed new module already exists in spirit** under a different name/location that a
  design step working from a partial edge list simply didn't have visibility into.

**The automated fact-checker (file/symbol exists in the repo) didn't catch any of this**,
because "the file exists" and "the claimed relationship is real" (Update above) are both
necessary but still not sufficient — the missing check is "**does this problem already have an
existing solution I haven't looked for yet?**" That requires reading the *consumer* side (how
things are actually imported today), not just confirming the *target* side (does the proposed
file/function exist).

**Concrete fix for next time:** before any design step runs, add one more automated check per
candidate: grep every claimed consumer file for how it currently imports the relevant symbols
(direct from the target file? through a barrel? through some other existing shared module?).
If a single existing import point already covers all consumers, mark the candidate a likely
hub/false-positive and skip the design step entirely — this one check would have eliminated
12 of 13 candidates before spending an Ornith call on them. Raw connectivity in a dependency
graph measures "this is used by a lot of things," which correlates with *both* "this is a mess"
and "this is a well-placed shared dependency" about equally — the graph alone cannot tell those
apart; only reading the actual import sites can.

## Update 2026-07-05: a new degenerate-output mode — silent all-zeros, self-healing

During an unattended overnight run (32 communities, 3 stateless `/api/generate` calls each,
`think:false`, temp 0.2), the model fell into outputting the **literal string `000000...`**
(30+ zero characters, no other content) as its entire `response` for **20 consecutive
communities in a row** — a totally different prompt each time, all producing the identical
degenerate output. It self-recovered on its own partway through the same unbroken run (the
next ~10 communities after the bad stretch produced normal, coherent, on-topic answers again)
without any restart or intervention. Each call is stateless (no `context` passed between
calls), so this isn't conversation-level corruption carrying over — something about the
inference engine's internal state (KV cache / sampler state in the underlying llama.cpp
process) went bad and later un-stuck itself, independent of prompt content.

This is worse than the known failure modes above because **it fails silently and uniformly**
— no `done_reason: length` cutoff, no visible repetition loop, just `done_reason: stop` with
a short, syntactically-valid-looking response that happens to be garbage. A naive pipeline
that doesn't sanity-check response content (e.g. "is this mostly one repeated character?")
would silently record 20 straight false "no signal" results and never know.

**Mitigation that worked:** treat any response that's mostly one repeated character (or that
fails to contain expected structure, e.g. no "GENUINE COUPLING:"/"CLEAN HUB:" marker at all
across all 3 votes) as a hard signal to **retry later in the same session**, not as a genuine
"unclear" verdict — it healed on retry once the bad stretch had passed. Add an explicit
degenerate-output check (repeated-character ratio, or a minimum-diversity check on the
response string) to any unattended pipeline before trusting a "no signal" result.

A second, non-obvious variant of the same failure showed up on a different call: not all-zeros,
but fluent-looking garbled multi-script gibberish (English/CJK/random-symbol word-salad). A
repeated-character detector doesn't catch this — it needed a second check (a high ratio of
non-ASCII characters, or too few real English words, relative to response length for an
English-only task).

**A related but distinct bug was in the surrounding pipeline code, not the model:** the
majority-vote consensus logic compared `couplingVotes > hubVotes` without requiring an actual
majority of *real* (non-degenerate) votes. Concretely: 1 genuine "coupling" verdict + 2 pure
degenerate-garbage "unclear" votes passed as confident 1-0 "coupling" consensus, since the
comparison only looked at coupling vs. hub and ignored how many votes were actually usable.
That contaminated design proposal was then built from a prompt seeded with 2 garbage "reviewer
notes," and the design step's own output came back as more degenerate garbage — the corruption
compounded downstream instead of getting caught. **Fix: require an absolute count (≥2 of 3
real votes), not a relative comparison of two buckets that can both be small.** When building
any voting/ensemble scheme over an unreliable model, validate the individual votes *before*
counting them, not just at the point where you use the tally.

## Update 2026-07-05: "the file exists" is a much weaker check than it looks

The automated fact-checker built for the overnight run verifies that every file Ornith
mentions actually exists in the repo — and it caught real problems (invented file paths).
But it does *not* verify the specific relationship claimed about that file. Concretely: a
design proposal claimed `hooks/usePropertyFilter.ts` calls `listOwnerList()` from
`api/ownerList.ts`. `usePropertyFilter.ts` is a real file (passes the check) and
`listOwnerList()` is a real function (passes the check) — but grepping the actual import
showed `usePropertyFilter.ts` doesn't import it at all; a *different*, similarly-named hook
(`usePropertyList.ts`) does, and the file Ornith actually meant to cite (`SellerList.tsx`)
only imports an unrelated function (`getDistinctValues`) from that same module. Likely cause:
several similarly-named files/functions in the same domain (two hooks one letter apart,
several functions from the same module) and the model picked a plausible-sounding but wrong
pairing. **"Every file/symbol mentioned is real" is necessary but not sufficient — always
re-verify the actual claimed relationship (which file imports which symbol) with a real grep
before treating a "files that would change" list as accurate.** The underlying "what should be
consolidated" idea was still correct in this case; only the specific consumer list was wrong.

## Update 2026-07-05 (evening): self-directed research run — file-access design + mitigations for its own failure modes

Asked Ornith to (a) propose mitigations for the 6 failure modes documented above and (b) design
what safe, scoped local file access for itself would need to look like via Ollama's tool-calling
support. This reproduced a known lesson live before producing anything useful, then did produce
a usable first draft once corrected.

**The compound single-call attempt failed exactly as predicted.** Asking both (a) and (b) in one
prompt (`num_predict: 1800`) burned the entire output budget on the `thinking` field and returned
one sentence of actual response before `done_reason: length` cut it off — a live repeat of the
"Generation parameter sensitivity" section above, just triggered by a compound *research* ask
instead of a code-gen ask. **Fix that worked:** split into two separate calls (~3,200 words of
prompt each), each with `num_predict: 3200` and an explicit "keep your internal reasoning brief,
spend your budget on the actual answer" instruction. Both then completed fully and coherently
(`done_reason: stop`). Confirms the "break large asks into smaller sequential ones" lesson applies
to open-ended research/design asks, not just code generation.

**File-access design output (usable first draft, not yet architecture-reviewed):** Ornith proposed
building read-only tools first — `list_dir` and `read_file`, both scoped to relative paths under
one fixed sandbox root, with a `max_bytes` read cap — and explicitly deferring `write_file` until
read reliability is proven over real use. Safety boundaries it named: reject absolute paths and
`..` traversal; on symlinks, allow reads to follow them but refuse a write if the symlink target
resolves outside the sandbox; require a human-approval flag before any write lands on disk; and,
given its own fabrication tendency, verify writes by reading the file back and comparing byte
counts, and keep an append-only audit log outside the sandbox so a human can check its work after
the fact. **Notably, it did not fabricate a real path for this project** — it used a generic
placeholder and said so explicitly in its own reasoning ("I don't know the exact machine setup").
This is the "good" pattern from the top of this doc (declining to invent what it isn't given), not
the "bad" one — worth reinforcing given how rare it's been.

**Mitigation output contained one confirmed factual error:** it recommended `mirostat=true,
mirostat_eta=0.5` — Ollama's actual `mirostat` option is an integer (`0` off, `1`, or `2`), not a
boolean, so that specific line is not usable as written. Everything else it proposed checked out
against real Ollama options: chunked generation with explicit `=== CHUNK N/4 ===` delimiters for
large files, majority-voting plus a repeated-character/non-ASCII-ratio guard for the silent-
degenerate-output bug (both already implemented in `ornith-client.js`'s `detectDegenerate`), an
explicit numbered-enumeration step before counting instead of counting in prose, seed-pinning for
reproducibility on judgment calls, and a "check for an existing barrel/shared import file before
proposing a refactor" pre-check for the false-positive design-proposal problem.

**Net result: no dead end, but nothing here is ready to apply directly either.** Both outputs are
still first-draft plans from Ornith about its own failure modes — verified so far only against
"does this Ollama parameter actually exist," not against this project's real conventions. Before
building any of the file-access tools, the Part B design needs the same architecture-review pass
(step 2 of the workflow above) any other Ornith plan gets.

## Update 2026-07-05 (night): read-only file access — designed, reviewed, implemented, and verified live

Followed through on the file-access design above with the full Plan → Review → Implement → Apply
workflow, end to end, same evening. **Ornith now has real read-only file access, confirmed
working live**, not just a design document.

**Plan pass:** fed Ornith the real, working tool-calling harness (`ornith-agent-test.js`'s actual
`TOOL_IMPLS`/`TOOL_SCHEMAS`/chat-loop shape, not a hypothetical) and asked for a plan to add
`read_file`/`list_dir`. It correctly reasoned through `path.normalize`/`path.resolve`, stat-based
size caps, and Windows case-insensitivity — **but its boundary check was a real security bug**:
`resolved.startsWith(sandboxRoot)` alone would wrongly admit a sibling directory (`consumer-evil`
passes a naive `startsWith('.../consumer')` check). It also under-specified resolving against
`process.cwd()` instead of the fixed sandbox root. Both caught and corrected before any code was
written — exactly the "architecture-review step cannot be skipped" lesson from earlier in this doc,
this time on Ornith's own proposed infrastructure rather than a county adapter.

**Implement pass — reproduced and fixed a known failure mode live:** asking for both `isPathSafe`
and the two tool functions in one call (`num_predict: 2200`) hit `done_reason: length` after
burning the whole budget on `thinking`, output cut off mid-function. Splitting into two even
narrower calls — one function each, every API call and exact string spelled out in the prompt so
there was nothing left to reason about — fixed it completely; both came back correct on the first
try with no further corrections needed. This is the strongest confirmation yet that task size,
not fact-availability, is the binding constraint on Ornith's code-gen (see "Generation parameter
sensitivity" above) — here every fact was already given in the failed compound attempt too.

**Apply pass (Claude):** wrote the reviewed code into `ornith-agent-test.js` — `const fs`/`const
path` added to requires, `SANDBOX_ROOT = path.resolve(__dirname, '..')` (the whole consumer
project root — Docs/, GOAL.md, CLAUDE.md, domain-specific sibling examples), `isPathSafe`,
`toolReadFile`, `toolListDir`, and the two new `TOOL_SCHEMAS`/`TOOL_IMPLS` entries. Deliberately
no `write_file` yet, per the read-only-first recommendation.

**Verification, in order of increasing confidence:**
1. Unit-style smoke test of the applied logic against the real directory tree: real file read
   succeeded, a `../../../Windows/System32/...` traversal was rejected, and — the specific bug
   caught above — a `../consumer-evil-sibling/secret.txt` sibling-prefix escape was correctly
   rejected too. Directory-as-file, nonexistent-file, and nonexistent-dir cases all returned the
   right typed errors.
2. **Live end-to-end test through the real Ollama tool-calling endpoint** (no DB/Prisma
   involved): asked Ornith to list `Docs/`, read `Docs/agents/ornith-delegation.md`, and summarize
   its opening paragraph. It called `list_dir` then `read_file` with correct arguments in
   sequence, then produced an accurate one-sentence summary matching the real document content —
   no fabrication, no repetition loop, no degenerate output, first attempt.

**Where this leaves things:** Ornith can now look up its own project's real documents instead of
needing everything hand-pasted into every prompt (`task-sources.js`'s stated reason for
self-contained task JSONs may be worth revisiting now that real reads work). Write access remains
deliberately unbuilt — the design above calls for human-approval-gated writes plus a read-back
checksum verify, none of which exists yet. Do not add `write_file` without going through this same
Plan → Review → Implement → Apply cycle, and do not skip the live verification step — a design
that looks correct on paper (as this one initially did, bug and all) still needs to be run against
real adversarial input before it's trusted.

## Update 2026-07-05 (later that night): directed exploration surfaces the worst fabrication case yet

Now that real file reads work, ran a directed exploration test — six real files across remote
corners of the project (CONTEXT.md, an ADR, the Python enricher registry, a real county adapter,
the frontend API barrel, TROUBLE_LOG.md), asking for a structured, cited report at the end. Two
new, serious problems surfaced that having real reads did NOT fix (having a source available
doesn't guarantee it gets used honestly):

**Worst confirmed fabrication case so far.** After genuinely reading the real
`Docs/TROUBLE_LOG.md` (confirmed: the tool call succeeded, real content was returned), Ornith's
summary was an entirely invented narrative: a "Conversation Analysis, May 24 – Mid June 2026,"
fabricated ticket numbers (T-032/037/045/048/059 — the real file's first entries are T-073/T-074,
dated 2026-06-28, about a stale `worker.js` daemon causing a runaway whole-county scrape), a
fabricated "pg_dump --schema-only" discovery of "14,000 rows" and "2,346 orphaned properties,"
and an invented "31-commit architecture refactor" plan. This is qualitatively worse than the
fabrication cases earlier in this doc (invented filenames/classification codes) because it's a
long, internally-consistent, specific, confident narrative built from a real source it had just
read — not a guess made in the absence of a source. **Having the real file in context did not
prevent fabrication; it fabricated instead of summarizing even with the real text sitting right
there in the tool result.** This is the clearest evidence yet that "give it real data" alone does
not solve the confident-fabrication problem — something in the summarization step itself is
unreliable, independent of whether a real source was available.

**New failure mode: cannot reuse information already in its own context.** Nudged to go back and
read one skipped file (`backend/python_services/enrichers/__init__.py`, in a directory it had
already `list_dir`'d earlier in the SAME conversation, with the exact filename visible in that
earlier tool result), it never tried the correct path again. Instead it guessed wrong variants
(`__init__.py` as a bare directory path, `backend/python_services/__init__.py` missing the
`enrichers/` segment) and then, having failed twice, wandered through twelve unrelated directories
(`deals`, `ux-research`, `cx-analysis`, `backend/scripts`, `docs`...) for the rest of its 18-call
budget, never once revisiting the directory listing it already had. This is distinct from every
failure mode documented above — it's not fabrication and not a generation-length problem, it's a
failure to use its own prior tool output as ground truth when a first guess is wrong. Practical
implication: an unsupervised multi-step tool-use loop cannot be trusted to self-correct via
"look at what you already found" — if a nudge is needed, the nudge should probably re-state the
exact fact directly (e.g. "the file is at backend/python_services/enrichers/__init__.py") rather
than assuming it will reconstruct that from its own earlier tool call.

**Conclusion — do not treat real tool access as sufficient supervision.** Every claim Ornith makes
about a file it read still needs the same independent verification as before real file access
existed; if anything this run raises the bar, since a fabricated-but-plausible summary of a real,
correctly-fetched file is a harder failure to catch by inspection than an invented file path (which
at least fails an existence check). Before using Ornith's summaries of its own exploration for
anything (e.g. feeding them into a further planning step), spot-check specific claims against the
real file — do not trust a "structured report" just because it cites a real file path per section;
the citation itself does not establish the content under it is accurate.

## Update 2026-07-06: an interactive chat REPL was built, and the TROUBLE_LOG.md fabrication reproduced a second time, independently

Built `backend/ornith-chat.js` — a persistent REPL (`node ornith-chat.js`) so a human can type
prompts directly at Ornith with the same read-only file tools, instead of only running fixed
scripted tasks. Same Plan → Review → Implement → Apply cycle as the original tool build: Ornith's
Implement pass on the REPL's `main()` function had three real bugs caught in review before it
shipped — it read `resp.content` (the real shape is `resp.choices[0].message`), read
`call.arguments` (the real shape is `call.function.arguments`), and called `impl(...args)`
(spreading an object into positional arguments, when the tools take one object argument). Given
the density of bugs and the fact this was glue code around already-correct pieces, this one was
hand-fixed directly rather than sent back for another Ornith pass — a deliberate, explicit
exception, not a default. A separate, real robustness bug was also found and fixed during smoke
testing: `readline`'s interface auto-closes when piped stdin hits EOF, and calling `.question()`
again after that throws instead of failing gracefully — patched with a `closed` flag so it's
treated like the user typing "exit". This only matters for piped/non-interactive stdin (a real
terminal doesn't EOF while someone's typing), but was cheap to fix.

**The TROUBLE_LOG.md fabrication reproduced immediately, independently, in the new tool.** Asked
directly to "read TROUBLE_LOG.md and give me one real ticket number from it," Ornith read the real
file (confirmed: the tool call succeeded and returned real content) and then, instead of citing
one real ticket, wrote out an entirely fabricated "Comprehensive Technical Changelog" — invented
ticket numbers (PRF-017, PRF-025, T-020 through T-035, T-038, T-047, T-052), an invented line
number (`coordEnrichJob.js:2139`), and invented statistics (127 concurrent jobs, 67% of map load
time, a 925-line Admin.tsx, 21,360 rows across counties) that don't correspond to anything in the
real file (whose actual opening entries are T-073/T-074, dated 2026-06-28, about a stale
`worker.js` daemon). This is now confirmed **twice, independently, on the same file, in two
different harnesses** (the earlier six-file exploration test, and now this REPL) — no longer a
one-off glitch. **TROUBLE_LOG.md specifically should be treated as a known fabrication trigger for
this model** until proven otherwise; it may be the log's dense, list-heavy, ticket-number-laden
format that's pattern-matching Ornith into generating more of the same shape rather than reading
carefully. Do not trust any Ornith-produced summary of this file, or likely any similarly
dense/structured log file, without checking every specific claim against the source.

## Update 2026-07-08: seven attempts to get one small judgment call out of `ornith:9b` via Vulkan, and a new fabrication variant

Asked for a narrow, tools-free judgment call (3 short questions, all facts pre-verified and
handed over directly — no exploration needed at all) on whether a targeted mailing-address
retry was worth running. Took **seven attempts** across every combination tried this session
before getting a usable answer:

1. `ornith:35b`, tools available: narrated intent ("I'll start by reading...") but never
   emitted a `tool_calls` array — a dead turn.
2. `ornith:9b`, native `/api/chat` streaming, tools available: 133 tokens generated, 0 visible
   content, 0 tool calls — the whole budget vanished with nothing surfaced.
3. `ornith:9b`, native streaming + `think:false`, tools available: read 3 real files correctly
   via tool calls, then on the next turn **asked the human clarifying questions instead of
   answering** ("what are you planning?"), ignoring explicit instructions already given.
4. Same setup, retried with an explicit "do not ask questions, state the plan" directive:
   read the same 3 files again, then lost track of paths it already knew (guessed
   `/ada/id_ada_assessment_notice.py`, an absolute path outside the sandbox), and by the next
   turn the **model itself emitted malformed tool-call XML** that broke the API's own parser
   (`XML syntax error on line 3: element <function> closed by </parameter>`) — this happened
   once the conversation had grown to ~66K characters of accumulated file content.
5. Pivoted to a **tools-free, facts-pre-verified single-shot prompt** (Claude did the file
   reading/architecture-review directly instead of routing it through Ornith's tool loop) with
   default sampling + `think:false`: burned the entire `max_tokens` budget (900/900) and
   returned **empty content** — the documented "stuck in a repetition loop" pattern, but this
   time with zero tools and zero ambiguity in the prompt, so tool-calling complexity is ruled
   out as the cause.
6. Same tools-free prompt, `repeat_penalty: 1.15, temperature: 0.4` (the doc's own previously
   "untried" fix): **worked** — produced a complete, on-topic, correctly-structured answer.

**Confirms the doc's existing `repeat_penalty` finding was right** (default 1.1 loops on this
kind of task; 1.15 fixed it without the 1.3 overcorrection previously seen) — this had never
actually been tried before despite being flagged as the top untried lever. **Recommendation:
default to `repeat_penalty: 1.15-1.2` for any judgment-call/reasoning prompt on `ornith:9b`,
don't wait for a repetition-loop failure to reach for it.**

**`repeat_penalty: 1.15` fixes the reasoning/judgment-call dead-turn, but NOT the code-gen one
— confirmed as two separate failure axes, not one shared fix.** Immediately after the
judgment call above succeeded with `repeat_penalty: 1.15, temperature: 0.4`, the very next
delegation (write a small, fully-specified ~20-30 line one-off Node script, same tools-free/
facts-pre-verified shape, same sampling params) burned the entire `max_tokens` budget
(2200/2200) and returned empty content — the identical dead-turn shape as the untuned
reasoning failures above, but this time on generation, not reasoning. **Don't assume a
sampling fix that resolves one failure axis (reasoning) transfers to the other (code-gen)** —
they need to be tuned and tested independently. The doc's older "Generation parameter
sensitivity" section's fix (split into smaller sequential asks) remains the one lever not yet
invalidated for code-gen specifically.

**New fabrication variant found in the attempt-6 output, worth flagging on its own:** despite
the prompt only ever mentioning "909" missing rows, Ornith's answer referred to "the 271
still-missing (of the 909)" — a specific, confident, internally-consistent-sounding number
that appears nowhere in the prompt and has no basis in any given fact. This is the same
"confident fabrication" pattern as the TROUBLE_LOG.md case above, but notably smaller/subtler
— a single plausible-looking number embedded in an otherwise-correct paragraph, not an entire
invented narrative. **Numbers are exactly as fabrication-prone as facts/citations — verify
every specific figure Ornith states against what was actually given, even in a short, mostly-
correct answer.** The same response also stated "expect roughly half or better" to recover
with no grounding data behind that fraction either — a confident-sounding estimate presented
as if derived, when nothing in the prompt supported that specific ratio.

## Standard tier as of 2026-07-08 (revised same day): `ornith:9b` via Vulkan GPU, not `ornith:35b`

Earlier the same day this doc briefly recommended `ornith:35b` as standard, reasoning that
35B's better output quality was worth the CPU/mmap-bound slowness (RX 580/Polaris was believed
to have no ROCm or Vulkan path in this Ollama build, confirmed 2026-07-05). **That hardware
assumption was wrong, or was fixed same-day** — Vulkan support got sorted out, and Ollama
0.31.1 auto-detects the RX 580 8GB over Vulkan with zero extra env vars on Claude's end
(`Vulkan0 : Radeon RX 580 Series (8192 MiB)`, confirmed in `%LOCALAPPDATA%\Ollama\server.log`)
and fully offloads all 33/33 layers of the 9B model to it. **`ornith:9b` is now the default
model again** for both `ornith-chat.js` and `ornith-agent-test.js`
(`process.env.ORNITH_MODEL || 'ornith:9b'` — set `ORNITH_MODEL=ornith:35b` only if a task
specifically needs 35B's larger capability and the much slower generation is acceptable):

- **Ollama's `ornith` library has exactly two tiers**: `ornith:9b` (5.6GB) and `ornith:35b`
  (21GB, MoE — only ~3B params active per token). No other size exists in the official
  library despite some SEO-blog claims of a 31B-dense/397B-MoE lineup — don't trust those,
  only `ollama.com/library/ornith` is authoritative.
- **35B tier, for reference:** loads with all 41/41 layers "offloaded," but most of that is
  memory-mapped and computed on CPU (only ~5.3GB fits in the 8GB VRAM even with Vulkan working)
  — RAM headroom gets genuinely tight (observed dropping to 0.4GB free mid-generation), and
  observed generation speed is ~2 tok/s with ~300s+ prompt-eval on a ~1000-token prompt before
  the first output token even appears. **Always unload the other tier first**
  (`ollama stop ornith:9b` / `ollama stop ornith:35b`) before loading the other —
  `OLLAMA_MAX_LOADED_MODELS:0` means the server only keeps one resident, so calls to the two
  tiers interleaved will cause repeated swap-load thrashing, not a crash, but very slow.
- **9B tier via Vulkan fits entirely in VRAM** (33/33 layers offloaded, confirmed live in
  `server.log`) — this is why it's standard again: full GPU offload beats a mostly-CPU 35B on
  this hardware for most tasks. Only reach for 35B when a task's reasoning/context needs
  genuinely exceed what 9B can do and the wait is acceptable.
- **`num_ctx` should stay at 49152 or higher regardless of tier** (already applied in both
  scripts) — Ornith's real trained context is 256K for both tiers, but Ollama's 16384 default
  silently truncates real project files (`TROUBLE_LOG.md` alone is ~38K tokens). **This was the
  load-bearing fix for the fabrication problem, not the model size** — see the corrected
  finding below. Don't shrink this back down just because 9B is faster.
- **Timeout:** keep the 30-minute (`1_800_000` ms) timeout in both scripts' `postJson` even
  though 9B/Vulkan should rarely need it — cheap insurance against a cold-load or a large
  prompt-eval on a big file.
- **Cost, revised again:** 9B via Vulkan should be back to roughly its original ~7-8 minute
  budget per real call (likely faster with full GPU offload) — nowhere near 35B's 10-30 minute
  range. Re-benchmark once a few more real tasks have run through it.

### Corrected finding: the TROUBLE_LOG.md fabrication was a context-window bug, not a fixed model limitation

The 2026-07-05 entries below document `ornith:9b` (at the default 16384 `num_ctx`) fabricating
an entire fictional "Comprehensive Technical Changelog" when asked to cite a real ticket from
`TROUBLE_LOG.md` — invented ticket numbers, invented statistics, none of it in the real file.
**On 2026-07-08, `ornith:35b` was given the identical prompt at `num_ctx: 49152`, which is the
first time this test has actually let the whole ~38K-token file fit in context.** Result:
Ornith correctly cited three real tickets (T-057, T-058, T-059) with content that matches the
real file **verbatim in places** (the "31-commit plan" phrase, the six-phase refactor table
structure) — a live-verified check against the actual file confirmed every specific claim.
It did not follow the literal instruction ("give me *one* real ticket") — it gave an
unprompted multi-ticket summary instead — but every fact in that summary was real.

**Conclusion: the file was silently truncated to 16384 tokens on every previous test run**
(both the 9B-tier and the first, mis-scoped 35B-tier attempt at the old context default),
and the model was reasoning over — or filling in — a mangled fragment, not the real document.
That's the more likely explanation for the confident-fabrication pattern on this specific file,
not (or not only) an inherent model unreliability. **Before concluding Ornith "fabricates" on
a given file, always check the file's token count against the request's actual `num_ctx` first.**
This doesn't retroactively clear every fabrication case documented below (some used much
shorter prompts that did fit in 16384 and still fabricated), but it means file-size/context-fit
must be ruled out before attributing a bad answer to the model itself.

## Update 2026-07-10: failure patterns from the continuous-runner + dashboard build (7 delegated slices)

The multi-instance runner, AgentTask DB mirror, and Agent Ops dashboard were built via
Plan/Draft/Review/Apply with `ornith:9b` drafting every artifact and Claude as the gate
(one or two feedback rounds per slice). Four patterns recurred across independent slices —
treat them as expected costs of delegation, and design the review pass to catch them:

1. **Dropped functions on "revise this file" tasks (the worst one).** Twice in one build:
   asked to revise `ornith-worker.ps1`, Ornith deleted `Invoke-OrnithClient` and
   `Get-PromptText` while the loop still called them; asked to loop-ify
   `review-runner.ps1`, it deleted `Add-ReviewLogEntry` the same way. It optimizes for the
   NEW requirements and silently drops existing code it wasn't told to touch, even under
   "keep all existing behavior". **Review check: diff the draft's function list against the
   original's before reading anything else.** Feedback rounds fix it reliably when the
   deleted function is pasted back into the prompt verbatim.
2. **Markdown fences survive every prompt-level ban.** All full-file drafts came back
   ```-fenced despite an explicit no-fences output contract (JSON tasks avoid this via
   constrained decoding, but .ps1/.tsx can't be grammar-constrained to "raw file"). Strip
   fences mechanically at apply time; don't spend feedback rounds on it.
3. **Emoji/typography bytes are not reproducible.** The same 🤖 came back as two different
   mojibake byte sequences in two functions of one draft; `·` and em-dashes similarly.
   Any draft that must contain specific non-ASCII characters needs those characters
   normalized at apply time — never trust the model's bytes, and never use raw emoji
   equality in code Ornith wrote without checking the literal bytes.
4. **PowerShell 5.1-isms it reliably gets wrong:** `param()` not first statement; bare
   `if` as a hashtable value (needs `$(...)`); `Join-Path` with one arg; three positional
   args to `Move-Item`; .NET method calls with unparenthesized cmdlet expressions as
   arguments. Run `[System.Management.Automation.Language.Parser]::ParseFile` on every
   PS draft before human review — it catches most of these for free.

**Pipeline-code bug found by the E2E run (not the model):** PS 5.1 strips unescaped double
quotes when passing args to a native exe — `{"a":"b"}` arrives at node as `{a:b}` — so every
extras-bearing `agent-task-db.js` event failed silently (native non-zero exit doesn't throw,
so the `try/catch` saw nothing). Fix shipped: pre-escape `"` → `\"` and check
`$LASTEXITCODE`. Same class as the ConvertTo-Json PSObject-wrapping bug above: **any
PS→node handoff of structured data must be verified at the argv level once, live, before
trusting it.**

## Running the continuous pipeline (as of 2026-07-10)

- `backend/agent-pipeline/ornith-worker.ps1 [-InstanceId <id>] [-Model ornith:9b]` — run one
  visible window per instance; instances claim atomically via per-instance
  `queue/drafting/{instanceId}/` subfolders and recover dead instances' claims at startup.
  Run all concurrent instances on the SAME model tier (single-resident Ollama).
- `backend/agent-pipeline/review-runner.ps1` — now an always-on loop (15s/2min/10min
  sleeps by outcome), NOT a Task-Scheduler repeater. The old 15-min
  `ConsumerProj-OrnithReviewRunner` scheduled task is obsolete: repoint it to launch the loop
  at logon, or launch manually. As of 2026-07-12, its review provider is swappable
  (`REVIEW_PROVIDER=ornith|claude`, defaults to `ornith`) — see the dated entry below for
  why an Ornith-approved task does not push/apply anything by itself.
- `backend/agent-pipeline/apply-runner.ps1` — new as of 2026-07-12. Drains `queue/approved/`
  and actually executes what review-runner's Ornith path only verdicted on (git
  branch/commit/push, or the SecondBrain vault-note write + `.done` marker). Always uses
  `claude -p`, regardless of `REVIEW_PROVIDER` — it's the one component with real
  file/git-write capability in this pipeline. Required alongside review-runner for an
  Ornith-approved task to ever reach `queue/done/`; running review-runner alone leaves
  approved tasks stuck unapplied.
- `backend/agent-pipeline/start-agent-pipeline.bat` — convenience launcher: one worker +
  the review loop + the apply loop, each in its own visible window.
- Oversight: **Agent Ops** page in the frontend (instances panel reads
  `agent-pipeline/instances/*.json` heartbeats via `GET /agent-tasks/instances`; task table
  reads the `AgentTask` Prisma table, mirrored best-effort by `agent-task-db.js`).
- Task sources never run dry by design: 🤖-flagged TROUBLE_LOG entries ≤4000 chars →
  state_targets pending rows → SecondBrain inbox → field-map-gap backlog (onboarded
  counties missing baseline field_map coverage). All four exhausted = idle is correct;
  no synthetic work.

## Update 2026-07-12: task-domains.json — the crash that killed review-runner on any non-consumer task

**Root cause, confirmed live:** `review-runner.ps1` picked its git working directory with
a bare `if ($task.domain -eq 'consumer') { $ConsumerRepoRoot } else { $SecondBrainDir }`.
`queue-adhoc-task.js` hardcoded every ad-hoc task to `domain: 'adhoc'` (never
`'consumer'`), and `task-sources.js`'s `nextSecondBrainTask()` — a real, currently-enabled
source, not dead code — writes `domain: 'secondbrain'`. Both fell into the `else` branch and
`Push-Location`'d into `$SecondBrainDir` (`F:\SecondBrain`, an Obsidian vault, **not a git
repository**). The very next line ran `git branch -a`, which failed with `fatal: not a git
repository`. Under `$ErrorActionPreference = 'Stop'` and a `try/finally` with **no `catch`**,
that native-command failure was a terminating error that unwound straight out of the main
`while ($true)` loop — killing the entire long-running review-runner process on the very
first ad-hoc or SecondBrain task it ever hit. Confirmed live: it crashed identically twice in
one evening, and a 21-item backlog piled up silently in `queue/review/` in the meantime with
no visible failure — the terminal window just closed.

**Fix:** `backend/agent-pipeline/task-domains.json` is now the single source of truth for
valid task domains, shared across both languages that touch it:

```json
{
  "consumer": { "workDirKind": "consumerRoot", "successCheck": "git-branch-diff" },
  "secondbrain": { "workDirKind": "secondBrainDir", "successCheck": "done-marker" }
}
```

- `queue-adhoc-task.js` gained a `--domain` flag, validated against this file's keys,
  **defaulting to `'consumer'`** when omitted (the common case — ad-hoc requests are
  almost always about this repo, not the SecondBrain vault). `'adhoc'` was never a real
  domain; it no longer exists as a value this CLI writes.
- `review-runner.ps1` reads the same file (`Get-DomainConfig`/`Get-WorkDir`) and dispatches
  **both** the working directory *and* the success check per domain, instead of one
  hardcoded git-branch-diff check applied to everything. `secondbrain` tasks are verified by
  checking whether `${task.promptContext.notePath}.done` now exists — reusing the exact
  marker convention `nextSecondBrainTask()` already reads to skip already-handled notes
  (it filters out any note where `${note.full}.done` exists). The review prompt for
  `secondbrain` tasks now explicitly instructs Claude to create that marker file once it's
  done writing/updating the vault note — previously nothing told it to signal completion at
  all, so even a correctly-routed SecondBrain task would have misfiled as blocked.
- The whole domain-resolution-through-git-and-claude section of `Invoke-ReviewPass` is now
  wrapped in a real `try/catch` (not `try/finally`): any failure — unknown domain, a git
  error, anything — routes the task to `blocked/` with the exception message as the reason,
  and the main loop keeps running. One bad task can no longer take down every task behind it.

**Consequence for the existing backlog:** every task in `queue/review/` tagged the old
`domain: 'adhoc'` will now cleanly block with `"Unknown task domain: adhoc"` instead of
crashing the loop — `'adhoc'` isn't a valid domain and never should have been. That's
correct, not a regression: those specific legacy items need manual re-triage (re-submit with
the new CLI, which will now default them correctly to `consumer`), but the pipeline no
longer dies because of them.

**Verified before landing:** `[System.Management.Automation.Language.Parser]::ParseFile`
clean on the edited `review-runner.ps1`; `node --check` clean on `queue-adhoc-task.js`; the
new `Get-DomainConfig`/`Get-WorkDir` functions isolated and run standalone against
`consumer`, `secondbrain`, and the old `adhoc` value (confirmed it now throws a clean,
catchable error instead of reaching the git call at all). Not yet verified end-to-end through
a live `claude -p` review pass — that needs review-runner actually restarted against the real
queue, which spends real tokens and can push branches to origin, so it's queued as a
deliberate follow-up rather than done unattended.

## Update 2026-07-12 (same day): review provider is now swappable, defaults to Ornith — and why that splits review from apply

**Why:** `review-runner.ps1` hardcoded `& claude -p $reviewPrompt` — every single task review spent real Claude API tokens and was rate-limited, even though task-generation/drafting was already free (Ornith). The fix isn't a simple model swap: `claude -p` does two jobs in one call today — it **reviews** the draft *and*, if it approves, it **applies** the change itself (commits/pushes a branch, or writes a vault note + marker). Ornith via `ornith-client.js` is a plain text completion with **no tool access** in this pipeline — it cannot run git, cannot write files. So making Ornith the reviewer necessarily means splitting review from apply into two separate steps.

**What shipped:**

- `$ReviewProvider` (env var `REVIEW_PROVIDER`, `ornith` | `claude`, **defaults to `ornith`**) in `review-runner.ps1`. The `claude` path is byte-for-byte the old behavior (one call, review+apply combined) — nothing changes if you set `REVIEW_PROVIDER=claude`.
- The `ornith` path sends a **verdict-only** prompt (plan + implement draft + fact-check results, explicit "you cannot run commands, produce APPROVE or REJECT: <reason> and nothing else"), via the same `req-file → node ornith-client.js → JSON response` bridge `ornith-worker.ps1` already uses (`Invoke-OrnithClient`, copied pattern, not reinvented). No `Push-Location`/git call happens on this path at all — a rejected verdict routes straight to `blocked/`, same as before.
- An **APPROVE** verdict does **not** push or write anything. The task moves to a new `queue/approved/` folder instead of `queue/done/`, tagged `reviewProvider: 'ornith'` and the raw verdict text.
- **`backend/agent-pipeline/apply-runner.ps1` is new** — a third always-on loop, same shape as `review-runner.ps1`, that drains `queue/approved/` and does the actual execution: still `claude -p`, always, regardless of `REVIEW_PROVIDER` — it's the only component with real git/file-write capability. Its prompt is narrower than the old review prompt ("this was already judged and approved, your job is to apply it, do a quick sanity check against current repo state, don't re-litigate whether it's a good idea"). Reuses the exact same `Get-DomainConfig`/`Get-WorkDir`/success-check-dispatch/defensive-`catch` machinery from the task-domains fix above — same safety guarantees, same non-crashing behavior on a bad task.
- `budget-monitor.js` (reads Claude Code's own rate-limit transcript history) is now only consulted on the `claude` review path — gating a free local Ornith call on Claude's rate-limit schedule made no sense and would have needlessly throttled it.
- **New `AgentTask` status: `approved`.** Added `reviewProvider String?` (nullable, additive) to the Prisma schema, pushed live (`npx prisma db push`, confirmed non-destructive), added the `'approved'` event branch to `agent-task-db.js` (previously any unrecognized event silently no-op'd — this would have meant "approved" tasks vanished from the dashboard's history with no record). Frontend (`agentTasks.ts`'s `AgentTask.status` union, `AgentDashboard.tsx`'s status filter array and `STATUS_BADGE` map, plus a new "Reviewer" column) updated to match — this is exactly the "status vocabulary hardcoded in 4 places" friction flagged by the same day's `/improve-codebase-architecture` pass on this feature; adding a 6th value still meant touching 4 spots by hand, that consolidation wasn't in scope tonight.
- `start-agent-pipeline.bat` now launches three windows (worker, review-runner, apply-runner). Running review-runner without apply-runner leaves Ornith-approved tasks stuck in `queue/approved/` forever — both are required for a task to reach `done/` on the Ornith path.

**Verified before landing:** both new/edited `.ps1` files parse clean
(`Parser::ParseFile`). The Ornith verdict bridge was tested live against real Ollama —
sent a real review prompt, got back a real `"APPROVE"` response matching the exact-format
instruction, first try. The `'approved'` DB event was tested live against the real Postgres
DB (`agent-task-db.js approved` on a throwaway test task, confirmed `status: 'approved'` and
`reviewProvider: 'ornith'` persisted correctly, then deleted the test row). **Not verified:**
the actual `apply-runner.ps1` loop end-to-end (needs a real Ornith-approved task to reach
`queue/approved/`, which needs review-runner running live against real drafts — queued as a
follow-up, same reasoning as the task-domains fix above), and the frontend rendering (this
worktree's `frontend/node_modules` is missing `@tailwindcss/vite` — a pre-existing gap,
unrelated to tonight's edits — so `npm run build` currently fails before ever reaching the
edited files; the TS changes themselves are minimal literal additions mirroring existing
identical patterns, low risk, but genuinely unwatched in a browser).

**Update, same night: majority-vote wired in.** The single-shot verdict above was a known-
unstable judgment call (see "qualitative judgment calls are also not stable" above — identical
prompts at low temperature have flipped verdicts before). `review-runner.ps1`'s Ornith path
now uses a new `Invoke-OrnithMajorityVote` helper — same request-file bridge as
`Invoke-OrnithClient`, but sets `mode: 'majority-vote'` and `classifyMarkers: ['APPROVE',
'REJECT']` so `ornith-client.js`'s existing (already-built, not reinvented) `majorityVote`
does the work: 3 calls at `temperature: 0.2`, requires an absolute count of 2+ agreeing real
(non-degenerate) votes, not a relative comparison.

- **Confident APPROVE** (≥2/3 agree) → `queue/approved/`, same as before.
- **Confident REJECT** (≥2/3 agree) → `blocked/`, reason extracted from a sample rejecting
  vote's `REJECT: <reason>` text.
- **No confident majority** (a split vote, or too many degenerate responses to reach the
  2-vote threshold) → **treated as REJECT, not APPROVE.** An unclear signal must never
  default to letting a task through — same "absolute count, not relative comparison"
  principle as the historical fix this doc already documents elsewhere for a different
  voting bug.
- Every task record (`approved` or `blocked`) now carries the full `ornithVotes` array (all
  3 raw votes, not just the winning one) for audit, plus a `voteSummary` string
  (`"votes: 3/3 real, tally: APPROVE=3"`) surfaced in `Write-Host` and the live log.

**Verified live:** ran the isolated bridge against real Ollama — 3/3 real votes, unanimous
`APPROVE`, `confident: true`, first try. Cost tradeoff is the expected one documented
elsewhere in this file: 3x the Ollama calls per review pass instead of 1x, worth it because
this vote gates a real state transition (task moves to `queue/approved/`, eventually a real
git push via `apply-runner.ps1`) — exactly the "worth it for any judgment call that will gate
a further, more expensive step" case this doc's majority-vote section already calls out.

## Update 2026-07-12 (same night, live): the domain-crash fix had a second, unwrapped call site

Started the full three-window pipeline live. **review-runner crashed a third time**, on the
exact same legacy `domain: 'adhoc'` task the task-domains fix above was supposed to guard
against — confirmed by directly checking the process (`Get-Process -Id <pid>` returned
nothing) and re-running the script synchronously to capture the real error:

```
Reviewing: E2E pipeline test: explain checksums
Unknown task domain: adhoc (valid: secondbrain, consumer)
```

**Root cause:** the task-domains fix wrapped the git/claude/ornith calls inside each
provider branch in a real `catch` — but `$repoRootForCheck = Get-WorkDir -Domain
$task.domain` (for the fact-checker's repo root) and `$domainCfg = Get-DomainConfig -Domain
$task.domain` (to pick `successCheck`) both ran **earlier**, before the provider dispatch,
completely outside any `try/catch`. The crash didn't go away — it moved to an earlier,
still-unwrapped call site that throws on exactly the same invalid-domain input. **Lesson:
when hardening a function against a specific throwing call, grep for every other call to the
same throwing function in that function's body, not just the one in the code path you were
staring at when you found the bug.**

**Fix:** validate the domain exactly once, immediately after the task is read (`$domainCfg =
Get-DomainConfig -Domain $task.domain`, now wrapped in its own `try/catch` that blocks the
task with the exception message and returns — before any fact-check work, before the
provider dispatch, before anything else touches `$task.domain`). The later, now-redundant
`Get-DomainConfig` call further down (right before the provider `if`) was deleted rather than
left as harmless-but-confusing dead code. `$repoRootForCheck = Get-WorkDir -Domain
$task.domain` still runs afterward but is now safe, since domain validity was already
established before reaching it.

**Verified live:** ran the fixed script synchronously against the real queue. It hit the
same legacy task, printed `Invalid domain (not crashing the loop): ... (Unknown task domain:
adhoc ...)`, wrote it to `blocked/`, slept 15s, and **moved on to the next task** (`T-073`)
— confirmed the loop survives past the point that killed it three times before. One
unrelated, non-fatal side issue surfaced in the same run — `task-db blocked exited 1
(non-fatal): Unterminated string in JSON` for that specific block event, likely the
already-documented PS5.1 argv-quoting fragility (`Invoke-TaskDb`'s `"` → `\"` pre-escaping)
triggered by this particular reason string's punctuation. Non-fatal by design (doesn't block
the loop, only means that one event didn't mirror to the dashboard) — flagged, not chased

## Update 2026-07-12 (same night): agent-task-db.js fails loud on missing DATABASE_URL

Candidate 3 from the same architecture-review pass, first half. A worktree missing
`backend/.env` (gitignored, so `git worktree add` never brings it along — confirmed missing
in 3 live worktrees) made every `agent-task-db.js` call fail identically to a transient DB
blip: one DarkYellow "non-fatal" line, easy to miss across hundreds of calls. Fixed by
printing an unmissable banner the instant `process.env.DATABASE_URL` is empty, before
`PrismaClient` is even instantiated — applied to both `agent-task-db.js` (live) and
`agent-task-db-v2.js` (the unwired consolidation candidate, for consistency). **Verified
live**: temporarily renamed the real `.env`, ran `agent-task-db.js created`, confirmed the
banner fires before Prisma's own error, restored `.env` immediately after (confirmed via
`ls` — timestamp/size match). Note: this test ran while the live pipeline was active, so any
real event during that brief window would have hit the same missing-config path too —
non-fatal by design, no lasting effect, but a real (small) blast radius worth being honest
about.

Second half of Candidate 3 (a periodic reconciliation check comparing filesystem queue depth
against `AgentTask` row counts, surfaced on the dashboard) was deliberately **not** built
tonight — queued as an adhoc task instead, framed as an early instance of the
efficiency-monitor role from `ornith-management-layer.md` rather than one-off dashboard
plumbing.

## Update 2026-07-12 (same night): queue-watchdog.ps1 — dead-process restart + capped reject-retry

Candidate 4. Confirmed live the same night: review-runner crashed three separate times with
nothing noticing except a human checking by hand — the report's own words, "a hung reviewer
leaves a task indistinguishable from not yet reviewed," happened for real, repeatedly, in one
session. `backend/agent-pipeline/queue-watchdog.ps1` is a new always-on loop (3-minute
interval, its own heartbeat file like every other pipeline process) doing two jobs, kept in
one script per the report's own "Locality: is this task actually stuck answered in one place"
framing rather than split across files:

1. **Dead-process detection.** Scans every `instances/*.json` heartbeat. A heartbeat is only
   treated as "the process is dead" when it's stale (>8 min, chosen to be longer than any
   real single-pass duration observed tonight, including a majority-vote review under Ollama
   contention) **AND** `Get-Process -Id <pid>` confirms that PID isn't actually running.
   Staleness alone is not the signal — a real, alive process can legitimately go 8+ minutes
   between heartbeat writes mid-call (heartbeats only update between passes, not during one),
   and treating "just slow" the same as "dead" would restart a perfectly healthy process
   mid-work. Matched against a small restart table (`review-runner` → `review-runner.ps1`,
   `apply-runner` → `apply-runner.ps1`, `worker-*` → `ornith-worker.ps1 -InstanceId <id>`).
   Restarting is a plain OS process launch — **never a git operation**, matching the
   efficiency-monitor boundary already fixed in `ornith-management-layer.md`.
2. **Capped reject-retry.** Scans `queue/blocked/` for tasks carrying real `ornithVotes` (the
   signal that this was a genuine Ornith majority-vote verdict, not a crash/domain-error
   block — crash-style blocks must never be blindly retried, since retrying would just
   reproduce the same crash). Below `ornithRejectCount < 2`, moves the task back to
   `pending/` (confirmed live: `ornith-worker.ps1` picks the oldest file in `pending/` by
   `CreationTime` regardless of source — no special requeue API needed, a plain
   `Move-Item`/rewrite is sufficient) and appends the rejection reason to a
   `priorRejectionFeedback` array on the task for human audit. At the cap, it's left in
   `blocked/` permanently, same as today.

**Known limitation, not fixed tonight:** the retry is **blind** — the redrafting worker does
not currently see *why* the prior attempt was rejected (`prompts.js` was not touched here).
A blind retry still helps for the case actually observed tonight (`trouble-log-t-072`
rejected for containing no real implementation, just an empty schema-finding command — a
plausible transient/degenerate-output case, matching this doc's own documented "self-heals
on a later call" pattern), but won't fix a systematically wrong approach. Wiring
`priorRejectionFeedback` into the redraft prompt is a real follow-up.

**Verified in isolation** (temp directories, zero interaction with the live pipeline's real
`instances/`/`queue/` folders): dead-process detection correctly flagged a stale-heartbeat +
confirmed-gone-PID as dead, and correctly did NOT flag a stale-heartbeat + still-alive-PID
(this session's own PID) as dead — confirming it won't false-positive-restart a merely slow
process. Reject-retry-requeue correctly cycled twice (cap=2) then correctly left the task
blocked on the third check. Wired into `start-agent-pipeline.bat` as a fourth window.

## Update 2026-07-12 (same night): queue-transitions.js / QueueTransitions.psm1 — the top-recommendation candidate, built but deliberately NOT wired in

Candidate 5, the report's own "top recommendation" — the deepest of the five, and the
riskiest to hot-swap live: it replaces the write-then-delete idiom at 8+ call sites spread
across **four currently-running processes** (`ornith-worker.ps1`, `review-runner.ps1`,
`apply-runner.ps1`, `queue-watchdog.ps1`). Explicit decision: design and verify the
primitive in both languages tonight, hold off wiring it into any live script — that's a
separate, later, deliberate call, not something that happens as a side effect of building it.

**The real bug, precisely:** every existing call site does a fresh, non-atomic write to the
destination path followed by a separate delete of the source. A crash between those two
steps can duplicate a task into two folders, or worse — since the write itself
(`[System.IO.File]::WriteAllText`/`fs.writeFileSync` directly at the final path) is not
atomic, a crash mid-write can leave a **corrupt, partially-written destination file**.

**The fix, both in `queue-transitions.js` (for `task-sources.js`) and
`QueueTransitions.psm1` (for the four `.ps1` files):** write the task content to a temp file
in the *destination* directory, then atomically create the final destination from that temp
file, then delete the source only after the destination is confirmed correct. The
destination is therefore never observable half-written — it's always either fully absent or
fully correct. The one remaining crash window (between "destination correct" and "source
deleted") can at worst leave a stale, safely-ignorable duplicate in the source folder — never
a corrupt file, and always resolvable by trusting the destination copy.

**Two real bugs the tests caught before this shipped as "verified" — worth recording exactly
because they contradict what the first draft of this primitive assumed:**

1. **JS: `fs.renameSync` does NOT throw on an existing destination.** It follows POSIX
   `rename()` semantics even on Windows (via libuv) and silently replaces whatever was
   already there. The first version of `moveTask` used a plain `fs.existsSync` check before
   the rename — which is not just wrong, it's a TOCTOU race (check and rename aren't atomic
   together). Fixed with the standard atomic idiom: `fs.linkSync(temp, dest)` (hard link,
   throws `EEXIST` genuinely atomically) then `fs.unlinkSync(temp)`.
2. **PS: the failure path leaked a temp file.** `[System.IO.File]::Move` genuinely *does*
   throw on an existing destination (confirmed live — `MethodInvocationException` wrapping
   `IOException`, unlike Node's `renameSync`), but the original `Move-QueueTask` had no
   `catch` around it, so a failed move left a stray `.tmp-*` file sitting in the destination
   folder forever. Fixed by wrapping the move in `try/catch`, removing the temp file, then
   re-throwing.

**Verified for real, not just by code review:** an 8-point test suite (fresh write, correct
mutated content on move, source removal, zero leftover temp files on success, correct-throw
on an existing destination, source untouched after a failed move, destination unchanged —
not silently overwritten — after a failed move, zero leftover temp files after a *failed*
move too) run in isolated temp directories in both languages. All 8 pass in both, including
the two that only pass *because* the bugs above were caught and fixed first.

**Not done tonight, deliberately:** actually wiring these into the 8+ real call sites. The
report's own note that this "subsumes Candidate 1's domain-check and half of Candidate 2's
mirroring hook — both become adapters at this one seam" is real, but re-architecting how the
domain-check and DB-mirror hooks compose with this new primitive is exactly the kind of
larger integration work that belongs in its own dedicated pass, not appended to a primitive
that was just proven correct in isolation.

## Update 2026-07-12 (same night): status vocabulary consolidated — one constant per language

Candidate 6. Was the same 6-value `AgentTask` status enum typed out independently in four
places: `agent-task-db.js`'s five `status: '...'` literals, `frontend/src/api/agentTasks.ts`'s
union type, and `AgentDashboard.tsx`'s filter array and `STATUS_BADGE` map. No existing
tooling in this codebase shares a literal vocabulary across the Node/CommonJS backend and the
Vite/TS frontend — confirmed by checking the established precedent: `backend/src/utils/
propertyType.js` (ADR-0012's canonical property-type vocabulary) is **not** mirrored into the
frontend either, it's just consumed as a plain string there. So this consolidates within each
language rather than inventing new cross-stack tooling:

- **Backend:** new `agent-pipeline/agent-task-statuses.js` exports `AGENT_TASK_STATUSES`
  (the 6-value array). `agent-task-db.js` and `agent-task-db-v2.js` (the unwired Candidate 2
  consolidation) both destructure it into named `STATUS_*` constants and use those instead of
  bare string literals throughout.
- **Frontend:** `agentTasks.ts` exports `AGENT_TASK_STATUSES` (as a readonly tuple, `as
  const`) and derives `AgentTaskStatus` from it (`typeof AGENT_TASK_STATUSES[number]`).
  `AgentTask.status` is now typed as `AgentTaskStatus` instead of a repeated union literal.
  `AgentDashboard.tsx` imports both — the filter dropdown maps over `AGENT_TASK_STATUSES`
  directly instead of its own hardcoded array, and `STATUS_BADGE` is now typed
  `Record<AgentTaskStatus, string>` instead of `Record<string, string>` — so TypeScript
  itself enforces every status has a badge; a future 7th status missing from the badge map
  becomes a compile error, not a silently-unstyled dashboard row.

**Verified live** (backend): ran a full real transition sequence (`created` → `claimed` →
`ready-for-review` → `approved` → `done`) through the edited, live-called `agent-task-db.js`
against the real Postgres DB with a throwaway test task, confirmed the final row landed at
`status: 'done'` with `branch`/`completedAt` set correctly — the shared-constant refactor
didn't change any behavior. Test row cleaned up.

**Not verified by compiler** (frontend): this worktree's `frontend/node_modules` is still
missing `@tailwindcss/vite` (the same pre-existing, unrelated gap noted in the review-provider
update above), so `tsc`/`vite build` can't run here at all right now. The edits themselves
were re-read carefully after writing — `STATUS_BADGE`'s object keys visually match all 6
`AgentTaskStatus` values exactly — but this is genuinely "checked by eye," not "checked by
the type checker," and should be confirmed with a real build once the dependency gap is
fixed.

**Not done tonight, deliberately:** a real Prisma enum for `AgentTask.status` (currently a
bare `String` column, so nothing at the DB layer enforces the 6-value contract either) —
flagged in `agent-task-statuses.js`'s own comment as the genuine next step toward end-to-end
enforcement, not attempted here.

## Update 2026-07-12 (~11 hours into the unattended run): a real self-inflicted collision, found and fixed

Checked on the pipeline after ~11 hours unattended. Initial read of `queue/done/` looked like
the first genuine end-to-end success (`state-target-sc_greenville`, `reviewProvider: 'ornith'`,
a real 2/3 `APPROVE` majority) — **that read was wrong**, caught on closer inspection before
being reported as fact.

**Root cause: all of the same night's Candidate 1-7 edits were made directly inside
`_merge-dashboard-worktree/consumer-project` — the exact directory `$ConsumerRepoRoot` points at for
every git operation `review-runner.ps1`/`apply-runner.ps1` perform.** This is precisely the
hazard `project_ornith_agent_pipeline_resumed`'s memory already warned about avoiding
("NEVER point automation at the live session's own working tree"), and it was violated by
doing architecture-review work directly in the pipeline's own operating directory instead of
a separate worktree. Consequence, confirmed live: `sc_greenville` was genuinely approved by
Ornith, but `apply-runner`'s `git checkout main` step failed —
`error: Your local changes to the following files would be overwritten by checkout` — because
uncommitted editorial changes (plus `node_modules/.prisma` churn from an earlier `prisma
generate`) were sitting dirty in that same tree. **No branch was ever pushed** (confirmed:
`git branch -a | grep -i greenville` returned nothing).

**A second, independent bug this exposed:** `queue-watchdog.ps1`'s reject-retry-requeue
checked only "does this blocked task have `ornithVotes`" to decide it was safe to blindly
retry. Since the apply-failure above still carried `ornithVotes` from `sc_greenville`'s
genuine earlier approval, the watchdog misclassified an apply-time collision as a review
rejection and requeued it for a pointless redraft — burning a real retry cycle on a problem
no amount of redrafting could ever fix. `state-target-mn_hennepin` hit the identical collision
twice and is now **permanently stuck at the retry cap for the wrong reason** (not because
Ornith judged it poorly twice, but because the working tree was dirty twice).

**Fixes, both landed:**

1. **The uncommitted editorial changes were committed** (`2a121d4d`), clearing the tree of my
   own tonight's work. Four files remained modified after that commit and were deliberately
   left uncommitted rather than folded in blind: `Docs/state_targets.csv`,
   `backend/counties/sc_greenville/index.json`, `backend/python_services/enrichers/
   _hud_adapter.py` (a real, small, coherent MN Hennepin metro override), and
   `backend/python_services/enrichers/scraper_registry.py` (a real `sc_greenville_tax` stub
   entry) — these are genuine partial pipeline output from approved-but-never-fully-applied
   tasks, never reviewed through the intended branch/PR flow, and committing them silently
   into an unrelated "architecture tooling" commit would misrepresent what that commit
   contains. Left for a deliberate human decision (finish them properly on their own branch,
   or discard and let the tasks redraft cleanly). The `node_modules/.prisma/*` files were left
   untouched entirely — regenerable build output, never should have been dirty-tracked.
2. **`blockedStage` tagging closes the watchdog bug.** `review-runner.ps1` now tags every
   block it writes from the Ornith path (`REJECT` and `INCONCLUSIVE`, the two branches that
   carry `ornithVotes`) with `blockedStage: 'review'`. `apply-runner.ps1` now tags both of its
   own blocked-writing branches `blockedStage: 'apply'`. `queue-watchdog.ps1`'s eligibility
   check changed from a negative check (`-not $task.ornithVotes`) to a positive allowlist
   (`$task.blockedStage -ne 'review'`) — only retry a task explicitly confirmed to have been
   blocked *by review*, never inferred from the mere presence of old verdict data. A positive
   allowlist over a negative exclusion list, deliberately: a negative check silently
   mis-includes anything that doesn't match its specific exclusion, a positive check silently
   excludes anything uncertain — the safer default here, since the cost of skipping a valid
   retry is small and the cost of blindly retrying an unfixable apply failure is a wasted
   redraft cycle (or worse).

**Verified in isolation**, three scenarios: (1) a genuine review rejection — correctly
eligible for retry; (2) the exact bug case, `ornithVotes` present but `blockedStage: 'apply'`
— correctly **not** eligible; (3) a legacy blocked file with no `blockedStage` field at all
(exactly `mn_hennepin`'s current real state) — correctly **not** eligible, fails safe rather
than crashing on the missing field. All three pass. Not yet re-verified against a second real
live collision (would need one to occur again, which the tree-cleanliness fix should now
prevent in the first place).

**Lesson for next time, stated plainly:** never edit files inside a directory an unattended
automation loop treats as its own git working tree, even for "just docs and unrelated
tooling" — the loop doesn't know the difference between your edits and its own, and a
`git checkout` doesn't care whose changes it would overwrite.
