"""Catalog helpers: topology fallbacks, task-source families, architecture-candidate parsing, brain-dump serials, concept and chat constants and project-name slugs.

Moved verbatim out of app.py (2026-10-01 breakdown). app.py re-exports every name below, so `from app import X` and `app.X` keep working."""

import json
import os
import re
import threading
from flask import abort, request
from pathlib import Path
from app_settings_helpers import PACKAGE_ROOT, QUEUE_STATES


def _find_live_task_file(qdir: Path, task_id: str) -> Path | None:
    """Same search order as api_task_anywhere above (drafting first, then every
    QUEUE_STATES dir, then adhoc/), but returns the actual file Path instead of its
    parsed content -- for a route that needs to WRITE the file back, not just display it.
    Deliberately does not search the done/_archived* trees api_task_anywhere also checks:
    a task that has already reached a terminal, archived state is never read by
    next-claimable-task.js's claim ranking again, so there's nothing for a priority flag
    to affect there."""
    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        for candidate in drafting_root.rglob(f"{task_id}.json"):
            return candidate
    for state in QUEUE_STATES:
        p = qdir / state / f"{task_id}.json"
        if p.is_file():
            return p
    adhoc_p = qdir / "adhoc" / f"{task_id}.json"
    if adhoc_p.is_file():
        return adhoc_p
    return None


def _adhoc_task_excerpt(data):
    """Short status-relevant snippet for the Adhoc Tasks list -- whichever field
    actually carries the human-relevant signal for wherever the task currently sits,
    same fields api_alerts() already reads for the same reason."""
    if data.get("blockedReason"):
        return data["blockedReason"][:200]
    if data.get("localVerdict") or data.get("ornithVerdict"):
        return (data.get("localVerdict") or data["ornithVerdict"])[:200]
    return None


# `node src/task-sources.js --dump-topology` reads the REAL registry (this repo's built-ins
# PLUS any AGENT_MANAGER_REGISTER_PATH plugin sources -- agent-manager-hygiene owns
# observability/performance/function-length/arch/unused-export), so the Job List catalog,
# default priorities, worker types and candidate-doc paths below no longer drift the way a
# hand-maintained TASK_SOURCE_CATALOG did. Cached briefly (several endpoints hit it per
# page load); on any failure we fall back to a committed snapshot so a transient node/env
# hiccup blanks nothing -- never to a hand-typed list.
_TOPOLOGY_FALLBACK_PATH = Path(__file__).resolve().parent / "task_source_topology_fallback.json"


_topology_cache: dict = {"at": 0.0, "value": None}


_TOPOLOGY_TTL_SECONDS = 5.0


