"""Compact digest of docs/agents/codebase-map.md, injected at session start.

Why this exists (2026-10-02, after reviewing obra/superpowers): CLAUDE.md says "check
docs/agents/codebase-map.md first", but that is advisory -- nothing makes an agent do it,
and the cheapest-lookup doc only pays off if it is consulted BEFORE grepping. superpowers'
fix is a SessionStart hook that injects its entry skill so the check can't be skipped. This
module is the single implementation of that idea for agent-manager, shared by:

  * the Claude Code SessionStart hook (`python3 python/dashboard/codebase_map_digest.py`,
    which prints the hook JSON; see scripts/hooks/README or docs/agents/codebase-map.md), and
  * the in-app Chat panel (chat_sessions.py), for both the local and Claude providers.

It deliberately injects a DIGEST, not the whole 15KB map: the lookup rule, the row labels of
every table (so the agent can tell at a glance whether its feature is covered), and the
"Recurring work processes" table in full. The map file itself stays the source of detail --
the digest names its path and says to read it. A repo without a map yields "" and never an
error (best-effort, same contract as chat_sessions._read_agents_md).
"""
import json
import re
import sys
from pathlib import Path

MAP_RELPATH = Path("docs") / "agents" / "codebase-map.md"
# The real digest is ~2KB. Generous cap, only guards a pathological map.
DIGEST_MAX_CHARS = 6000
_RECURRING_HEADING = "## Recurring work processes"


def _sections(text: str) -> list:
    """[(heading, body)] split on `## ` headings, preserving order."""
    parts = re.split(r"(?m)^(## .+)$", text)
    return [(parts[i].strip(), parts[i + 1]) for i in range(1, len(parts) - 1, 2)]


def _row_labels(body: str) -> list:
    """First cell of every table data row in a section, plus bold sub-group titles
    (Section 3 is bullet lists under `**Group**` lines, not tables)."""
    labels = []
    for line in body.splitlines():
        if line.startswith("|"):
            first = line.split("|")[1].strip()
            if first and not set(first) <= set("-: ") and first.lower() not in ("tab", "route", "process"):
                labels.append(first)
        else:
            m = re.fullmatch(r"\*\*(.+)\*\*", line.strip())
            if m:
                labels.append(m.group(1))
    return labels


def build_digest(repo_root) -> str:
    try:
        text = (Path(repo_root) / MAP_RELPATH).read_text(encoding="utf-8")
    except OSError:
        return ""
    if not text.strip():
        return ""
    out = [
        f"CODEBASE MAP -- check `{MAP_RELPATH.as_posix()}` FIRST, before grepping, guessing, "
        "or searching for where a dashboard tab, backend route, or core pipeline mechanism "
        "lives. It is the cheapest lookup; read the file (or grep it) for exact paths and "
        "line ranges. If you had to search for something it doesn't list, add a row for it "
        "once you find it -- that is the whole maintenance model.",
        "",
        "What it covers (row labels only -- details are in the file):",
    ]
    recurring = ""
    for heading, body in _sections(text):
        if heading == _RECURRING_HEADING:
            recurring = body.strip()
            continue
        labels = _row_labels(body)
        if labels:
            out.append(f"- {heading.removeprefix('## ')}: " + "; ".join(labels))
    if recurring:
        out += ["", "Recurring work processes -- if your task matches one, read its doc before starting:", recurring]
    digest = "\n".join(out)
    if len(digest) > DIGEST_MAX_CHARS:
        digest = digest[:DIGEST_MAX_CHARS] + "\n...[truncated]"
    return digest


def _find_repo_root(start: Path):
    """Nearest ancestor of `start` holding the map -- so the hook works from any subdir
    and silently no-ops (returns None) everywhere else, e.g. cwd=/home/wok."""
    for d in [start, *start.parents]:
        if (d / MAP_RELPATH).is_file():
            return d
    return None


def main(argv=None) -> int:
    """Claude Code SessionStart hook entry: prints hookSpecificOutput JSON, or nothing."""
    root = _find_repo_root(Path.cwd())
    digest = build_digest(root) if root else ""
    if digest:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "SessionStart", "additionalContext": digest}}))
    return 0  # never fail a session start over a missing/odd map


if __name__ == "__main__":
    sys.exit(main())
