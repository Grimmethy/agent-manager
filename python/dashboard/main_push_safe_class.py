"""The safe diff classes of the main-push gate: when a worker `merge` verdict is enough (owner decision 2026-11-10, "option 2").

The merge-ready checker worker (agent-manager-pipeline-ops, src/checker-execute.js) records `merge` verdicts with source `worker` for docs-only, tests-only and new-files-only branches, and the merger
worker then asks the dashboard to merge them. The gate (main_push_rules.py) accepts such a verdict ONLY when it re-derives the class from the diff itself, here, with the same rules as classOf in
pipeline-ops src/checker-evidence.js: it never trusts a class the worker wrote. Everything else still needs a chat or manual verdict.
"""
import re

CHECKER_PREFIX = "Merge-ready checker worker"
SAFE_WORKER_CLASSES = ("docs-only", "tests-only", "new-files-only")

_DOC = re.compile(r"\.(md|txt|rst)$", re.I)
_TEST_DIR = re.compile(r"(^|/)tests?/")
_TEST_FILE = re.compile(r"(\.test\.(js|mjs|cjs|ts|tsx)$)|((^|/)test_[^/]*\.py$)|(_test\.py$)")
DESIGN_PATH = re.compile(r"(^|[/_.-])(decisions?|adr|design|spec|specs|proposals?|rfc|roadmap|plans?)([/_.-]|$)", re.I)
# The paths no branch may add or change: the same list as pipeline-ops src/forbidden-paths.js.
FORBIDDEN_PATTERNS = [
    re.compile(r"(^|/)node_modules(/|$)"), re.compile(r"(^|/)\.venv(/|$)"), re.compile(r"(^|/)queue/"), re.compile(r"(^|/)\.env($|\.)"),
    re.compile(r"(^|/)(secrets?|credentials?)(\.|/|$)", re.I), re.compile(r"(^|/)(plugins|projects|lanes)\.json$"), re.compile(r"(^|/)agent-manager\.env"),
    re.compile(r"\.pem$"), re.compile(r"(^|/)id_(rsa|ed25519)"),
]


def _is_doc(path):
    return bool(_DOC.search(path)) or path.startswith("docs/")


def _is_test(path):
    return bool(_TEST_DIR.search(path) or _TEST_FILE.search(path))


def classify_changes(changes, deletions=0):
    """The diff class of `changes`, a list of (status letter, path) pairs from `git diff --name-status --no-renames`; `deletions` is the number of deleted lines."""
    added = [p for s, p in changes if s == "A"]
    deleted = [p for s, p in changes if s == "D"]
    edited = [p for s, p in changes if s not in ("A", "D")]
    everything = added + edited + deleted
    if not everything:
        return "other"
    if all(_is_doc(p) and not DESIGN_PATH.search(p) for p in everything):
        return "docs-only"
    if all(_TEST_FILE.search(p) for p in everything) and not deletions > 0:
        return "tests-only"
    if not edited and not deleted and any(not _is_doc(p) and not _is_test(p) for p in added):
        return "new-files-only"
    return "other"


def forbidden_changed(changes):
    """The forbidden paths a branch adds or changes; a deleted path is never listed (deleting one is how a violation is repaired)."""
    return [p for s, p in changes if s != "D" and any(r.search(p) for r in FORBIDDEN_PATTERNS)]


def _default_base(run_git, repo_root):
    try:
        return run_git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo_root).strip()
    except (RuntimeError, OSError):
        pass
    for candidate in ("origin/master", "origin/main"):
        try:
            run_git(["rev-parse", "--verify", "--quiet", candidate], repo_root)
            return candidate
        except (RuntimeError, OSError):
            continue
    raise RuntimeError("no default branch ref (origin/HEAD, origin/master or origin/main) to diff against")


def read_diff_facts(run_git, repo_root, head_sha):
    """{"class", "files", "forbidden", "base"} for `head_sha` against the default branch. Raises on any git failure (the caller fails closed)."""
    base = _default_base(run_git, repo_root)
    span = f"{base}...{head_sha}"
    changes = []
    for line in run_git(["diff", "--name-status", "--no-renames", span], repo_root).splitlines():
        status, _, path = line.partition("\t")
        if status and path:
            changes.append((status[0], path))
    deletions = 0
    for line in run_git(["diff", "--numstat", span], repo_root).splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and parts[1].isdigit():
            deletions += int(parts[1])
    return {"class": classify_changes(changes, deletions), "files": len(changes), "forbidden": forbidden_changed(changes), "base": base}


def worker_class_applies(record, loader):
    """True when this verdict is the checker worker's own `merge` and a diff loader was supplied, i.e. the safe-class rule is the one to apply."""
    if loader is None or record.get("source") != "worker":
        return False
    reasons = record.get("reasons")
    first = reasons[0] if isinstance(reasons, list) and reasons else ""
    return isinstance(first, str) and first.startswith(CHECKER_PREFIX)


def unsafe_reason(loader):
    """Why the diff is not a safe worker class (None when it is), plus the facts: (reason or None, facts or None). A diff that cannot be read is unsafe."""
    try:
        facts = loader()
    except Exception as exc:  # noqa: BLE001 -- fail closed on any error reading the diff
        return f"the diff could not be read ({exc})", None
    if facts["forbidden"]:
        return f"the branch adds or changes forbidden paths: {', '.join(facts['forbidden'][:5])}", facts
    if facts["class"] not in SAFE_WORKER_CLASSES:
        return f"the diff class is '{facts['class']}', not one of {', '.join(SAFE_WORKER_CLASSES)}: a person must read it", facts
    return None, facts
