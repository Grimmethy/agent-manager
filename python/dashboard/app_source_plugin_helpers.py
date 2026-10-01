"""Task-source, job-log and plugin helpers: domain and approval-mode tables, source-name resolution, live counts, plugin tab and catalog validation, GPU lease and loopback checks.

Moved verbatim out of app.py (2026-10-01 breakdown). app.py re-exports every name below, so `from app import X` and `app.X` keep working."""

import fcntl
import json
import logging
import os
import re
import time
from datetime import datetime
from pathlib import Path, PurePosixPath
from app_settings_helpers import QUEUE_STATES, logger


# Same well-known lockfile apply-task.sh itself flocks (scripts/apply-task.sh's own header
# comment explains why: the race is about the shared git working tree, not this project's
# pipelineDir, so it has to be the same fixed path regardless of caller). A merge from
# here does the same fetch/reset/branch-touching sequence apply-task.sh's loop does every
# ~30s -- without this, a merge click racing that loop mid-apply would corrupt the
# other's half-finished branch/index state, exactly the failure mode that lockfile
# already exists to prevent between apply-task.sh's own two callers.
def _acquire_apply_lock(timeout_seconds=5):
    lock_dir = Path.home() / ".local" / "state" / "agent-manager" / "locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_path = lock_dir / "apply-task.lock"
    lock_fd = open(lock_path, "w")
    deadline = time.time() + timeout_seconds
    while True:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock_fd
        except BlockingIOError:
            if time.time() >= deadline:
                lock_fd.close()
                # A silent None return here used to leave no trace of WHY a caller aborted
                # 409 -- indistinguishable in the logs from any other 409. apply-task.sh is
                # the well-known usual holder (see this function's header comment).
                logging.warning(
                    "could not acquire %s within %ss -- apply-task.sh (or another dashboard "
                    "operation) is likely still holding it", lock_path, timeout_seconds,
                )
                raise RuntimeError(
                    f"could not acquire {lock_path} within {timeout_seconds}s -- apply-task.sh "
                    "(or another dashboard operation) is likely still holding it"
                )
            time.sleep(0.5)


def _release_apply_lock(lock_fd):
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
    finally:
        lock_fd.close()


_COMMIT_LOG_FIELD_SEP = "\x1f"  # unit separator -- won't collide with real commit text


_COMMIT_LOG_RECORD_SEP = "\x1e"  # record separator between commits


# Exempt from any allowlist restriction regardless of stored state -- task-sources.js's
# getNextTask() hardcodes this same exemption ('adhoc': fixed contract per README,
# "preempts every deterministic source"; 'brain_dump_sort': always-on background source,
# confirmed live 2026-07-23 it was silently getting gated out by Project Search mode's
# allowlist before that fix). Presenting either as toggleable in the UI would be a lie.
# 'path_prefetch_resolve' joins them 2026-08-16: it only ever exists to resolve a held
# task brain_dump_sort's own always-on pipeline produced -- gating it behind a
# project-mode allowlist would mean held tasks silently never get an LLM-suggestion
# attempt whenever that allowlist doesn't happen to include it.
ALWAYS_ACTIVE_SOURCES = {"adhoc", "brain_dump_sort", "path_prefetch_resolve"}


VALID_WORKER_TYPES = ("ornith", "reasoning")


VALID_APPROVAL_MODES = ("auto", "prompt", "approve")


