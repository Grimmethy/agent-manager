# AGENTS.md

Repo-specific guidance for coding agents working in `agent-manager`.

## First principle: build the mechanism, don't hand-fix the instance

`agent-manager` is a system for making a pipeline do work autonomously. When you find a
task, a hub, or a queue that is stuck, the job is **almost never** to unstick that one
item by hand — it is to build (or extend) the pipeline mechanism that unsticks it and
every future item like it, then let the pipeline run.

- A stuck coordinator hub → a watchdog sweep that detects and re-routes that failure
  class (see `coordinator-sweep.js`, `blocked-drain.js`, `decompose-loop-autoroute.js`),
  not a manual requeue.
- A task the local model can't land → a routing rule (`decompose-pass.js`,
  `file-decompose-plan-pass.js`, product_spec), not you writing the code.
- A bad prompt / missing grounding → fix where `promptContext` is built, not the one task.

Only act on a single item directly when the user **explicitly asks** for that item to be
handled (and even then, prefer routing it through a dashboard `/api/task/...` endpoint or
an existing sweep). Hand-editing `queue/` or committing a fix straight to a stuck task's
branch is the exception that needs a stated reason, not the default move. If no mechanism
fits, the deliverable is a proposal for one — surface it, don't paper over it.

## Second principle: build for after-the-fact audit, not just correctness

Grimmethy has said this directly, more than once: *"you know how much I love being able
to audit the work"*, and *"I'd like you to investigate what the actual [X] could be rather
than making arbitrary [numbers]"*. Treat this as a standing preference, not a one-off ask
— it shapes how a fix should be built, not just whether it works:

- **A fix that only works silently isn't finished.** When you build something that makes a
  real-time decision (a threshold, a retry, a gate), also give it a durable, inspectable
  trail of *why* it decided what it decided — a persisted log line, a stamped field on the
  task/record itself, a real DB column — not just the correct behavior with no evidence
  left behind. Concrete precedent: `local-tool-client.js`'s context-budget check
  (`logContextAudit` → `instances/context-budget-audit.log`, 2026-09-06) logs every
  evaluation, not just the ones that trigger, specifically so a later investigation reads a
  file instead of re-deriving turn-by-turn state from a chat transcript's own visible text.
