# Spec: Ghost-in-the-Machine telemetry & debt register

Status: proposed · Concept: `concept-ghost-in-the-machine-0dbeea` · Own PR (separate from the
infra-error / forbidden-path fixes)

## Why

The [[ghost-in-the-machine]] principle (AGENTS.md, third principle) now covers **any agent
or operator doing by hand what a deterministic mechanism should do** — with **requeuing a
stuck task as the canonical example**. Today the pipeline has no way to see whether it is
winning or losing that fight:

- **Requeue Attribution (`requeue-attribution.js`) never sees a manual requeue.** It fires
  on `blocked-drain`, `needs-clarification-triage`, `context-trim-sweep`,
  `decompose-loop-autoroute` — every *pipeline-mechanism* requeue. The one requeue type
  that **is** the ghost — a human clicking Requeue in `api_task_requeue` — is not recorded
  at all. So the `requeue_causes` table is a biased sample that structurally cannot answer
  "how often did the pipeline recover itself vs. how often did a person hand-fix it?"
- **A failure class with no automated recovery leaves no trace.** When
  `needs-clarification-triage.js` exhausts buckets A–G and stamps
  `ncTriageDecision: 'leave-for-human'`, or `reject-retry-check.js` escalates an exhausted
  task to `needs-clarification/`, that means *"this class currently requires a human to
  recover."* Nothing accumulates those into a backlog of re-admission mechanisms still to
  build. PR #117's forbidden-path re-admit bucket is exactly the kind of fix that should
  have been driven by such a backlog.

This spec adds both, reusing existing infrastructure (`requeue-attribution*`,
`writeSideFindingInbox`, the Concepts tab, `getConceptTimeline`). No new sweeps, no new
model calls.

---

## Part A — record every requeue's actor

### A1. `actor` dimension on `requeue_causes`

`src/requeue-attribution-db.js`: add one column + index. SQLite fills existing rows from
the default, so the backfill is free:

```sql
ALTER TABLE requeue_causes ADD COLUMN actor TEXT NOT NULL DEFAULT 'pipeline-mechanism';
CREATE INDEX IF NOT EXISTS idx_requeue_causes_actor ON requeue_causes(actor);
```

Fixed vocabulary (DSPy-Signature style, same as `CAUSE_CATEGORIES`):

| `actor` | meaning |
|---|---|
| `pipeline-mechanism` | a watchdog sweep requeued it with no human in the loop (all current writers) |
| `operator-manual` | a human clicked Requeue / Reopen / answered a design-decision picker |
| `agent-session` | a Chat-panel / assistant tool initiated the requeue (reserved; see Open Questions) |

`record-cause` payload gains an optional `actor` (defaults to `pipeline-mechanism` when
absent, so every existing caller is unchanged).

### A2. `classifyRequeue` gains an `actor` param + a CLI entrypoint

`src/requeue-attribution.js`:

- `classifyRequeue(task, { ..., actor = 'pipeline-mechanism' })` — threads `actor` into
  `recordRequeueCause({ ..., actor })`. Every current call site keeps the default.
- New CLI dispatch so the Flask (Python) side can reach it, mirroring
  `requeue-attribution-db.js`'s own `record-cause <payloadPath>` shape and
  `claude-client.js` / `arch-import-fetch.js`'s "invoked as a subprocess" pattern:

  ```
  node src/requeue-attribution.js classify <payloadPath>
  ```

  `payload = { task | taskFile, reasonHint, requeueWriter, actor, blockedStage? }`. Runs
  the full deterministic-first classification (signature + burn-rate escalation +
  `recordLink`), same as an in-process call. `stdout` = `{ signature, category }` JSON.

`src/requeue-attribution-client.js`: `recordRequeueCause` gains `actor`; new read helper

```js
getActorRollup({ sinceMs, bucketMs }) // -> { totals: {actor: count}, series: [{ at, actor, count }] }
```

a plain read-only `node:sqlite` query over `requeue_causes` grouped by `actor` and an
optional time bucket — the burn-rate helper's exact conventions.

### A3. New Python wrapper + the three unrecorded call sites

`python/dashboard/requeue_attribution_client.py` — NEW, mirrors `grep_fetch_client.py`
(env-override child process, best-effort, never raises into a request):

```python
def classify_requeue(task: dict, *, reason_hint, requeue_writer, actor): ...
```

writes a temp payload, `execFile`s `node src/requeue-attribution.js classify`, swallows all
errors.

Call it with `actor="operator-manual"` from every human-initiated requeue in
`python/dashboard/app.py`:

| site | line (approx) | note |
|---|---|---|
| `api_task_requeue` | 2988 | Job Status Blocked/Done tab button, Brain Dump "Reopen" |
| `api_task_answer` (design-decision picker → adhoc/) | ~3130 | the multiple-choice / Other answer path |
| `api_discuss_end` requeue branch | ~3171 | ending a Discuss session that resolves a hold |

Each fires **after** the file move succeeds, best-effort. `reason_hint` = the note already
written into the task's history (`"manually requeued from {state}/"`, the picked answer,
etc.) — no new signal-gathering, same contract as the existing JS call sites.

### A4. Backfill

Free: the `ALTER TABLE ... DEFAULT 'pipeline-mechanism'` stamps every historical row
correctly (manual requeues were never recorded, so 100 % of existing rows genuinely are
mechanism). No separate backfill script.

### A5. Surface it on the concept

`/api/concepts` (or a dedicated `/api/concepts/<id>/ghost-telemetry` — decide at
implementation): for `concept-ghost-in-the-machine-0dbeea`, attach

```json
{ "ghostTelemetry": {
  "window": "30d",
  "handFixes": <operator-manual + agent-session count>,
  "mechanismRecoveries": <pipeline-mechanism count>,
  "series": [ { "at": "...", "handFixes": n, "mechanismRecoveries": m } ]
}}
```

`renderConceptCard` (`templates/index.html`, ~812) special-cases this concept id to render
a one-line stat + a small sparkline: **"hand-fixes N · mechanism recoveries M (30 d)"**.
The goal is a trend the user can watch — is the ratio moving the right way as re-admission
mechanisms land?

---

## Part B — ghost-debt register

### B1. What counts as a ghost-debt event

A point where the pipeline concluded *"a human must recover this; no automated path
exists"*:

| site | file:symbol |
|---|---|
| all triage buckets missed → `leave-for-human` | `needs-clarification-triage.js` ~489 (`task.ncTriageDecision = 'leave-for-human'`) |
| retry cap exhausted → escalate to `needs-clarification/` | `reject-retry-check.js` ~224 (adhoc exhaustion branch) |
| `classifyBlockedTask` non-retryable → immediate escalation | `reject-retry-check.js` ~203 |