# workDirKind/successCheck values that satisfy review-runner.ps1's unconditional
# Get-DomainConfig lookup for each domain that apply-task.js already special-cases as a
# non-git write. Neither field is actually consulted for these domains on the real
# (ornith-provider, apply-runner) path -- successCheck only matters for the 'claude'
# REVIEW_PROVIDER branch, which nothing here uses -- so any valid placeholder works; kept
# identical to "default" for simplicity rather than inventing a new value with no
# behavioral difference.
# Maps a task-source NAME (TASK_SOURCE_CATALOG's entries) to the DOMAIN KEY it actually
# stamps onto its tasks. Most built-ins use their own name as the domain (project_search,
# deep_dive, brain_dump_sort, secondbrain) -- but seven of them (trouble_log, arch_review,
# arch_import_review, arch_discovery, arch_import, observability_review, performance_review,
# unused_export) all share the single 'default' domain (task-sources.js's defaultDomain),
# since task-sources.js's own getConfig().defaultDomain is what nextCandidateFulfillmentTask/
# nextTroubleLogTask/nextArchDiscoveryTask/nextArchImportTask/nextObservabilityReviewTask/
# nextPerformanceReviewTask/nextUnusedExportTask all stamp -- confirmed by reading each one directly, not assumed
# from the source name. Getting this mapping WRONG (or incomplete) is exactly what
# happened before this fix: 'default' was missing entirely from _DOMAIN_DEFAULTS_TO_ENSURE,
# so every arch_import/observability_review/trouble_log task failed immediately with
# "Unknown task domain: default" from its very first run against a freshly-started project
# (confirmed live 2026-07-26 on TaxHarvest: 250 tasks accumulated blocked before anyone
# noticed, since a blocked task produces no visible error beyond the Blocked tab's count).
_SOURCE_TO_DOMAIN_KEY = {
    "trouble_log": "default", "arch_review": "default", "arch_import_review": "default",
    "arch_discovery": "default", "arch_import": "default", "observability_review": "default",
    "performance_review": "default", "observability_fix": "default", "performance_fix": "default",
    "unused_export": "default",
    "project_search": "project_search", "deep_dive": "deep_dive",
    "brain_dump_sort": "brain_dump_sort", "secondbrain": "secondbrain", "adhoc": "adhoc",
    "derived_task": "adhoc",
    "path_prefetch_resolve": "path_prefetch_resolve", "pipeline_self_audit": "adhoc",
    "pipeline_forensics": "default", "pipeline_forensics_fix": "default",
    "change_review": "default", "change_review_fix": "default",
    "staleness_audit": "default",
    "product_spec": "default", "product_spec_outline": "default", "product_spec_section": "default",
    "backlog_decomposition": "default", "backlog_fulfillment": "default",
}


_DOMAIN_DEFAULTS_TO_ENSURE = {
    "default": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "adhoc": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "secondbrain": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "project_search": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "deep_dive": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "brain_dump_sort": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
    "path_prefetch_resolve": {"workDirKind": "repoRoot", "successCheck": "git-branch-diff"},
}


# adhoc, brain_dump_sort, and (2026-08-16) path_prefetch_resolve are always in
# read_active_job_types()'s result regardless of any allowlist (see ALWAYS_ACTIVE_SOURCES
# above) -- ensure their domains unconditionally, a belt-and-suspenders floor in case some
# future call site ever passes a hand-built task_sources list that forgot one, since the
# failure mode ("Unknown task domain") is silent and easy to miss (as just proven).
_ALWAYS_ENSURE_DOMAINS = ["brain_dump_sort", "adhoc", "path_prefetch_resolve"]


# Human-readable domain label per domain KEY, for the Job List "Domain" column. The
# "default" key shows "(project default)" -- it's whatever the active project's
# defaultDomain resolves to, not a literal.
SOURCE_DOMAIN_LABELS = {"default": "(project default)"}


