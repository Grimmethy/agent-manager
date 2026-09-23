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

### Codebase map

**Check `docs/agents/codebase-map.md` first** — before grepping, guessing, or
browser-searching for where a dashboard tab, backend route, or core pipeline mechanism
lives in the source tree. It's grown incrementally, not exhaustive, so it won't always
have the answer — but it's the cheapest lookup and the whole point is to check it before
falling back to a slower search. If it doesn't have what you need, add a row once you
find it — that's the whole maintenance model; nothing else keeps it fresh.

### Reviewing an unmerged branch

Before judging any unmerged/`agent/<id>` branch for value or completeness, check whether
it belongs to a coordinator hub and read the whole hub first — a sub-task reviewed in
isolation can look broken (or look fine) when its sibling sub-task is actually the other
half of the same fix, and the hub may already carry a review verdict about the
decomposition's completeness. See `docs/agents/unmerged-branch-review.md`.