Explicitly **not** debt: a bucket/​signature that *did* match and re-admitted the task
(bucket D/E/F/G, PR #117's forbidden-path re-admit). Those are the mechanism working.

### B2. `src/ghost-debt.js` — NEW helper

```js
fileGhostDebt({ task, reasonText, site, pipelineDir })
```

- `category = structuredSignalCategory(task, reasonText) || 'unclassified'`
  (`require('./requeue-attribution.js')`).
- `signature = buildSignature(category, reasonText)` — reuses the exported Rollbar-style
  normalize-then-hash, so debt is grouped **by failure class, not per task**.
- Dedup / anti-spam: `queue/ghost-debt-state.json` = `{ [signature]: lastFiledAtISO }`.
  Refile a still-open signature at most once per `GHOST_DEBT_REFILE_DAYS` (default 7) so an
  unaddressed debt stays visible without spamming the inbox every watchdog tick. Also stamp
  `task.ghostDebtFiled = true` (mirrors PR #117's `forbiddenPathReadmitted`) so the same
  task never refiles within a run.
- `writeSideFindingInbox(`
  `  { title: `Ghost debt: "${category}" failure class has no automated recovery`,`
  `    body: <reasonText + site + task.id + "No re-admission bucket/signature matched. `
  `           A human must requeue this class until a deterministic recovery path exists. `
  `           Signature: ${signature}."> },`
  `  { source: site, taskId: task.id, stage: 'ghost-debt', pipelineDir,`
  `    conceptId: 'concept-ghost-in-the-machine-0dbeea' })`
- Best-effort, never throws past the caller (same contract as `writeSideFindingInbox` and
  `recordRequeueCause`). A telemetry failure must never block an escalation.

### B3. Where it shows up — for free

`side-finding-sweep.js` already drains `queue/side-findings-inbox/`, dedups **within a
`conceptId`** by similarity, and turns entries into brain-dump entries carrying
`raisedBy.conceptId`. `getConceptTimeline` already surfaces
`entry.raisedBy.conceptId === conceptId` as `kind: 'research-finding'` rows. So:

- **"View timeline" on the ghost concept card becomes the live debt backlog** with zero
  new UI.
- Optional: a debt count badge on the card (`renderConceptCard`), and a
  `ghostTelemetry.openDebt` field alongside A5's numbers.

The feedback loop: when someone builds the missing re-admission mechanism (like PR #117),
that signature stops recurring, its `ghost-debt-state.json` entry goes stale, and the debt
ages out of the backlog.

---

## Cross-cutting constraints

- **No new sweep.** Part A rides existing `classifyRequeue` call sites + the three manual
  endpoints. Part B rides the existing `needs-clarification-triage` / `reject-retry-check`
  sweeps already in `queue-watcher.sh`; `side-finding-sweep` (also already there) drains
  the inbox.
- **No new model calls.** `structuredSignalCategory` and `buildSignature` are
  deterministic. The manual-requeue path can pass a known `reasonHint` and will normally
  resolve via a structured signal or `unclassified` without touching
  `classifyViaFallbackModel` (which stays rate-limited as-is).
- **Best-effort everywhere.** Every new write is wrapped and swallowed. A locked db, a full
  disk, a bad payload → logged, pipeline continues.
- **Deterministic, not a nudge.** Both parts *remove* reliance on someone remembering: the
  actor is recorded automatically, the debt is filed automatically. (Contrast the #6
  PR-time lint idea, which only makes a human *more likely* to notice — deliberately left
  out of this PR.)

## Files touched

| file | change |
|---|---|
| `src/requeue-attribution-db.js` | `actor` column + index; `record-cause` reads `payload.actor` |
| `src/requeue-attribution-client.js` | `recordRequeueCause` gains `actor`; new `getActorRollup` |
| `src/requeue-attribution.js` | `classifyRequeue` `actor` param; `classify` CLI dispatch |
| `src/ghost-debt.js` | NEW — `fileGhostDebt` + `ghost-debt-state.json` dedup |
| `src/needs-clarification-triage.js` | call `fileGhostDebt` at the `leave-for-human` fallthrough |
| `src/reject-retry-check.js` | call `fileGhostDebt` at the two human-escalation sites |
| `python/dashboard/requeue_attribution_client.py` | NEW wrapper |
| `python/dashboard/app.py` | 3 manual-requeue sites call the wrapper; `/api/concepts` ghost telemetry |
| `python/dashboard/templates/index.html` | `renderConceptCard` ghost-row stat + sparkline |
| `AGENTS.md` | one line under the third principle: this telemetry is the concept's own audit surface |
| tests | `requeue-attribution.test.js`, `reject-retry-check.test.js`, `needs-clarification-triage.test.js`, NEW `ghost-debt.test.js`, NEW `test_requeue_attribution_client.py` |
| `queue/ghost-debt-state.json` | NEW runtime state (gitignored, like `requeue-attribution.db`) |

## Testing

- **A**: `classifyRequeue` records the passed `actor`; default is `pipeline-mechanism`;
  `getActorRollup` buckets correctly; the `classify` CLI round-trips a payload;
  `requeue_attribution_client.py` swallows a missing-node / bad-payload error. An
  `api_task_requeue` integration test asserts a `requeue_causes` row with
  `actor='operator-manual'` after a manual requeue.
- **B**: `fileGhostDebt` writes one inbox entry with the right `conceptId` and `stage`;
  a second call for the same signature within the refile window is a no-op; `ghostDebtFiled`
  prevents a same-run refile; `needs-clarification-triage` files debt only on the true
  fallthrough (not when a bucket matched); `reject-retry-check` files debt on exhaustion
  but **not** on PR #117's forbidden-path re-admit.
- Full suite green apart from the known pre-existing / worktree-name failures.

## Explicitly out of scope

- Filesystem-level detection of a raw `queue/*.json` hand-edit made outside any endpoint —
  no clean hook; a person editing queue files directly is already covered by AGENTS.md
  prose, not enforceable here.
- The #6 PR-time "is this prompt-nudge masking a deterministic step?" review lint — separate
  PR.
- Retroactive ghost-debt backfill over historical `leave-for-human` tasks — a one-time
  sweep like `concept-tally-backfill.js` could do it later; v1 is forward-only.
- Auto-*creating* the re-admission mechanism. Debt is a filed finding that flows through the
  normal `brain_dump_sort → task → draft → review → apply` pipeline like any other.

## Open questions

1. `agent-session` vs `operator-manual`: does the Chat panel currently requeue via
   `/api/task/.../requeue` (→ would land as `operator-manual` unless a header/param is
   threaded)? If chat-driven requeues are rare in v1, collapse to `operator-manual` and add
   `agent-session` when a real chat-requeue tool exists.
2. Burn-rate escalation on a manual requeue: a human requeuing the same task repeatedly is
   a strong "this keeps failing" signal — let it feed `checkAndEscalate` (forensics looks),
   or is the existing `_repeated_blocker_match` 409 guard in `api_task_requeue` enough?
   Leaning: let it escalate; it is the concept's whole point.
3. Ghost-telemetry route shape: extend `/api/concepts` for the one row, or a dedicated
   `/api/concepts/<id>/ghost-telemetry`? Dedicated route keeps the list endpoint cheap.