# One-line description per source name, for the Job List row. UI copy, not registry data --
# kept here (server-side, one place) rather than in a client-side JOB_TYPES const that
# drifted from the real registry. /api/job-types serves it; a source with no entry just
# renders a blank description cell.
SOURCE_DESCRIPTIONS = {
    "adhoc": "Manually submitted one-off task, queued via queue-adhoc-task.js. Drop-everything priority lane.",
    "derived_task": "Pipeline-DERIVED follow-up work (a pipeline_debrief Now-What item, a passive side-finding) that brain_dump_sort routed to queue/derived/. Adhoc-shaped, but its own throttleable lane at priority 48 -- it does NOT preempt deterministic sources the way genuine adhoc does.",
    "research_task": "A captured Brain Dump entry brain_dump_sort classified as requiresResearch (queue/research/*.json), drafted by research-agentic-draft.js's WebSearch/WebFetch-backed agentic call. Always high-reasoning-tier. Same \"drop everything\" priority as adhoc.",
    "trouble_log": "Entries in the project's trouble-log doc flagged ready-for-agent (\U0001f916 marker).",
    "secondbrain": "Oldest unprocessed note in a SecondBrain-style Inbox/ folder.",
    "brain_dump_sort": "Sorts a captured Brain Dump entry into a second-brain destination and marks it filed. Always active -- see the Brain Dump tab.",
    "path_prefetch_resolve": "LLM-assisted fallback for a queue/needs-clarification/ held task path-prefetch's deterministic keyword match could not resolve -- suggests file path(s) + rationale for a human to accept or override, never auto-resolves. Always active.",
    "arch_review": "Strong-rated architecture candidates awaiting a fulfillment task. (agent-manager-hygiene plugin.)",
    "arch_import_review": "Strong-rated architecture-IMPORT candidates (from arch_import) awaiting a fulfillment task. (agent-manager-hygiene plugin.)",
    "arch_discovery": "Generates new architecture candidates for one graphify community at a time. (agent-manager-hygiene plugin.)",
    "arch_import": "Promotes a reviewed deep_dive Use/Adapt finding into an agent-manager-grounded architecture-import candidate (ADR-0020). (agent-manager-hygiene plugin.)",
    "observability_review": "Triages a deterministically-flagged observability-hygiene issue (silent catch, unguarded loop, OTel naming) in the active project as genuine or false-positive; a genuine verdict writes a candidate for observability_fix. (agent-manager-hygiene plugin.)",
    "observability_fix": "Consumes a Strong observability_review candidate into a real code fix, against OBSERVABILITY_FIX_CANDIDATES.md. (agent-manager-hygiene plugin.)",
    "performance_review": "Triages a deterministically-flagged performance issue (sync I/O in a loop, sequential await, JSON deep-clone) in the active project; a genuine verdict writes a candidate for performance_fix. (agent-manager-hygiene plugin.)",
    "performance_fix": "Consumes a Strong performance_review candidate into a real code fix, against PERFORMANCE_FIX_CANDIDATES.md. (agent-manager-hygiene plugin.)",
    "function_length_review": "Triages a deterministically-flagged over-long function in the active project as a genuine maintainability problem or false-positive; a genuine verdict writes a decomposition candidate for function_length_fix. (agent-manager-hygiene plugin.)",
    "function_length_fix": "Consumes a Strong function_length_review candidate into a real decomposition diff, against FUNCTION_LENGTH_CANDIDATES.md. (agent-manager-hygiene plugin.)",
    "deep_dive": "Reviews one import-graph community at a time from a project_search Strong lead's cloned repo, rating each finding Use/Adapt/Ignore (ADR-0019). See the Scouted Repos tab.",
    "project_search": "Proposes external open-source leads relevant to the project. Discovery-only, no auto-fulfillment.",
    "unused_export": "Triages a flagged dead-code candidate (exported symbol with few call sites) as genuine-dead or false-positive. (agent-manager-hygiene plugin.)",
    "pipeline_self_audit": "Deterministically scans queue/blocked/ for a cluster of tasks failing the same way; files an adhoc task asking a Claude agentic pass to find and fix the root cause. Always requires human confirmation.",
    "pipeline_health_audit": "Periodic deterministic check of the pipeline's own health signals; files an advisory when something looks wrong.",
    "pipeline_forensics": "Deep root-cause study of a class of pipeline tasks that keeps failing: assembles evidence (incl. a contrast set of tasks that succeeded), drafts a ranked root-cause report, holds it for human confirmation, then files a pipeline-fix candidate. Triggered by a needs-clarification cluster, a low-shipped-value task source, or an on-demand request.",
    "pipeline_forensics_fix": "Turns a confirmed pipeline_forensics fix candidate (Docs/PIPELINE_FIX_CANDIDATES.md) into a real src/ diff on an agent/ branch for manual merge.",
    "change_review": "Reviews the diff of each unit merged to the main branch for correctness regressions only (off-by-one, dropped error path, wrong variable, un-updated callers of a changed signature). Confirmed findings become fix candidates in Docs/CHANGE_REVIEW_CANDIDATES.md. (agent-manager-hygiene plugin.)",
    "change_review_fix": "Turns a change_review finding (Docs/CHANGE_REVIEW_CANDIDATES.md) into a real diff + regression test on an agent/ branch for manual merge. (agent-manager-hygiene plugin.)",
    "ui_visibility_audit": "Checks that pipeline state a human needs is actually surfaced in the dashboard; files an advisory for a gap.",
    "staleness_audit": "Deterministically scans queue/blocked/ and queue/needs-clarification/ for an old or repeatedly-rejected task; files an advisory asking whether the original concern still holds. Never applies anything.",
    "product_spec": "GREENFIELD lane: drafts or updates a concept-only product's spec doc blind on the local model (request text + current spec are the only grounding). A brownfield request goes to product_spec_outline instead.",
    "product_spec_outline": "BROWNFIELD lane, step 1: decomposes a product-spec request against a real codebase into ordered AC-NNN section candidates in PRODUCT_SPEC_OUTLINE.md, on the local model, grounded by harness grep. Its apply also seeds PRODUCT_SPEC.md as a marker skeleton.",
    "product_spec_section": "BROWNFIELD lane, step 2: drafts one PRODUCT_SPEC_OUTLINE.md section at a time (candidate-fulfillment) into its placeholder block in PRODUCT_SPEC.md, on the local model, grounded by that section's files plus its own harness grep.",
    "backlog_decomposition": "Breaks a product-spec backlog item into AC-NNN candidates in BACKLOG_CANDIDATES.md.",
    "backlog_fulfillment": "Consumes a Strong BACKLOG_CANDIDATES.md entry into a real diff -- same fulfillment logic as arch_review.",
}


