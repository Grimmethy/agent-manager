# agent-manager

An unattended Plan → Draft → Review → Apply pipeline for delegating coding/documentation
tasks to a local LLM (via [Ollama](https://ollama.com)), with a deterministic (no-LLM)
apply step and a plugin registry for task sources. Extracted from a real, live-running
production pipeline — every mechanism here was proven against real work before extraction,
not designed in the abstract.

## Why this exists

Point an always-on local model at a backlog of small, well-scoped tasks (architecture
findings, issue-tracker tickets, county/vendor-adapter completeness gaps, one-off ad-hoc
requests) and let it draft, self-critique, and get reviewed — with every actual file write
and git operation done by deterministic code, never by the model itself. A human (or a
second, more capable model) only has to review pushed branches, not babysit the loop.

## Architecture

Four always-on processes, each in its own terminal:

- **`ornith-worker.ps1`** — claims a pending task, runs a Plan pass, an Implement pass, and
  an independent Critique/Revision pass, then hands the draft to review.
- **`review-runner.ps1`** — a majority-vote model call judges each draft APPROVE/REJECT.
  APPROVE moves the task to `queue/approved/`; nothing is written or pushed yet.
- **`apply-runner.ps1`** — the only process with real file-write/git capability. Executes
  an approved task deterministically (see `apply-group-a.js`/`apply-group-b.js`).
- **`queue-watchdog.ps1`** — dead-process detection (restarts a crashed loop) and
  reject-retry-requeue (a genuinely rejected draft gets one bounded redraft attempt).

State lives entirely in a filesystem queue (`queue/pending/`, `queue/review/`,
`queue/approved/`, `queue/blocked/`, `queue/done/`) plus per-process heartbeat files in
`instances/` — no database required, though a consumer can mirror events into one (see
`agent-task-db.js` — not part of this package; add your own via `Invoke-TaskDb`'s
convention of a no-op when the script is absent).

## Configuration

This package has no config *file* of its own — everything is env vars, following the same
convention the underlying model client already used. Set these before launching any script:

| Var | Required | Meaning |
|---|---|---|
| `AGENT_MANAGER_REPO_ROOT` | **yes** | Absolute path to the repo this pipeline operates on. |
| `AGENT_MANAGER_PIPELINE_DIR` | no (defaults to `REPO_ROOT`) | Where `queue/`, `instances/`, and your own local task-source/applier scripts live. |
| `AGENT_MANAGER_REGISTER_PATH` | no | Path to a script the CLI entry points `require()` once, for its side effect of calling `registerTaskSource`/`updateTaskSource` for your project-specific sources. |
| `SECOND_BRAIN_DIR` | no | A personal-notes vault, if you use the `secondbrain` built-in source. |
| `AGENT_MANAGER_GREP_DIRS` | no (default `frontend/src,backend/src`) | Comma-separated dirs the `grep_codebase` tool is allowed to search. |
| `AGENT_MANAGER_TROUBLE_LOG_PATH` | no (default `<repoRoot>/Docs/TROUBLE_LOG.md`) | Issue-tracker doc for the `trouble_log` source. |
| `AGENT_MANAGER_ARCH_CANDIDATES_PATH` | no (default `<repoRoot>/Docs/ARCH_REVIEW_CANDIDATES.md`) | Architecture-candidates doc for `arch_review`/`arch_discovery`. |
| `AGENT_MANAGER_COMMUNITY_COVERAGE_PATH` | no (default `<pipelineDir>/community-coverage.json`) | Rotation state for `arch_discovery`. |
| `AGENT_MANAGER_GRAPH_PATH` | no (default `<repoRoot>/graphify-out/graph.json`) | A [graphify](https://github.com)-style codebase graph for `arch_discovery`. |
| `AGENT_MANAGER_DOMAINS_PATH` | no (default `<pipelineDir>/task-domains.json`) | Your domain config (see below). |
| `AGENT_MANAGER_COMPARE_URL_BASE` | no | e.g. `https://github.com/you/repo/compare/main...` — appended with the pushed branch name in log output. |
| `OLLAMA_URL` | no (default `http://localhost:11434`) | |
| `ORNITH_MODEL` | no (default `ornith:9b`) | Ollama model tag. |
| `REVIEW_PROVIDER` | no (default `ornith`) | Set to `claude` to use `claude -p` for a combined review+apply call instead. |

## Domains

`task-domains.json` (a file YOU own, at `AGENT_MANAGER_DOMAINS_PATH`) maps each task
`domain` to a work directory and a success-detection strategy:

```json
{
  "myproject": { "workDirKind": "repoRoot", "successCheck": "git-branch-diff" },
  "notes": { "workDirKind": "secondBrainDir", "successCheck": "done-marker" }
}
```

## Built-in task sources

Six, at priorities 10/20/40/70/80/90 (30/50/60 left open for yours):

| Source | Priority | Reads |
|---|---|---|
| `adhoc` | 10 | `queue/adhoc/*.json` (submit via `queue-adhoc-task.js`) |
| `trouble_log` | 20 | `AGENT_MANAGER_TROUBLE_LOG_PATH`, entries flagged 🤖 |
| `secondbrain` | 40 | `SECOND_BRAIN_DIR/Inbox/*.md` |
| `arch_review` | 70 | `AGENT_MANAGER_ARCH_CANDIDATES_PATH`, entries rated Strong |
| `arch_discovery` | 80 | `AGENT_MANAGER_GRAPH_PATH` + `AGENT_MANAGER_COMMUNITY_COVERAGE_PATH` — generates new candidates one graph community at a time |
| `unused_export` | 90 | `queue/dead-code-flags.json` (produce this with your own scanner) |

## Registering a custom task source

```js
// your-project-sources.js -- pointed at by AGENT_MANAGER_REGISTER_PATH
const { registerTaskSource, updateTaskSource } = require('agent-manager/src/task-source-registry.js');

registerTaskSource('my_source', { priority: 30, next: myNextTaskFn });
updateTaskSource('my_source', {
  buildPlanPrompt: (task) => `...`,
  buildImplementPrompt: (task, planText) => `...`,
  apply: ({ implementResponse, repoRoot, pipelineDir, task }) => {
    // write files yourself, or fall through to the Group B default by not registering `apply` at all
    return { file: 'path/written.json' }; // or { files: [...] }
  },
  groundingFields: ['someField'], // or: extractGrounding: (promptContext, task) => '...'
});
```

If you don't register `buildImplementPrompt`, your source's implement pass emits the
generic Group B JSON change-object shape (`{mode: create|edit|delete, file, ...}`, or an
array of them) and gets applied by `apply-group-b.js` automatically — the default path,
and the one every built-in "real code change" source uses.

## Launching

Each script is meant to run in its own visible terminal window (a local-LLM process dying
silently in the background is the one failure mode you can't see coming):

```powershell
$env:AGENT_MANAGER_REPO_ROOT = 'C:\path\to\your\repo'
node .\src\task-sources.js  # optional one-shot smoke test
powershell -File .\src\ornith-worker.ps1 -InstanceId worker-1
powershell -File .\src\review-runner.ps1
powershell -File .\src\apply-runner.ps1
powershell -File .\src\queue-watchdog.ps1
```

## License

MIT — see `LICENSE`.
