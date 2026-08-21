# Vendored TokenFold

Snapshot of the `core/` package from https://github.com/Gypsy46n2/tokenfold, vendored so
a single agent-manager clone is self-contained -- scripts/launch.sh finds this copy
automatically when no standalone tokenfold checkout exists next to the repo, and
provisions its venv under ~/.local/state/agent-manager/tokenfold-venv on first launch.

A sibling checkout (../tokenfold) or an explicit TOKENFOLD_DIR always takes precedence
over this copy, so developing against the real repo keeps working unchanged. To update
the snapshot: rsync the upstream repo's core/ + LICENSE over this directory (excluding
__pycache__/*.egg-info) and commit.
