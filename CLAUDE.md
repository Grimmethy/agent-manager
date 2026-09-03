# CLAUDE.md

Repo-specific guidance for Claude Code working in `agent-manager`. This complements
(does not replace) the `F:\GitHub\CLAUDE.md` architect-role instructions that apply
across every project in `F:\GitHub`.

## First principle: build the mechanism, don't hand-fix the instance

`agent-manager` is a system for making a pipeline do work autonomously. When a task, hub,
or queue is stuck, the job is **almost never** to unstick that one item by hand — it is
to build (or extend) the pipeline mechanism that unsticks it and every future item like
it, then let the pipeline run. A stuck hub → a watchdog sweep (`coordinator-sweep.js`,
`blocked-drain.js`, `decompose-loop-autoroute.js`). A task the local model can't land → a
routing rule (`decompose-pass.js`, `file-decompose-plan-pass.js`), not you writing the
code. A bad prompt → fix where `promptContext` is built.

Act on a single item directly only when the user **explicitly asks** for that item — and
even then prefer a dashboard `/api/task/...` endpoint or an existing sweep over
hand-editing `queue/`. If no mechanism fits, the deliverable is a proposal for one.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`github.com/Grimmethy/agent-manager`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) — no repo-specific overrides. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` (to be created) and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
