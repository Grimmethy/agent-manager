# Catalogue of recurring tuning loops (read-only findings doc)

- Owner request date: **2026-10-15**. Session-raised evidence from hand-run session
  `015TvzBxsPvNeXXdPbh273DP` (2026-10-14/15) included as items (A)–(I).
- Companion design doc already in tree: `Docs/tuning-loops-design.md` (confirmed to
  exist, 281 lines, "Status: design doc only" — `Docs/tuning-loops-design.md:1-3`).
- **Data sources unavailable in this checkout** (each verified by direct check):
  - memory notes `/home/wok/.claude/projects/-home-wok/memory/` — `ls` returned
    "No such file or directory" (confirmed absent from this sandbox); claims sourced
    only from memory notes below are tagged *unconfirmed (session-raised)*.
  - `brain-dump.json` — runtime artefact under the live `pipelineDir` (path from
    `getConfig()`, e.g. `src/task-sources.js:1200`); `find` over the repo and
    `/media/model-cache` (maxdepth 6) found no copy (confirmed).
  - `queue/done` and `queue/done/_archived*` task records — no `queue/` directory in
    this checkout (confirmed by root listing); recurrence of sources/job types is
    instead evidenced via `git log` on `origin/master` and the registered sources in
    `src/task-sources.js`.
