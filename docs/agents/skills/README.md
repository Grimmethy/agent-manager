# Shipped Claude Code skills

| Skill | Use it when |
|---|---|
| `act-as-local-agent` | you want to walk one adhoc/brain-dump task through the real pipeline stages by hand (you do the work instead of the local model; review and apply stay real) |
| `verify-unmerged-branches` | you want a merge / hold / fix-first / discard verdict for every branch in the dashboard's Unmerged Branches tab |

Install (symlinks into `~/.claude/skills`): `scripts/install-skills.sh`, then restart Claude Code.

Both assume `agent-manager.env` is set up and the dashboard is running on `:7420`. Set
`AGENT_MANAGER_CORE_REPO_ROOT` to your checkout before using them. Read `CONTEXT.md`,
`AGENTS.md`, `CLAUDE.md` and `docs/agents/codebase-map.md` first.