- **Ground a threshold/limit in a real measurement, never a round guess.** Before picking a
  number (a token reserve, a retry cap, a timeout), find the real data first — query
  `model-stats.db`, read the actual error text, check what the underlying system really
  reports (e.g. Ollama's own `prompt_eval_count` is ground truth; a `chars/4` guess is not)
  — and say in the comment where the number came from. If a similar-sounding stat is
  missing (e.g. a whole call class has NULL token columns because nothing ever threaded
  them through), fix that gap too, don't work around it with a guess.
- **A "why did X happen" question deserves a real answer, not a plausible-sounding one.**
  When you can't fully explain an observed behavior from available evidence, say so
  explicitly rather than asserting a root cause you haven't verified — and treat the gap in
  evidence itself as something worth closing (usually via the logging point above), not
  just something to route around this one time.

## Third principle: "[[ghost-in-the-machine]]" — a model call, or an agent hand-editing state, is a last resort

Named and tracked as its own concept row (`concepts.json`, `concept-ghost-in-the-machine-0dbeea`
— read it with `require('./src/concepts.js').getConceptTimeline(pipelineDir, 'concept-ghost-in-the-machine-0dbeea', ...)`
before extending this pattern; it has the fuller incident history). The
[[ghost-in-the-machine]] is the AI agent — or a human operator — doing by hand what a
deterministic mechanism should do every time. It has two forms, and both are the ghost:

- **A model call standing in for a mechanical step.** Asking the model to "move these named
  symbols verbatim," "apply this exact rename," "run this fixed validation command" — or
  nudging its prompt so it is *more likely* to get such a step right — trusts a stochastic
  process to reliably do, every time, something code could do with 100% certainty.
- **An agent or operator editing pipeline state by hand.** Requeuing a stuck task, clearing
  a flag, hand-committing a one-off fix, re-filing a plan yourself (see the First
  principle). Requeuing is the canonical example — it "works" once and the pipeline learns
  nothing.

The distinction that matters:

- A **[[ghost-in-the-machine]] fix** makes the failure less likely without removing the
  model or agent from the step (a better instruction, a pointer to a tool, a stronger
  warning; a manual requeue of the one stuck task). It still trusts a stochastic or manual
  process to reliably do, every time, something that could instead be done with 100%
  certainty by code.
- A **systematic fix** removes the model or agent from the step entirely wherever the step
  is actually deterministic — leaving only the genuinely judgment-requiring residue (if
  any) — and makes the **pipeline itself own the outcome, including failure and re-entry**.
  An automatic system has to handle a task *failing* and *getting back into the flow*, not
  just the happy path.

**When authoring a task shape, a prompt, or a plan/implement pass, ask first: is the thing
I'm about to ask the model to do actually mechanical?** A "move these named symbols
verbatim," "apply this exact rename," "run this fixed validation command" step is not a
judgment call — writing a prompt asking the model to plan or narrate it is optimizing the
wrong half of the problem. Concrete precedent for both the win and the trap:

- `local-draft.js`'s `tryDeterministicScriptExtractEdit` + `script-extract.js`'s real
  V8-parser oracle skip the plan/implement passes ENTIRELY (zero model calls, byte-exact,
  machine-verified) for a file-decompose script-extract move once its symbols resolve
  unambiguously — `review-task.js` has a matching deterministic auto-approve gate so the
  saving isn't undone at review either. Before this landed, the exact same task shape
  reliably burned full LLM plan+implement attempts hand-rolling a worse version of a check
  that already existed (`scripts/extract-core-ui.js`) — confirmed live: 11 of 26 symbols
  in one such move got misreported "not found" by the model's own scanner when every one
  resolved cleanly via the real tool.
- **A deterministic-eligibility check must be a standing mechanism, not a one-time
  stamp.** `file-decompose-to-hub.js`'s `validatePlan()` only computes eligibility ONCE,
  when a hub's children are first materialized. A child minted before its symbols happened
  to resolve cleanly never got a second chance — confirmed live 2026-09-07: a stuck move
  task blocked "Plan pass degenerate: truncated" across 6 draft cycles / ~3 hours even
  though its own symbols resolved cleanly the whole time, simply because nothing ever
  re-checked. `decompose-move-determinism-backfill.js` (a watchdog sweep, same cadence as
  `file-decompose-to-hub.js`'s own sweep in `queue-watcher.sh`) is the fix, and the pattern
  generalizes: **when you add a deterministic-eligibility flag, also ask what re-evaluates
  it for a task that already exists** — a sibling task landing, a file edited by hand, or a
  tool getting fixed can all flip eligibility after creation, and a check that only ever
  runs once silently stops protecting anything the moment the world changes.
- **Failure recovery is a mechanism, not a requeue.** When a *gate bug* (not the model)
  blocks a task, blind retries reproduce it every pass until the retry budget burns out and
  the task dead-ends in `blocked/` or `needs-clarification/` → `leave-for-human` —
  "recoverable" only by an operator clicking requeue, which teaches the pipeline nothing.
  Build the deterministic re-admission instead: `needs-clarification-triage.js`'s D/E/F/G
  buckets ("a fix shipped → re-admit exactly what the old bug stranded") and
  `reject-retry-check.js`'s forbidden-path re-admission (2026-09-09: a block that named one
  of the task's own declared edit targets → clean-slate re-admit, bounded by a one-shot
  `forbiddenPathReadmitted` stamp). Every new gate or behavior fix that could have wrongly
  exhausted tasks carries its paired re-admission signature, or those tasks stay dependent
  on a human to bring them back.
- For the residue that genuinely isn't deterministic-eligible (yet, or ever — a
  flask-blueprint/.py move, an ambiguous symbol), don't leave the model's prompt asking it
  to re-derive work the request already fully specifies. `prompts.js`'s
  `decomposeMoveDirective` (and the sibling `brainDumpDirective` just above it) is the
  pattern: tell the model explicitly "the request already IS the plan, don't re-list a
  step per item" rather than silently hoping a generic "write a numbered PLAN" instruction
  doesn't provoke a runaway, unbounded re-enumeration. This is itself still only a
  [[ghost-in-the-machine]] mitigation, not a systematic fix — reach for it only for the
  residue a real deterministic check has already ruled out, never as a substitute for
  building that check.
- Other real deterministic short-circuits already in this codebase, worth checking before
  writing a NEW model-driven pass for something that resembles them:
  `runStalenessFastpath` (`local-draft.js`, re-runs a staleness rule deterministically
  instead of asking the model to re-judge it), `staticCheckMove`/
  `staticCheckScriptExtractMove` (`file-decompose-to-hub.js`, AST/V8-parser-verified
  symbol resolution), `deterministic-recheck-registry.js` (the seam a plugin's own
  scanner rules re-run through).