- Git counts below are read-only `git log origin/master --since=2026-08-01` over this
  checkout (confirmed): **2,870 commits** (task's "~2,799" — close, confirmed), of which
  **238 are `Triage batch`** (task's "~220" — confirmed close). Theme hit counts:
  `fix` 461, `triage` 350, `unmerged` 50, `brain dump` 46, `sweep` 70, `hygiene` 26,
  `env` 17, `false positive` 16, `drain` 14, `stall` 9, `incident` 5, `scanner` 7,
  `dismiss` 7, `health ledger` 2, `known-fixed` 4, `drift` 4, `deploy` 0, `threshold` 13
  (all confirmed from the log).

## (a) The recurring loops actually found

Table. "Already automated?" names the concrete source/sweep or says **none**.

| # | Loop | Times it ran (count + dates) | Trigger | Evidence looked at | Decision made | Artefact produced | Already automated? |
|---|------|------------------------------|---------|--------------------|---------------|-------------------|--------------------|
| 1 | Stalled-bucket drain (blocked / needs-clarification: find shared cause, fix, release) | 23 hits (`stall` 9, `drain` 14) across 2026-08→2026-10; cluster-fingerprint concept dated 2026-09-12 in code comment (`src/blocked-cluster-sweep.js:3`, confirmed) | bucket growth; same blockedReason repeated | blockedReason text; task histories (queue records unavailable here — unconfirmed detail) | one shared cause → one fix → release matching items | fix commits; known-fixed registry entries 2026-10-15/16 (`d5fa7fb9`, `bc051717`, confirmed) | Partial: shared-cause finding `src/blocked-cluster-sweep.js`; post-fix requeue `src/blocked-drain.js:42` (`requeueBlockedTasksForSignature`, confirmed). The passive "find-cause→file-fix" loop: **none** (`Docs/tuning-loops-design.md` Loop C, design only) |
| 2 | Incident → root cause → sweep siblings (Incident Amplification) | 5 `incident` commits + Ollama-hang incident 2026-09-15 (22 h, 80+ pending — `src/pipeline-health-audit-sweep.js:6-10`, confirmed); known-fixed requeues 2026-10-15/16 | an incident lands (hang, stale snapshot, gate misfire) | incident log, worker logs, sibling task failures | fix the root; requeue stuck siblings | `pipeline_health_audit` source `src/task-sources.js:2408` (confirmed); watchdog sweep `src/pipeline-health-audit-sweep.js`; known-fixed registry entries (2 confirmed commits) | Partial: detection + requeue exist (`src/blocked-drain.js:42`, `src/task-sources.js:2408`); the proactive sibling-sweep loop: **none** (design doc says loop 2 not built, `Docs/tuning-loops-design.md:244-245`, confirmed) |
| 3 | Unmerged-branch review (read hub, verdict merge / needs-work / discard) | 50 `unmerged` commits, 2026-08→2026-10; dashboard list endpoint fix 2026-10-15 (`ec99cfe2`, confirmed) | branch list grows stale | full hub diff, task records | merge / needs-work / discard | `docs/agents/unmerged-branch-review.md` (confirmed to exist); Unmerged Branches dashboard list (`ec99cfe2`) | **none** as a verdict source; branch bookkeeping exists: `src/branch-removal-ledger.js`, `src/branch-conflict-readmit-sweep.js`, `src/branch-liveness-check.js` (all confirmed to exist) |
| 4 | Scanner precision tuning (measure FP, cut, tiers, 'dismissed') | 16 `false positive` + 7 `dismiss` + 7 `scanner` commits; e.g. shadow-mode gates 2026-10-01 (brain dumps #1657/#1661/#1663, confirmed in log) | new/updated gate misfiring | candidate snippets, dismissal records (queue records unavailable here — unconfirmed detail) | cut FP; add shadow-mode before enforce | gate code + dismiss rules; e.g. `seq-await`/`sync-io` gate commits 2026-10-01 | Partial: audits exist (`src/pipeline-self-audit` reg. `src/task-sources.js:2321`, hygiene plugin sources `/media/model-cache/github/agent-manager-hygiene/src` confirmed to exist) but an FP-rate loop with a "dismissed" ledger: **none** |
| 5 | Policy-change follow-up (read a week of data after a change, tighten, flip switches) | 4 `known-fixed` commits (2026-10-15/16, confirmed) + 13 `threshold` commits; no scheduled follow-up found anywhere | a policy/threshold/env change merges | one week of post-change metrics — nobody reads it | tighten or roll back | registry entries (`bc051717`, `d5fa7fb9`); threshold commits (e.g. `0792d28a` uptime-log 1200-vs-1680, 2026-10-15, confirmed) | **none** (design doc Loop A, `Docs/tuning-loops-design.md`, design only — confirmed no code) |
| 6 | Triage candidate sifts (100–200 candidates → keep / drop / hold) | 238 `Triage batch` + 350 `triage` commits, 2026-08→2026-10 (highest-frequency loop, confirmed) | candidate docs accumulate | `Docs/*_CANDIDATES.md` (9 candidate files confirmed in `Docs/`), `docs/agents/triage-labels.md` (confirmed to exist) | keep / drop / hold per candidate | triage batch commits; `candidate-*` sources (`src/candidate-docs.js`, `src/candidate-path-grounding.js` confirmed to exist; hygiene plugin `/media/.../agent-manager-hygiene/src/candidate-*` per repo listing) | Partial: candidates are generated and grounded (`src/candidate-size-gate.js`, `src/candidate-premise-check.js` confirmed to exist); the keep/drop/hold sift verdict: human, **none** automated |
| 7 | Code-health & history analysis (daily health ledger) | 2 `health ledger` commits (design doc `df15df72` 2026-10-15 + merge `91d09f26`, confirmed); proposed earlier (memory note `project-agent-manager-code-health-analysis-2026-10-08` — unconfirmed, source unreadable) | schedule: daily | repo metrics, queue state, budget monitor (`budget-monitor.js` confirmed to exist) | record ledger row | design doc `Docs/tuning-loops-design.md:§2` (confirmed); no ledger code | Detection only: `src/pipeline-health-audit-sweep.js` (confirmed). The ledger itself: **none** (design doc §2, confirmed "no code") |
| 8 | Brain-dump / memory / docs hygiene | 46 `brain dump` + 26 `hygiene` commits, 2026-08→2026-10 (e.g. brain dump #1657–#1663 2026-10-01, confirmed) | new brain-dump entry / stale doc | `brain-dump.json` (runtime file, unavailable here — unconfirmed content), doc vs code | classify, file task, promote/drop | tasks from entries (e.g. `research_task` follow-up, `src/task-sources.js:590` comment, confirmed) | **Yes, most automated loop**: `brain_dump_sort` `src/task-sources.js:1611`, `secondbrain` `:1560`, `second_brain_opportunities` `:2428`, `trouble_log` `:1559`, `pipeline_debrief` `:2366`, `doc_drift_fix` `:2391` (all confirmed) |
| 9 | Environment drift (env switches, lanes, P40, plugin env) | 17 `env` + 4 `drift` commits; worked examples 2026-10-15: P40 mismatch, missing `CHARACTERFORGE_ROOT` (session-raised, unconfirmed against live env) | env switch flipped / plugin restarted / P40 state changed | live process env vs intended | flip switch / fix manifest entry | env edits (e.g. 2026-10-15 known-fixed flips, confirmed as pattern) | Note: `src/drift-scan.js`/`src/drift-fix.js` are **doc/registry** drift (static list vs live registry — `src/drift-scan.js:1-11`, `src/drift-fix.js:1-11`, confirmed), NOT env drift. Env checks: `src/mem-guard.js`, `src/dead-process-check.js` (both confirmed to exist). Declared-state-vs-live diff loop: **none** (design doc Loop B, design only) |
| A | Land-and-deploy after merge (fast-forward, restart plugin, confirm live commit) | session-raised: ~10 times in one day (2026-10-14, session `015TvzBxsPvNeXXdPbh273DP`, unconfirmed); 0 `deploy` commits in log (confirmed — deploys leave no git trace by nature) | every merge | plugin pid, pidfile, served commit | restart + verify live commit | none durable (no deploy record, unconfirmed) | **none** (`src/task-sources.js` grep for deploy/ensure-started: no source, confirmed by absence in registration list `src/task-sources.js:1529-2428`) |
| B | Pre-flight start guard (uncommitted dirt at risk from self-heal rescue) | session-raised 2026-10-14 (rescue branch `agent/rescued-master-20261014193855`, PRs #467/#474 — unconfirmed, PRs not verifiable in this log); rescue machinery confirmed present: `src/lib/apply-clone-dirt.js`, `src/git-runner.js` (grep hits, confirmed), git-log rescue fix `2026-10-05` commit (confirmed) | pipeline start / project switch | checkout `git status` of target repo | commit/stash the dirt first | rescue branches (unconfirmed) | **none** as a guard; rescue logic exists (`src/lib/apply-clone-dirt.js`, confirmed) but nothing pre-checks dirt before start |
| C | Manual state checks (P40 up, workers/lane, pids, RAM, live env vars) | merged into loop 9 as a member (session-raised checks, 2026-10-14, unconfirmed) | "is the machine healthy" question | virsh, pidfiles, `agent-manager.env`, mem-guard threshold | record / fix | nothing durable (unconfirmed) | Partial: `src/mem-guard.js` (2048 MB guard), `src/dead-process-check.js` (confirmed to exist); the full P40/lane/live-env sweep: **none** |
| D | Status digests ("what is the queue doing") | merged into loop 2/8 evidence path (session-raised, unconfirmed); dashboard merges via `via dashboard` present in 2026-10-15 log (confirmed) | owner asks | `queue/` dirs, task histories, worker logs (records unavailable here — unconfirmed detail) | summarize | answer in transcript only (unconfirmed) | **none** as a generated digest (dashboard exists — "via dashboard" in log, confirmed — but no phone-readable digest source found) |
| E | Contact sheets after render jobs | session-raised (unconfirmed; no render-sheet code found in `src/` — confirmed by grep for contact-sheet: no files) | render job completes | rendered images | build labelled sheet for review | sheet image (unconfirmed) | **none** (no source in `src/task-sources.js` registration list, confirmed by absence) |
| F | Filing findings (incident → well-formed brain-dump/premium task, no-decompose scope) | merged into loop 8 (session-raised, unconfirmed) | incident / discovery | incident trail | one well-formed task with evidence | task records (unconfirmed) | **Yes, path exists**: `brain_dump_sort` `src/task-sources.js:1611` + `trouble_log` `:1559` (confirmed); the "do-not-decompose" framing is prompt convention, no dedicated helper: **none** |
| G | Memory upkeep (update notes + index after work) | merged into loop 8 (session-raised; memory dir unreadable here, confirmed absent from sandbox) | end of work stretch | memory notes | update notes + `MEMORY.md` index | memory files (unconfirmed) | Partial: `secondbrain` `src/task-sources.js:1560`, `second_brain_opportunities` `:2428` (confirmed); the "propose-for-approval debrief": closest is `pipeline_debrief` `:2366` (confirmed) |
| H | Secret hygiene (transcript leaked a dashboard token via `grep agent-manager.env`) | session-raised 2026-10-15 (unconfirmed); `agent-manager.env.example` exists in root (confirmed to exist) | any read of `.env` | the printed line | redact before transcript | redaction (unconfirmed) | **none** (no `redact*`/`secret*` file in `src/`, confirmed by grep; `src/accessible-roots.js` confirmed to exist but is root-sandboxing, not redaction) |
| I | Prior-art scouting (vet by stars/recency/size, add INDEX row) | session-raised (unconfirmed); related: `Scouted Repos tab` commits 2026-10-13 / 2026-09-14 (PR #555, #229, confirmed in log); `UsefulProjectIndex/INDEX.md` not in this repo (confirmed absent — external repo) | design task needs prior art | gh/web search results | add row + notes | INDEX row (unconfirmed) | Partial: `project_search` `src/task-sources.js:2314` (confirmed), `src/arch-import-fetch.js` (confirmed to exist); scout-attached-to-every-design-task step: **none** |

## (b) Verdict per loop

1. **Stalled-bucket drain** — automate evidence-gathering + human gate. Shared-cause
   fingerprinting is deterministic and already written (`src/blocked-cluster-sweep.js`);
   release must stay per-item with a human gate (dismissal-safety rule,
   `Docs/tuning-loops-design.md:141-160`, confirmed).
2. **Incident → sweep siblings** — automate evidence-gathering + human gate. Detection
   exists; filing the "sweep siblings" task should be automatic, applying the sweep manual.
3. **Unmerged-branch review** — automate evidence-gathering + human gate. Reading the
   hub is mechanical; merge/discard verdicts carry blast radius (playbook itself warns
   about reviewing halves of atomic fixes — `docs/agents/unmerged-branch-review.md:1-11`,
   confirmed).
4. **Scanner precision tuning** — automate fully for measurement (FP rate, dismissal
   ledger); keep human gate for enabling/disabling gates. Measurement is pure counting.
5. **Policy-change follow-up** — automate fully (schedule + binary "in band? yes/no"
   verdict, per `Docs/tuning-loops-design.md` Loop A); tightening stays a filed task.
6. **Triage candidate sifts** — keep manual. Highest frequency (238 batches) but each
   keep/drop is a product judgment on unique content; automating the verdict risks
   bulk-dropping wrong items.
7. **Code-health ledger** — automate fully. Append-only JSONL is risk-free; it is the
   substrate every other loop's metric depends on (`Docs/tuning-loops-design.md:§2`).
8. **Brain-dump / memory / docs hygiene** — already mostly automated; keep as is, add
   nothing new (loops 8 + F + G are one loop with three faces).
9. **Environment drift** — automate fully for the diff (declared manifest vs live state
   is a pure comparison, no model step — `Docs/tuning-loops-design.md` Loop B); applying
   the fix stays human-gated.
   A. **Deploy-drift** — automate evidence-gathering + human gate; the *verify live
   commit* half is mechanical and safe to automate.
   B. **Start guard** — keep manual for now, automate as a cheap pre-check later: it
   gates on trivially-checkable `git status` dirt (confirmed machinery exists at
   `src/lib/apply-clone-dirt.js`), so cost of automating is low but incident data is
   thin (one session-raised report, unconfirmed).
   C. — see 9. D. **Digests** — automate fully; pure read-and-format, zero blast radius.
   E. **Contact sheets** — keep manual until at least 3 sessions confirm the shape
   (single unconfirmed report today).
   H. **Secret hygiene** — automate fully: a redacting read wrapper is a deterministic
   string transform with no judgment (no such tool exists, confirmed by grep).
   I. **Scouting** — automate evidence-gathering (fetch + vet by stars/size) + human
   gate for the verdict; the vet criteria are deterministic.

## (c) Top 5 gaps ranked by (frequency × cost of forgetting)

1. **Environment-drift / deploy-drift (loops 9+A+C)** — ran every 2026-10-14/15 session
   (unconfirmed, session-raised) and the missing-`CHARACTERFORGE_ROOT` class of bug has
   already blocked real work (known-fixed entries 2026-10-15/16, confirmed `bc051717`).
   Cost of forgetting: a plugin silently serves the wrong env until something blocks.
   No diff loop exists (design-only, confirmed `Docs/tuning-loops-design.md` Loop B).
2. **Policy-change follow-up (loop 5)** — the known-fixed registry entries on
   2026-10-15/16 (confirmed) are a human remembering to schedule the review; 13
   `threshold` commits (confirmed) show thresholds keep shifting with nobody re-reading
   a week of data. Cost: a bad policy silently persists until the next incident.
3. **Health ledger (loop 7)** — every metric in §1's design depends on it
   (`Docs/tuning-loops-design.md:§2`, confirmed); only the design exists (confirmed
   "design doc only", `Docs/tuning-loops-design.md:1-3`). Cost of forgetting: no loop
   can prove it works or retire itself.
4. **Unmerged-branch verdicts (loop 3)** — 50 `unmerged` commits (confirmed) with the
   list endpoint already too slow to open (37 s vs 30 s timeout, `ec99cfe2`, confirmed);
   the playbook exists but nothing files the review. Cost: dead branches rot into
   conflicts (`src/branch-conflict-readmit-sweep.js` exists to mitigate, confirmed).
5. **Stalled-bucket shared-cause finding (loop 1)** — 23 `stall`/`drain` hits (confirmed)
   across two months; the requeue half is built (`src/blocked-drain.js:42`, confirmed)
   but the find-the-cause half still happens in a human's head. Cost: buckets hold
   genuinely different causes side by side (dismissal-safety case,
   `Docs/tuning-loops-design.md:141-160`, confirmed).

## (d) Confirmed / unconfirmed claim ledger

- 2,870 commits since 2026-08-01; 238 `Triage batch` — **confirmed** (read-only
  `git log origin/master --since=2026-08-01` on this checkout).
- All theme hit counts in the header — **confirmed** (same log, `grep -ci` per term).
- Loop 1 partial automation (`src/blocked-cluster-sweep.js`, `src/blocked-drain.js:42`)
  — **confirmed** (files read).
- Loop 2: Ollama-hang incident 2026-09-15, 22 h, 80+ pending — **confirmed**
  (`src/pipeline-health-audit-sweep.js:6-10`); "Incident Amplification not built" —
  **confirmed** (`Docs/tuning-loops-design.md:244-245`).
- Loop 3: `docs/agents/unmerged-branch-review.md` — **confirmed** (file read);
  37 s endpoint / 30 s timeout — **confirmed** (commit `ec99cfe2` subject).
- Loop 4: shadow-mode gates 2026-10-01, brain dumps #1657/#1661/#1663 — **confirmed**
  (log subjects); "dismissed" ledger loop absent — **confirmed** (no source found in
  `src/task-sources.js` registration list `:1529-2428`).
- Loop 5: known-fixed entries `bc051717` (2026-10-15), `d5fa7fb9` (2026-10-16);
  threshold divergence fix `0792d28a` — **confirmed** (log).
- Loop 6: 9 `Docs/*_CANDIDATES.md` files, `docs/agents/triage-labels.md`,
  `src/candidate-*.js` — **confirmed** (directory listings / file reads).
- Loop 7: ledger design `Docs/tuning-loops-design.md:§2`, design-only status
  `:1-3`; design commits `df15df72`, `91d09f26` — **confirmed** (file + log).
- Loop 8: `brain_dump_sort :1611`, `secondbrain :1560`, `trouble_log :1559`,
  `pipeline_debrief :2366`, `doc_drift_fix :2391`, `second_brain_opportunities :2428`
  — **confirmed** (`src/task-sources.js`, grep).
- Loop 9: `src/drift-scan.js` / `src/drift-fix.js` are doc/registry drift, not env
  drift — **confirmed** (file headers read); `src/mem-guard.js`,
  `src/dead-process-check.js` exist — **confirmed** (directory listing).
- (A) ~10 deploys in one day; (B) rescue branch + PRs #467/#474; (C) the specific
  hand-checks; (D) digest method; (E) contact-sheet workflow; (F) filing practice;
  (G) memory upkeep practice; (H) token-in-transcript incident; (I) scout workflow —
  all **unconfirmed (session-raised, `015TvzBxsPvNeXXdPbh273DP`)**; (B)'s rescue
  machinery and `2026-10-05` rescue fix commit — **confirmed**
  (`src/lib/apply-clone-dirt.js`, log).
- Memory notes (`project-agent-manager-*`, `MEMORY.md`) — **could not read** (path does
  not exist in this sandbox, confirmed by `ls`); any claim that rests on them is
  unconfirmed here.
- `brain-dump.json` content; `queue/done` + `_archived*` task histories — **could not
  read** (runtime files, absent from this checkout, confirmed by `find`/listing).
- `UsefulProjectIndex/INDEX.md` — **unconfirmed** (not in this repo, confirmed absent;
  external repo not in the accessible roots list).

*End of catalogue. One file; nothing else in the tree was modified.*
