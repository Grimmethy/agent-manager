# ADR-0025 — Kernel and required plugins

**Status:** Draft

## Context

ADR-0022 established that Agent Manager's job is to manage agents — keep them working — not to define the work. Core became the platform: the queue state machine, worker/instance management, the Plan→Draft→Review→Apply loop, the dashboard, and a task-source SDK. Plugins define the work.

The architecture has since been refined. The platform is now explicitly split into a small **Kernel** plus a set of **required plugins** (each a separate repo, pinned in a Kernel manifest) and a set of **optional plugins**. Manager repos (forge-manager, business-manager) reach the Kernel only over HTTP. Shared services (gpu-broker, cloud-providers, wikiforge) stay independent. The hard-fail size ratchet (500 lines per file, 100 lines per function, tests included, frozen allowlist) applies to every repo. Windows support is retired.

This ADR amends ADR-0022 by recording the revised end state: the Kernel definition, the 7 required plugins, the HTTP-only contract for managers, the size ratchet, the extraction order, and the Windows retirement.

## Decision

### 1. Kernel definition

The Kernel is the minimal platform: queue state machine and task records, claim and heartbeat, lanes and GPU/budget guards, plugin loader + SDK, event stream, dashboard shell (queue, instances, lanes, plugin manifest, pipeline start/stop), and the main-push check. The Kernel contains no task-source name string, no `registerTaskSource` call, and no plugin logic.

### 2. Required plugins (7)

Seven plugins are required and pinned in the Kernel's `requiredPlugins` manifest with version ranges. The Kernel fails loudly if one is missing or out of range.

| Plugin | Owns |
|---|---|
| **adhoc** (+ reflex sources) | adhoc, brain_dump_sort, path_prefetch_resolve, trouble_log, secondbrain, research_task |
| **hub-tasks** | hub-tasks (exists) |
| **draft** | draft (plan/implement/critique passes) |
| **review** | review (majority-vote gate) |
| **apply** | apply (deterministic apply step) |
| **merge** | branch verification, Needs-Work repair, check-merge-ready, merge, prove-landed; unmerged-branch dashboard routes ship with it |
| **models** | all model/provider clients; Kernel keeps only the lane/endpoint registry and GPU guards; config.js splits into Kernel keys and per-plugin namespaces |

### 3. Plugin communication

Plugins talk to each other only through the task record, the queue, and the SDK. A plugin may import ONLY what `docs/PLUGIN_API.md` documents. Hygiene's 16 and hub-tasks' 9 undocumented core imports are each either promoted into the SDK (only if 2+ plugins use it) or pushed back into the plugin. Enforced by a test.

### 4. Dashboard routes

Dashboard: Kernel keeps only queue/instances/lanes/manifest/pipeline start-stop/event-stream routes; every other route ships from its plugin as a Flask blueprint + static JS via the manifest.

### 5. Manager repos and HTTP-only contract

**forge-manager** (17 forges: promptforge, adforge, scriptforge, characterforge, postforge, cutforge, voiceforge, storyforge, videoforge, sceneforge, stageforge, sparforge, kaggleforge, journalforge, annieforge, recipeforge, uiforge) and **business-manager** (books, fsbo-callsheet, inventory-plugin, intakereel, trade-calculator, mailroom, pf-loops) each register as one tab group in AM's single dashboard front door and also run standalone. They reach AM ONLY over HTTP (AM's `/api/task/...` and the gpu-broker); no cross-repo code imports. Shared services stay independent: gpu-broker, cloud-providers, wikiforge.

### 6. Hard-fail size ratchet

The existing benchmarks (500 lines per file, 100 lines per function) become hard-fail tests in every repo (Kernel, each plugin, each manager), tests included, with a frozen allowlist of current offenders each capped at current size that may only shrink. The Kernel total target is a starting number of 25k non-test lines (owner has not yet confirmed that number; revisit after the cycle is broken).

### 7. Extraction order

1. Break the 29-file import cycle and the four god-modules (task-sources.js, prompts.js, local-draft.js, review-task.js) inside the repo.
2. Move the 27 task sources registered in task-sources.js and their prompts out (ADR-0022 stages E, F, H).
3. Leaves: needs-clarification triage, brain dump, chat.
4. Adhoc + reflexes.
5. Apply, then review, then merge.
6. Models, then draft.
7. Kernel boundaries and size caps.

### 8. Windows retirement

Windows support is retired (owner: not supported unless someone pays for it). Linux only.

## Consequences

- **Positive:** The Kernel is small and self-describing. Required plugins are pinned and enforced. Managers are decoupled by HTTP. Size limits are hard-fail. Windows maintenance burden is gone.
- **Negative / cost:** Highest risk is the draft/review/apply hot paths (stages A, B of ADR-0022). Moving a tangle into a repo without first breaking the cycle only relocates it — hence step 1 of the extraction order. Seven new repos to release together during transition.
- **Neutral:** The half-extracted state (hygiene task-source definitions moved, substrate not) remains stable until step 1 breaks the cycle.

## Open questions

1. The Kernel total line target (25k non-test lines) is a starting number; owner has not yet confirmed. Revisit after the cycle is broken.
2. The self-audit plugin's exact scope (pipeline_self_audit, pipeline_health_audit, ui_visibility_audit, staleness_audit, pipeline_forensics, capability_debrief) is still being finalized; the list moves to the self-audit plugin when extracted.