**Retroactive audit is part of this too, not just new code.** When you land a
[[ghost-in-the-machine]] mitigation (a prompt nudge, a closed list, a stronger warning, a
one-off requeue) for a recurring failure, name in the writeup whether it's actually masking
an underlying deterministic step or a missing recovery mechanism — if it is, that's a
`writeSideFindingInbox()` entry tagged `conceptId: 'concept-ghost-in-the-machine-0dbeea'`,
not a closed loop.

**This concept audits itself.** `requeue-attribution.db`'s `actor` column records whether
each requeue was a pipeline mechanism or an operator/agent hand-fix, and
`reject-retry-check.js` / `needs-clarification-triage.js` file a `ghost-debt` side-finding
(deduped by failure signature, tagged to the concept) whenever a task reaches a human-only
escalation with no re-admission mechanism matching. The concept card's telemetry line and
its timeline are the live scoreboard — a debt entry stops recurring once you build the
missing deterministic recovery.

## Concept research: give a named topic the same treatment, tag it as it flows through

Twice this session (2026-09-06), a narrow topic (chat-context-trimming, then
web-search-capability) got the same real treatment: a background research fork surveys
several other projects' approaches, deep-dives each, and files the findings via
`writeSideFindingInbox()`/`side-finding-sweep.js` into `brain-dump.json`. Grimmethy asked
for this to become a tracked, repeatable pattern — `src/concepts.js`'s `concepts.json`
registry (Concept Chart, dashboard tab in progress) is the persistent row for each named
topic, with a self-reported (deliberately unverified) build-from-scratch-vs-adapted
tally and an on-demand timeline over the data below.

- **Before launching a concept-directed research fork**, create (or reuse — it's
  idempotent on the slugified name) the concept's row first:
  `require('./src/concepts.js').createConcept({name, description}, pipelineDir,
  {createdBy: 'organic'})` if the topic has no row yet, `{createdBy: 'manual'}` when a
  human names it explicitly via the dashboard. Pass the resulting `id` into the fork's
  prompt.
- **Every `writeSideFindingInbox()` call the fork makes** should include that
  `conceptId` in its options. This isn't just bookkeeping — `side-finding-sweep.js`
  scopes its dedup comparison to matching `conceptId` (both-null still counts as a
  match), specifically because two research batches on different topics can otherwise
  false-positive-merge over shared boilerplate phrasing (root-caused live 2026-09-06:
  "Open WebUI" and "Synthesis: recommended path..." findings from the web-search batch
  wrongly absorbed into unrelated chat-context-trimming entries).
- **When the fork finishes**, call `recordConceptResearch(pipelineDir, conceptId)` once
  (bumps `researchForkCount`, promotes `status` from `open` to `researched`) — same
  verification step as confirming the brain-dump entries actually landed.
- **A "concepts needing research" autonomous task source is explicitly deferred.**
  Concept creation and research-triggering stay human-initiated for now — the same risk
  shape as the `arch_import` premise-check incident (an unverified discovery-source claim
  splitting into children before anyone checked it) applies just as much to a pipeline
  deciding on its own what's worth researching.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`github.com/Grimmethy/agent-manager`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) — no repo-specific overrides. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` (to be created) and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Working directory: never edit this checkout directly

This repo is self-hosting: `AGENT_MANAGER_REPO_ROOT` for the running pipeline points at
this exact checkout, and `apply-task.js`'s git-branch-diff flow calls
`gitRunner.resetToMain()` (`src/git-runner.js`) on it before every single task apply --
`git stash push -u` + `git checkout <mainBranch>` + a push-then-hard-reset onto
`origin/<mainBranch>`. That runs continuously while the pipeline is live, on whatever
schedule the queue produces approved tasks, with no way to know in advance when the next
one lands.

**A manual or agent-driven fix made directly in this checkout will get swept up in the
next `resetToMain()`** the moment it isn't already pushed:
- An uncommitted edit gets auto-stashed (recoverable via `git stash list`, but silently
  parked, not lost) -- confirmed live 2026-08-26, this exact fix restored from `stash@{0}`.
- A real local commit on `mainBranch` that hasn't reached `origin` yet is now pushed
  forward automatically rather than discarded (fixed 2026-08-27, see git-runner.js's own
  comment) -- but that's a safety net for a slip, not something to rely on by default: it
  still means the checkout can switch branches, stash your working tree, or move
  out from under whatever you were mid-edit on, with zero warning.