def _load_topology_fallback() -> list[dict]:
    try:
        return json.loads(_TOPOLOGY_FALLBACK_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


# Several registered sources are really one pipeline the operator wants to steer with a
# single priority knob -- arch_discovery / arch_import / arch_review / arch_import_review
# are the "Architecture review" family, and observability / product_spec / performance /
# function_length / change_review / backlog / pipeline_forensics have the same
# generator + consumer (+ variant) shape. This grouping is PURELY a dashboard convenience
# derived from the source name: the registry, the priority ladder, and the running
# pipeline are untouched, and every member keeps its own independent
# AGENT_MANAGER_TASK_PRIORITIES override underneath (expand the group to edit one row).
# A trailing "_<suffix>" is stripped recursively, so arch_import_review -> arch_import ->
# arch. The suffix list is deliberately conservative -- "audit" is absent because
# pipeline_self_audit / pipeline_health_audit / staleness_audit / ui_visibility_audit are
# unrelated singletons, not a family; a suffix only belongs here once it names a real
# generator/consumer/variant split in the live catalog.
_FAMILY_MEMBER_SUFFIXES = (
    "review", "fix", "digest", "discovery", "import",
    "outline", "section", "decomposition", "fulfillment",
)


_FAMILY_LABELS = {
    "arch": "Architecture review",
    "observability": "Observability review",
    "performance": "Performance review",
    "function_length": "Function-length review",
    "change": "Change review",
    "product_spec": "Product spec",
    "pipeline_forensics": "Pipeline forensics",
    "backlog": "Backlog decomposition",
}


def task_source_family_key(name: str) -> str:
    """The family a source belongs to (recursive `_<suffix>` strip), or its own name when
    it stands alone. Not every returned key is a real family -- see task_source_families()."""
    key = name
    while True:
        for suf in _FAMILY_MEMBER_SUFFIXES:
            if key.endswith("_" + suf) and len(key) > len(suf) + 1:
                key = key[: -(len(suf) + 1)]
                break
        else:
            return key


def task_source_family_label(key: str) -> str:
    return _FAMILY_LABELS.get(key) or key.replace("_", " ").capitalize()


# Same heading convention candidates-doc-merge.js declares as HEADING_RE -- one parser
# per language, both reading the exact format applyArchDiscoveryCandidates() writes.
ARCH_CANDIDATE_HEADING_RE = re.compile(r"^#{1,6}\s*AC-(\d+)\b[^\S\n]*[·\-:]?[^\S\n]*(.*)$", re.M)


def parse_arch_candidates(text: str) -> list[dict]:
    """Splits a *_CANDIDATES.md doc into its '### AC-N · Title' blocks. Returns
    [{id, title, strength, files, content}] in doc order; preamble (everything before
    the first AC heading) is dropped -- it's boilerplate about the format itself."""
    entries = []
    blocks = re.split(r"(?=^#{1,6}\s*AC-\d+)", text.replace("\r\n", "\n"), flags=re.M)
    for block in blocks:
        block = block.strip()
        m = ARCH_CANDIDATE_HEADING_RE.match(block)
        if not m:
            continue
        strength = None
        files = None
        for line in block.splitlines()[1:8]:  # metadata lines sit right under the heading
            if line.startswith("Strength:"):
                strength = line[len("Strength:"):].strip()
            elif line.startswith("Files:"):
                files = [p.strip() for p in line[len("Files:"):].split(",") if p.strip()]
        entries.append({
            "id": int(m.group(1)),
            "title": m.group(2).strip() or f"AC-{m.group(1)}",
            "strength": strength,
            "files": files or [],
            "content": block,
        })
    return entries


def _assign_brain_dump_serials(entries: list) -> bool:
    """Backfills a stable #N serial onto any entry that doesn't have one yet, so the
    user has a short, stable handle to reference a specific entry by ("entry #12")
    instead of its long slugified id. New entries get one at capture time (see
    api_brain_dump_capture); this covers every entry that existed before that changed
    and self-heals if brain-dump.json is ever hand-edited to drop the field. Assigns in
    capturedAt order (oldest first) so backfilled numbers land in a sensible reading
    order rather than dict/file order, continuing from whatever the current max already
    is so a re-run never reassigns or collides with a number already handed out.
    Returns True if anything changed, so the caller knows to persist it."""
    missing = [e for e in entries if isinstance(e, dict) and not e.get("serial")]
    if not missing:
        return False
    next_serial = max((e.get("serial") or 0) for e in entries if isinstance(e, dict)) + 1 if entries else 1
    for e in sorted(missing, key=lambda e: e.get("capturedAt") or ""):
        e["serial"] = next_serial
        next_serial += 1
    return True


def slugify_for_id(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "entry"


def _task_state_index(qdir) -> dict:
    """One-pass task-id -> queue-state lookup, built once per /api/brain-dump call rather
    than one filesystem round-trip per entry. Confirmed live 2026-08-16: every one of a
    real user's "actioned" brain-dump entries was silently sitting in blocked/ (truncated
    drafts, fabricated file paths, one that was pure meta-commentary refusing the work) --
    completely invisible from the Brain Dump tab, which only ever showed the static
    "actioned"/"queued" badge regardless of what actually happened to the task downstream.
    Covers every location a task can really be sitting in: each QUEUE_STATES dir, the
    manual-archive folder (api_task_archive's own destination), and drafting/ (per-worker
    subfolders, matching /api/queue/drafting's own legacy-no-subfolder fallback)."""
    index = {}
    if not qdir:
        return index
    for state in QUEUE_STATES:
        state_dir = qdir / state
        if not state_dir.is_dir():
            continue
        for f in state_dir.glob("*.json"):
            index[f.stem] = state
    archived_dir = qdir / "done" / "_archived_no_action"
    if archived_dir.is_dir():
        for f in archived_dir.glob("*.json"):
            index[f.stem] = "archived"
    # done-archive.js's own dated month buckets (2026-08-24) -- a task the automatic daily
    # archive pass relocated is exactly as "archived" as one a human moved by hand above;
    # without this, a task's Brain Dump badge would silently go blank (not found anywhere
    # in this index) the moment it aged out of done/'s top level, the same invisible-status
    # bug this whole index was built to fix in the first place.
    dated_archive_root = qdir / "done" / "_archived"
    if dated_archive_root.is_dir():
        for month_dir in dated_archive_root.iterdir():
            if not month_dir.is_dir():
                continue
            for f in month_dir.glob("*.json"):
                index[f.stem] = "archived"
    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        for sub in drafting_root.iterdir():
            if sub.is_dir():
                for f in sub.glob("*.json"):
                    index[f.stem] = "drafting"
        for f in drafting_root.glob("*.json"):  # legacy: no per-worker subfolder
            index[f.stem] = "drafting"
    return index


# Module-level (not inline in api_brain_dump) so api_summary's nav-badge count can share
# the EXACT same definition -- confirmed live 2026-08-18: the tab's own default filter
# already surfaced every actioned-but-stuck entry correctly (taskStatus badges, built
# 2026-08-16), but the nav sidebar's Brain Dump count (api_summary, below) only ever
# counted status != 'actioned' -- captured/sorted, never a stuck-actioned entry -- so a
# real backlog of 27 actioned-but-blocked/needs-clarification/awaiting-confirm entries
# gave ZERO signal at the nav level. Discovering them required opening the tab with no
# filter and remembering to check, exactly the manual-audit gap this pair of definitions
# closes: one source of truth for "needs attention," read by both the badge count and the
# tab's own default view, so they can't drift the way two independently-hand-maintained
# lists always eventually do in this codebase (see drift-scan.js's whole existence).
BRAIN_DUMP_NEEDS_ATTENTION_STATES = {"blocked", "needs-clarification", "awaiting-confirm"}


def _brain_dump_needs_attention_count(entries):
    return sum(
        1 for e in entries
        if e.get("status") == "actioned" and e.get("taskStatus") in BRAIN_DUMP_NEEDS_ATTENTION_STATES
    )


GHOST_CONCEPT_ID = "concept-ghost-in-the-machine-0dbeea"


_GHOST_HAND_FIX_ACTORS = ("operator-manual", "agent-session")


def slugify_concept_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:48] or "concept"


CONCEPT_STABLE_STATUSES = ("shelved", "shipped")


def _find_concept_or_404(concepts: list, concept_id: str) -> dict:
    concept = next((c for c in concepts if c.get("id") == concept_id), None)
    if not concept:
        abort(404, description=f"no concept with id {concept_id}")
    return concept


# Matches the exact cross-reference line applyBrainDumpSort (apply-group-a.js) writes
# into a vault note when belongsToProject matches -- "Queued as adhoc task `id` in
# **label**", with an optional ", held for clarification (...)" suffix after the closing
# ** that this regex doesn't need to care about (it only needs the id/label pair).
_TASK_REF_RE = re.compile(r"Queued as adhoc task `([^`]+)` in \*\*([^*]+)\*\*")


def _call_chat(fn, *args, **kwargs):
    """Same reasoning as _call_discuss -- turn a known, actionable failure into a clean
    4xx/5xx instead of a raw 500. Local-provider tool loops and Claude calls can both fail
    the same ways Discuss's already do (auth missing, Ollama busy/timed out)."""
    from claude_client import ClaudeClientError
    from local_tool_client import LocalToolClientError
    try:
        return fn(*args, **kwargs)
    except ClaudeClientError as e:
        abort(502, description=str(e))
    except LocalToolClientError as e:
        abort(502, description=str(e))
    except (TimeoutError, ConnectionError, OSError) as e:
        abort(502, description=f"local model call failed ({e}) -- it may be busy with an active worker-lane task; try again shortly.")


# 2026-08-31 (Grimmethy: "It should be rooted in agent manager always, and have access to
# all active plugins"): the Chat panel is system-wide, not per-project. Its transcript
# store is fixed at the agent-manager repo root, and its file tools span agent-manager
# plus every registered plugin/project repo -- NOT whatever project the pipeline happens
# to be pointed at.
CHAT_STORAGE_DIR = PACKAGE_ROOT


def _resolve_under_second_brain(root: Path, raw_path: str) -> Path:
    """Resolves raw_path against root, rejecting anything that escapes it (../ traversal,
    an absolute path elsewhere, a symlink pointing out). Unlike /api/browse (which
    intentionally allows roaming the whole filesystem, for the Project tab's repo picker),
    this only ever exposes one directory tree -- personal notes, not arbitrary disk
    contents -- so the jail is load-bearing, not optional."""
    candidate = (root / raw_path).resolve() if raw_path else root
    if candidate != root and root not in candidate.parents:
        abort(403, description="path escapes SECOND_BRAIN_DIR")
    return candidate


def _slugify_project_name(stem: str) -> str:
    """Note filename (no .md) -> filesystem/repo-friendly name: spaces to hyphens, strip
    anything that isn't alphanumeric/hyphen/underscore. Deliberately NOT lowercased --
    the real GitHub folders already mix casing (TaxHarvest-GrimmethyLocal, SGCElementals),
    so forcing one convention here would look inconsistent next to them."""
    name = stem.replace(" ", "-")
    name = re.sub(r"[^A-Za-z0-9_-]", "", name)
    return name.strip("-_") or "untitled-project"


_DEEP_DIVE_ITEM_RE = re.compile(
    r"^## (?P<title>.+?)\s*\n\n"
    r"\*\*Community:\*\* (?P<community>.+?)\s*\n"
    r"\*\*Rating:\*\* (?P<rating>.+?)\s*\n"
    r"(?:\*\*Files:\*\* (?P<files>.+?)\s*\n)?"
    r"\n(?P<rationale>.*?)(?=\n## |\Z)",
    re.MULTILINE | re.DOTALL,
)


_COMMUNITY_ID_SUFFIX_RE = re.compile(r"^(?P<name>.*?)\s*\(community #(?P<id>\d+)\)\s*$")


def _grep_dirs_from_query() -> list[str]:
    """Matches the frontend's comma-separated grepDirs input convention -- the same
    string already sent to /api/project/build, now also needed by the read/write routes
    below so they resolve the same per-grepDirs cache slot a build wrote to."""
    raw = request.args.get("grepDirs", "").strip()
    return [d.strip() for d in raw.split(",") if d.strip()]


# Daemon-script command-line fragments scripts/launch.sh starts and scripts/stop.sh
# stops -- the same set stop.sh's own stray-sweep matches (minus the dashboard, which is
# always running and is not "the pipeline"). Used for a real process check so this file
# never again has to trust a heartbeat timestamp alone to decide whether a stop is
# possible. Matched with `pgrep -f` against the script path fragment, so it works whether
# the pipeline dir is the real path or a symlink to it.
_PIPELINE_DAEMON_PGREP_RE = r"agent-manager/scripts/(launch|local-worker|review-runner|queue-watcher)\.sh|agent-manager/scripts/\.\./src/(local-draft|apply-task)\.js"


def _pid_alive(pid) -> bool:
    """True if `pid` names a live process (whether or not this user can signal it)."""
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by another user
    except (TypeError, ValueError, OverflowError):
        return False


_BRANCH_CACHE_TTL_SECONDS = 45


_branch_cache = {"at": 0.0, "branches": []}


_branch_cache_lock = threading.Lock()
