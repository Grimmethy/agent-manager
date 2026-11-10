# Main-Write Paths Map

> Last updated: 2026-09-25 (HUB0364 · 1/4 · Map all main-write paths to design notes)

Every code path that can write to the remote's `main` branch (via `pushMain`, `resetToMain` fast-forward, or `push` of a branch that is itself `main`) is listed below. Each entry records: **file/function**, **current behavior** (gated / ungated), **how it reaches main**, and **what changes are needed to route through the new gate** (`assertMainPushReady` in `src/lib/main-push-policy.js`).

The gate (HUB0364 · 2/4) requires a READY record in `queue/branch-verdicts.json` keyed by `branch + headSha`, checks a timestamp, logs a ledger row, and bypasses only with `AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true` (logged as a warning). All main-write paths must call it before any git operation that touches the remote's main branch.

---

## 1. `src/git-runner.js` — `pushMain()`

**What it does:** Pushes `main` directly to `origin/main`. Distinct from `push(branchName)` which pushes a throwaway agent branch.

**Current behavior:** Gated by `ungatedMainPushAllowed()` (env var check). If ungated is `false`, throws an error and the caller gets a `{succeeded:false, reason: ...}` outcome.

**How it reaches main:** Called from two places:
- `src/apply-task.js` line ~499 — the single-task direct-to-main path (after commit).
- `src/lib/apply-main-batch.js` line ~190 — the batched triage path, only when `ungatedMainPushAllowed()` is `true`.

**Changes needed:** Wrap the `push('origin', `${mainBranch}:${mainBranch}`)` call with `assertMainPushReady(mainBranch, headSha, { caller: 'git-runner:pushMain' })`. The headSha should be `mainBranch`'s current commit (available via `run(['rev-parse', mainBranch])`).

---

## 2. `src/git-runner.js` — `resetToMain()` fast-forward branch

**What it does:** Resets the working tree to `origin/main`. When local `main` is ahead of `origin/main`, the old behavior fast-forwarded `origin/main` to match local — this IS a main write (push).

**Current behavior:** Gated by `ungatedMainPushAllowed()`. If ungated is `false`, commits are rescued to `agent/rescued-<mainBranch>-<timestamp>` branch (pushed best-effort) before the reset proceeds.

**How it reaches main:** The `run(['push', 'origin', `${mainBranch}:${mainBranch}`])` at line ~232 is a direct push to origin/main. This is the "silent destroy" hazard the policy was designed to prevent (confirmed live 2026-08-16).

**Changes needed:** Wrap the push with `assertMainPushReady(mainBranch, localHeadSha, { caller: 'git-runner:resetToMain:fast-forward' })`. The rescue-branch path (ungated=false) is the already-implemented gate — the new assertion should also apply there for the ledger/audit trail.

---

## 3. `src/apply-task.js` — `applyTask()` direct-to-main path

**What it does:** For sources registered with `directToMain: true`, commits artifact straight to main (no throwaway branch).

**Current behavior:** The decision `commitsDirectlyToMain = !!(registered && registered.directToMain === true) && ungatedMainPushAllowed()` at line ~345 means: even if a source declares `directToMain: true`, it takes the normal branch path when ungated is false. So the direct-to-main path is **already gated by the env var**, but NOT by the READY record.

**How it reaches main:** `fetchMain()` → `resetToMain()` → (no branch created) → `writeArtifact()` → `gitRunner.add()` → `gitRunner.commit()` → `gitRunner.pushMain()`.

**Changes needed:** Before `gitRunner.pushMain()`, call `assertMainPushReady(gitRunner.mainBranch, headSha, { caller: 'apply-task:directToMain', taskId: task.id })`. The headSha is `mainBranch`'s commit after `resetToMain()` (i.e., same as origin — the local has been reset).

---

## 4. `src/lib/apply-main-batch.js` — `applyDirectToMainBatchOnBranch()`

**What it does:** Batches N direct-to-main tasks under ONE fetch/reset/commit/push cycle. Prevents the 140-task-backlog → 140 tiny commits to master bug.

**Current behavior:** Two sub-paths:
- **Gated (default):** Prepares the rolling `TRIAGE_BRANCH` (`agent/triage-queue`), pushes to it. Never touches origin/main.
- **Ungated:** `resetToMain()` then `pushMain()`.