**Do the fix in a separate worktree or clone instead** (`git worktree add
../agent-manager-manual-fix -b my-fix origin/master`, or an entirely separate clone), then
commit and push a branch from there. That checkout is physically immune to anything
`resetToMain()` does to the pipeline's own repoRoot. Only reach for editing the shared
checkout directly when there's a specific reason to (e.g. inspecting exactly what state
the live pipeline is in right now) -- and treat anything you leave there as ephemeral,
never as the durable copy of the fix.

**If you're doing rapid, live, in-checkout iteration anyway** (the actual mode of a long
Claude Code session directing successive small fixes against the running pipeline, not a
one-off manual edit) -- a worktree per fix is real overhead against that flow. What
worked, confirmed across half a dozen real wipes in one session (2026-09-05): treat every
self-contained, tested unit of work as a race against the next `resetToMain()` --

- Write the change, run its real tests, and **commit + push immediately** once they pass.
  Never let an edit sit uncommitted while you keep testing, keep exploring, or write the
  next piece -- that gap is exactly when a reset lands.
- Before re-doing anything that looks wiped (`git status` unexpectedly clean, a file you
  just wrote is "not found," a `require`/`import` fails on a module you swear you just
  created), **check `git stash list` first.** The auto-stash documented above is real and
  already confirmed live -- most "wipes" are a stash entry away, not actually gone; `git
  stash pop` costs one command against re-deriving and re-typing the same fix.
- When a wipe is confirmed (nothing in the stash, or a commit that legitimately never
  landed), just redo the lost piece from what's still in your own context and commit
  again immediately -- don't spend time diagnosing which specific `resetToMain()` call
  did it, the mechanism above already explains why it happened.
- **A single logical change spanning several file edits can get split across MULTIPLE
  stash entries** if resets land back-to-back while you're still mid-sequence (confirmed
  live 2026-09-05: one change touching 6 files hit 3 separate resets before it was done,
  landing across `stash@{0}`, `stash@{1}`, and `stash@{2}` simultaneously, each holding a
  disjoint subset of the files). Popping only the newest one silently ships a fix missing
  the rest. Before popping anything, run `git stash list` and `git stash show -p
  stash@{N} --stat` on every entry from *before* your current work started -- if more than
  one touches files you were just editing, pop them **oldest first** (highest index first;
  `git stash pop stash@{N}` names a specific entry without disturbing the others) so each
  applies cleanly on top of the last, then re-run `git status`/`grep` for your own marker
  text to confirm the full change landed before testing or committing.
- A "changed on disk since you last read it" notice on a file you just edited is not
  automatically a wipe -- it also fires on your own just-applied edit. Don't assume data
  loss from the notice alone; `grep` for a string unique to your edit (a comment, a new
  function name) to check before spending time on recovery that isn't needed. If it comes
  back empty, *then* treat it as a real wipe and check `git stash list`.

## queue/ is live pipeline state, not a source tree -- never hand-edit it

`queue/*/*.json` (gitignored) is mutated continuously by `worker-1`, `reviewer`, and
`watchdog` while the pipeline is live -- moving a task file between state directories,
rewriting it in place, isn't a safe filesystem op the way it looks; go through the
dashboard's `/api/task/...` endpoints (`python/dashboard/app.py`) instead, which encode
real invariants a hand-move skips:

- **Requeue** (`POST /api/task/blocked/<id>/requeue`) checks the new `blockedReason`
  against `priorRejectionFeedback` first (`_repeated_blocker_match`) and 409s if this looks
  like the same underlying problem recurring -- `{"force": true}` overrides it, but only
  reach for that once you've actually diagnosed why it'll be different this time, not as a
  reflex unblock.
- **Requeue carries the OLD `promptContext` forward, verbatim** -- it resets status/history,
  not the task's material. If the actual fix is downstream of how `promptContext` gets
  built (see the grounding-freshness gotcha below), requeuing alone reproduces the exact
  same failure. The task needs to not exist at all -- delete the file outright -- so the
  next scan of its source (a candidates doc, an arch-discovery pass, whatever generated it)
  builds it fresh. Confirm the underlying finding is still open before deleting (e.g. still
  `Strength: Strong` in the relevant `Docs/*_CANDIDATES.md`) -- deleting a task whose source
  finding has since been resolved just discards it.

## Grounding freshness: promptContext is frozen at creation, not live

`nextCandidateFulfillmentTask()` (`src/task-sources.js`) snapshots each named file's
content into `promptContext.fetchedFiles` once, at task-creation time. Two different
consumers read that snapshot with two different freshness guarantees, and conflating them
costs a wasted retry cycle:

- **`local-draft.js`** (the plan/implement passes) reads `promptContext.fetchedFiles`
  directly, as frozen -- it never re-fetches. If a sibling candidate touching the same file
  merges in while this task is still queued, the draft is being written against code that
  no longer exists.
- **`get-grounding-source.js`** (the review/fact-check pass) re-reads each `fetchedFiles`
  path's *current* content from `repoRoot` at review time (fixed 2026-08-27 -- see
  `refreshFetchedFileContent`), so review always fact-checks against reality regardless of
  how stale the snapshot is.

The practical effect: a task can get correctly re-rejected at review even after a perfectly
good draft, if a sibling branch changed the target file between draft and review -- that's
not a bug, it's a real conflict, and the fix is a fresh draft (delete + let it regenerate),
not a requeue (which reuses the stale snapshot the draft was already written against).

Snapshotted files over ~8000 chars get windowed, not sent in full
(`windowFetchedFileContent`, fixed 2026-08-27): it centers the window on the first anchor
that matches, strongest first -- (1) a `Snippet:` field (real code text a scanner/reviewer
read, written deterministically by `applyArchDiscoveryCandidates` and matched fuzzily, so
it survives whitespace-only reformatting); (2) the first backtick-quoted symbol from the
candidate's own Problem/Solution prose that's a real substring of the file; (3) a "line
NNN" citation from that prose. It falls back to flat truncation-from-byte-0 only when none
of the three match. A candidate doc entry that describes its target in prose without a
`Snippet:` field and without ever quoting the actual symbol/snippet degrades to the old
blind-truncation behavior for a large file -- when hand-writing or editing a candidates doc
entry, include a `Snippet:` fenced block (or at least quote the real identifier).

## Task sources: built-ins here, hygiene sources in a separate plugin

The `observability_*`, `performance_*`, `function_length_*`, `arch_*` and `unused_export`
task sources moved (2026-08-27) into the out-of-tree **agent-manager-hygiene** plugin,
loaded via `AGENT_MANAGER_REGISTER_PATH` (comma-separated for more than one plugin;
`src/config.js` `ensureRegistered()` `require()`s each once). The live `agent-manager.env`
points it at `/media/wok/model-cache/agent-manager-hygiene/register.js`.

- **`docs/PLUGIN_API.md` is the contract** for what a plugin may `require` from
  `agent-manager/src/*`. `src/plugin-api.test.js` fails in THIS repo's CI if one of those
  exports is removed — update both together.
- **No core `src/*.js` file names a plugin task source.** Per-source behaviour is read off
  the registration (`directToMain`, `reviewGuidance`, `reportClass`, `harnessSearch`, …) or
  a dedicated registry (`deterministic-recheck-registry.js`). `src/no-plugin-source-names.test.js`
  enforces it; `arch-discovery-structcheck.js` is the one allowlisted exception (see PLUGIN_API.md).
  The candidate-fulfillment SDK is `src/sdk/candidate-fulfillment.js` (ADR-0022 Stage D).
- The deterministic scanner rules (`observability`/`performance`/`function-length` scans +
  `scan-utils.js`) live in the **plugin** as of ADR-0022 Stage C. `staleness-fastpath.js`
  re-runs a rule via the `registerDeterministicRecheck` seam
  (`src/deterministic-recheck-registry.js`) — it holds no detector code and no source names.
  Core imports nothing from a `src/maintenance/` directory; that directory is gone.
- `arch-discovery-structcheck.js` and `arch-import-fetch.js` **stay here** (worker
  subprocess by hardcoded path; shared repo-search harness).
- `python/build_graph.py` **stays here** — it produces `graph.json` / `community-coverage.json`
  that the plugin's `arch_discovery` reads read-only. Keep the output shapes stable.
- The dashboard's Job List / Pipeline Map and `npm run drift-scan` are registry-driven
  (`node src/task-sources.js --dump-topology`), so plugin sources show up automatically and
  drift-scan stays clean across the boundary. When editing a plugin source, run
  `drift-scan` with `AGENT_MANAGER_REGISTER_PATH` set (the watchdog does).
- **Editing a plugin source:** clone/worktree `agent-manager-hygiene` separately (same
  "never edit the live checkout" rule as this repo — `apply-task.js`'s `resetToMain()` and
  the plugin's own `node_modules/agent-manager` symlink both point at the live tree). Its
  `npm test` runs against that symlink.