def _resolve_source_name(data: dict) -> str | None:
    """Mirrors src/task-source-registry.js's resolveSourceName() exactly -- most sources
    register under the same name as task.source, but three built-ins don't: adhoc tasks
    carry domain:'adhoc'/source:'manual', secondbrain tasks carry domain:'secondbrain'
    (source:'inbox'), and deadcode_triage was renamed to unused_export post-launch. Without
    this, every real adhoc task (a real, common, human-originated task type) would show up
    under an "(unregistered)" bucket labeled "manual" instead of the adhoc node on the map
    -- confirmed live building this: exactly that happened on the first real test.

    A file that parses as JSON but is not an object (a list or scalar -- a partial write, a
    stray payload) has no fields to read; it resolves to None, which callers bucket under
    "(unknown)" (change_review AC-77: it used to raise AttributeError and 500 /api/pipeline-map)."""
    if not isinstance(data, dict):
        return None
    domain = data.get("domain")
    source = data.get("source")
    if domain == "adhoc" or source == "manual":
        return "adhoc"
    if domain == "secondbrain":
        return "secondbrain"
    if source == "deadcode_triage":
        return "unused_export"
    return source


def _pipeline_live_counts(qdir) -> dict:
    """{source: {state: count}} across every in-flight queue state -- deliberately excludes
    done/ (thousands of historical records -- see queue_dir()'s own caller sites for the
    3700+ count confirmed live 2026-08-25) since the Pipeline Map tab shows the pipeline IN
    MOTION, not lifetime volume (that's what the Job List tab's timesPerformed counter is
    for). 'drafting' mirrors _task_state_index's own per-worker-subfolder-plus-legacy-flat
    handling. A task file with no readable/parseable `source` field (corrupt, mid-write, or
    predates this field existing) is bucketed under "(unknown)" rather than silently
    dropped or crashing the whole tab over one bad file."""
    counts: dict = {}
    if not qdir:
        return counts

    def bump(source, state):
        counts.setdefault(source or "(unknown)", {}).setdefault(state, 0)
        counts[source or "(unknown)"][state] += 1

    for state in QUEUE_STATES:
        if state == "done":
            continue
        state_dir = qdir / state
        if not state_dir.is_dir():
            continue
        for f in state_dir.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to read/parse queue state file %s: %s", f, exc)
                bump(None, state)
                continue
            bump(_resolve_source_name(data), state)

    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        drafting_files = list(drafting_root.glob("*.json"))
        for sub in drafting_root.iterdir():
            if sub.is_dir():
                drafting_files.extend(sub.glob("*.json"))
        for f in drafting_files:
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to read/parse drafting file %s: %s", f, exc)
                bump(None, "drafting")
                continue
            bump(_resolve_source_name(data), "drafting")

    return counts


def _job_log_task_dirs(qdir):
    """Every location a task JSON can sit -- same set _task_state_index walks -- yielded as
    (state_label, dir_path) so a per-source history sweep sees in-flight, done, and
    archived runs alike."""
    for state in QUEUE_STATES:
        yield state, qdir / state
    yield "adhoc", qdir / "adhoc"
    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        for sub in sorted(drafting_root.iterdir()):
            if sub.is_dir():
                yield "drafting", sub
        yield "drafting", drafting_root  # legacy: no per-worker subfolder
    yield "archived", qdir / "done" / "_archived_no_action"
    dated_archive_root = qdir / "done" / "_archived"
    if dated_archive_root.is_dir():
        for month_dir in sorted(dated_archive_root.iterdir(), reverse=True):
            if month_dir.is_dir():
                yield "archived", month_dir


def _job_log_row_when(data: dict):
    hist = data.get("history") or []
    last_at = hist[-1].get("at") if hist and isinstance(hist[-1], dict) else None
    return data.get("updatedAt") or last_at or data.get("createdAt") or ""