**How it reaches main:** Only the ungated sub-path reaches main (via `gitRunner.pushMain()`). The gated sub-path pushes to `TRIAGE_BRANCH` which a human merges.

**Changes needed:** The gated path is already safe (no main write). The ungated path needs `assertMainPushReady` around the `pushMain()` call. Additionally, the `resetToMain()` in the ungated path (line ~78) also does a fast-forward push if local is ahead — that needs the assertion too.

---

## 5. `src/apply-branch-prep-route.js` — `prepareApplyBranch()`

**What it does:** Decides whether to create a throwaway branch or work on main directly. Returns `{ branchName, stacked }`.

**Current behavior:** When `commitsDirectlyToMain` is `true`, `branchName` is `null` — no branch is created, the apply proceeds on main. This is the entry point that enables paths 3 and 4's direct-to-main behavior.

**How it reaches main:** Sets `branchName = null`, causing `apply-task.js` to skip `createBranch()` and proceed with the artifact write on the main branch checkout.

**Changes needed:** No git write happens here. This is a decision point, not a write point. The gate must be applied at the actual write sites (paths 1-4 above). Documented for completeness.

---

## 6. Coordinator auto-merge (already handled)

**What it does:** Used to auto-merge "verified mechanical moves" (e.g., `script-extract`, `one-pass-decompose` hub children) into main without human review.

**Current behavior:** **Disabled.** The `main-push-policy.js` header explicitly states: "the coordinator no longer auto-merges 'verified mechanical moves' into main." The `decompose-auto-merge.js` code was moved to `agent-manager-hub-tasks` (S5e) and the main-write path was removed.

**How it reaches main:** Would have used `pushMain()` or a fast-forward reset. No longer does.

**Changes needed:** None — already compliant. Documented for completeness so future refactorers know this was an intentional removal, not an oversight.

---

## 7. `src/git-runner.js` — `push(branchName)` of a branch named `main`

**What it does:** Generic `push(branchName)` method. If someone passes `main` as the branch name, it would push to origin/main.

**Current behavior:** No special-case guard — any branch name goes through.

**How it reaches main:** Only if a caller explicitly passes `main` as the branch name. Currently no caller does this (all callers pass `agent/<id>` or `TRIAGE_BRANCH`), but it is a latent hazard.

**Changes needed:** Add a defensive check: if `branchName === mainBranch`, route through `pushMain()` (which has the gate) instead of `pushBranch()`. Document as a defensive hardening measure.

---

## Summary Table

| # | File:Function | Current Behavior | Reaches Main Via | Gate Needed |
|---|---------------|-----------------|------------------|-------------|
| 1 | `git-runner.js:pushMain` | Env-var gated | `push origin main:main` | Yes — wrap push call |
| 2 | `git-runner.js:resetToMain` (fast-forward) | Env-var gated | `push origin main:main` inside reset | Yes — wrap fast-forward push |
| 3 | `apply-task.js:applyTask` (direct-to-main) | Env-var gated | Calls pushMain() | Yes — assert before pushMain |
| 4 | `apply-main-batch.js:applyDirectToMainBatchOnBranch` (ungated path) | Env-var gated | Calls pushMain() + resetToMain | Yes — assert before both |
| 5 | `apply-branch-prep-route.js:prepareApplyBranch` | Decision point | No git write | None (decision only) |
| 6 | Coordinator auto-merge | Disabled (removed) | N/A | None (already compliant) |
| 7 | `git-runner.js:push(branchName)` (defensive) | No guard | Latent hazard if `main` passed | Yes — route through pushMain |

**Total write sites that need gating: 5** (paths 1, 2, 3, 4, 7). Two are already env-var gated (1, 2, 3, 4) but lack the READY-record assertion. One (7) is a defensive hardening gap.

---

## Dependencies on Other Hub Tasks

- **HUB0364 · 2/4** — Implement `assertMainPushReady()` kernel in `src/lib/main-push-policy.js`.
- **HUB0364 · 3/4** — Route all main-write paths through the gate (the enforcement edits).
- **HUB0364 · 4/4** — Write enforcement tests for all paths.

This document (HUB0364 · 1/4) is the design note that informs all three. The "what changes are needed" column above maps 1:1 to the enforcement edits HUB0364 · 3/4 will make.