def _job_log_outcome(data: dict) -> str:
    # Same signal priority as the Discovery tab's runRows / _adhoc_task_excerpt.
    if data.get("blockedReason"):
        return str(data["blockedReason"])[:200]
    if data.get("doneMarker"):
        return str(data["doneMarker"])
    if data.get("implementResponse"):
        return "draft written"
    if data.get("planResponse"):
        return "plan written"
    return ""


def _plugin_name_from_path(register_path: str) -> str:
    """A readable default name: the plugin repo's own directory name (…/agent-manager-hygiene/
    register.js -> "agent-manager-hygiene"), falling back to the file's parent basename."""
    p = Path(register_path)
    parent = p.parent
    return parent.name or p.stem or register_path


def _manifest_tabs_enabled() -> bool:
    """Kill switch for the whole feature (section 5): AGENT_MANAGER_MANIFEST_TABS=false
    turns every plugin-declared tab back off, both in GET /api/plugins (which the tab-bar
    merge reads) and in the ui/ asset route, without touching plugins.json itself. Enabled
    by default -- purely additive with no plugin declaring a tab."""
    return os.environ.get("AGENT_MANAGER_MANIFEST_TABS", "true").strip().lower() != "false"


def _validate_plugin_tab(tab) -> str | None:
    """Validates a plugin manifest entry's optional 'tab' dict. Returns an error string or
    None. Does not check that `script` exists on disk -- the file route (a later piece)
    does that at request time, since the plugin directory can change after this entry is
    written."""
    if not isinstance(tab, dict):
        return "tab must be an object"
    unknown = set(tab) - {"key", "label", "description", "group", "kind", "script", "replaces"}
    if unknown:
        return f"tab has unknown key(s): {', '.join(sorted(unknown))}"
    for field in ("key", "label"):
        if not isinstance(tab.get(field), str) or not tab[field].strip():
            return f"tab.{field} must be a non-empty string"
    if tab.get("kind") != "script":
        return "tab.kind must be 'script' (the only supported kind)"
    script = tab.get("script")
    if not isinstance(script, str) or not script.strip():
        return "tab.script must be a non-empty string"
    script_path = PurePosixPath(script)
    if script_path.is_absolute() or ".." in script_path.parts:
        return "tab.script must be a relative path with no '..' segments"
    if script_path.parts[:1] != ("ui",) or script_path.suffix != ".js":
        return "tab.script must be under 'ui/' and end in '.js'"
    for field in ("description", "group", "replaces"):
        if field in tab and (not isinstance(tab[field], str) or not tab[field].strip()):
            return f"tab.{field} must be a non-empty string"
    return None


def _validate_catalog_source(src):
    """Validates a catalog entry's 'source' dict. Returns an error string or None."""
    if not isinstance(src, dict):
        return "source must be an object"
    unknown = set(src) - {"type", "url", "ref"}
    if unknown:
        return f"source has unknown key(s): {', '.join(sorted(unknown))}"
    if src.get("type") not in ("git", "npm"):
        return "source.type must be 'git' or 'npm'"
    url = src.get("url")
    if not isinstance(url, str) or not url.strip():
        return "source.url must be a non-empty string"
    if "ref" in src and (not isinstance(src["ref"], str) or not src["ref"].strip()):
        return "source.ref must be a non-empty string"
    return None


def _validate_catalog_pricing(p):
    """Validates a catalog entry's optional 'pricing' dict. Returns an error string or None."""
    if not isinstance(p, dict):
        return "pricing must be an object"
    unknown = set(p) - {"model", "amount_cents", "currency", "interval"}
    if unknown:
        return f"pricing has unknown key(s): {', '.join(sorted(unknown))}"
    model = p.get("model")
    if model not in ("free", "one-time", "subscription"):
        return "pricing.model must be 'free', 'one-time', or 'subscription'"
    if model != "free":
        amount = p.get("amount_cents")
        if not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
            return "pricing.amount_cents must be an integer >= 0"
        currency = p.get("currency")
        if not isinstance(currency, str) or not currency.strip() or len(currency) != 3:
            return "pricing.currency must be a non-empty 3-character string"
        if "interval" in p and (not isinstance(p["interval"], str) or not p["interval"].strip()):
            return "pricing.interval must be a non-empty string"
    return None


def _validate_catalog_entry(entry, index):
    """Validates one plugins[] entry. Returns an error string or None."""
    if not isinstance(entry, dict):
        return f"plugins[{index}] must be an object"
    unknown = set(entry) - {
        "id", "name", "summary", "description", "version",
        "source", "tags", "license", "min_agent_manager", "pricing",
    }
    if unknown:
        return f"plugins[{index}] has unknown key(s): {', '.join(sorted(unknown))}"
    for field in ("id", "name", "summary", "description", "version"):
        val = entry.get(field)
        if not isinstance(val, str) or not val.strip():
            return f"plugins[{index}].{field} must be a non-empty string"
    if not re.match(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.\-]+)?$", entry["version"]):
        return f"plugins[{index}].version must look like X.Y.Z or X.Y.Z-prerelease"
    src_err = _validate_catalog_source(entry.get("source"))
    if src_err:
        return f"plugins[{index}].{src_err}"
    if "tags" in entry:
        tags = entry["tags"]
        if not isinstance(tags, list) or any(not isinstance(t, str) or not t.strip() for t in tags):
            return f"plugins[{index}].tags must be a list of non-empty strings"
    for opt in ("license", "min_agent_manager"):
        if opt in entry and not isinstance(entry[opt], str):
            return f"plugins[{index}].{opt} must be a string"
    if "pricing" in entry:
        p_err = _validate_catalog_pricing(entry["pricing"])
        if p_err:
            return f"plugins[{index}].{p_err}"
    return None


def validate_plugin_catalog(doc):
    """Strict validation of the whole catalog document. Returns an error string or None."""
    if not isinstance(doc, dict):
        return "catalog must be a JSON object"
    unknown = set(doc) - {"catalog_version", "generated_at", "plugins"}
    if unknown:
        return f"catalog has unknown key(s): {', '.join(sorted(unknown))}"
    cv = doc.get("catalog_version")
    if not isinstance(cv, int) or isinstance(cv, bool) or cv < 1:
        return "catalog_version must be an integer >= 1"
    ga = doc.get("generated_at")
    if not isinstance(ga, str):
        return "generated_at must be a string"
    try:
        datetime.fromisoformat(ga)
    except (TypeError, ValueError):
        return "generated_at must be a valid ISO-8601 timestamp"
    plugins = doc.get("plugins")
    if not isinstance(plugins, list):
        return "plugins must be a list"
    seen_ids = set()
    for i, entry in enumerate(plugins):
        err = _validate_catalog_entry(entry, i)
        if err:
            return err
        if isinstance(entry, dict):
            if entry.get("id") in seen_ids:
                return f"duplicate plugin id '{entry.get('id')}'"
            seen_ids.add(entry.get("id"))
    return None


def _version_tuple(v):
    """Parses 'X.Y.Z(-tail)' into a comparable tuple; returns the (0,) sentinel for
    anything unparseable so mixed values compare safely."""
    if not isinstance(v, str):
        return (0,)
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.\-]+)?$", v)
    if not m:
        return (0,)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _installed_plugin_version(manifest, plugin_id):
    """The 'version' field of the first manifest entry whose 'name' == plugin_id, else
    None. The manifest's 'name' is the plugin repo's directory slug (see
    _plugin_name_from_path) -- the same value a catalog entry carries as 'id', NOT the
    catalog's human-readable 'name'."""
    for entry in manifest:
        if isinstance(entry, dict) and entry.get("name") == plugin_id:
            return entry.get("version")
    return None


def _acquire_gpu_lease() -> None:
    """Stomp (unlink) any ComfyUI GPU lease PromptForge left behind; failures are logged
    at debug level. Called on explicit pipeline start: an explicit start is a
    "GPU work now" signal, so the local-model daemons shouldn't yield their ticks to a
    generation that isn't the priority anymore (see comfyui_lease_held in
    agent-manager-common.sh). scripts/launch.sh does the same on the Linux path; this
    also covers the Windows .ps1 path."""
    _comfy_lease = Path(
        os.environ.get("AGENT_MANAGER_COMFY_LEASE_PATH")
        or (Path(os.environ.get("HOME") or "~").expanduser()
            / ".local/state/agent-manager/comfyui-lease.json")
    )
    try:
        _comfy_lease.unlink(missing_ok=True)
    except OSError as exc:
        logger.debug("ComfyUI lease unlink failed: %s", exc, exc_info=True)


def _is_loopback_host(host: str) -> bool:
    return host in ("127.0.0.1", "localhost", "::1")
