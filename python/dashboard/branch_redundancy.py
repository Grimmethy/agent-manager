"""Redundancy checks for the Unmerged Branches tab: flag branches that are provably not worth merging.

Two deterministic signals, both feeding the card verdict in branch_verdicts.py (red = discard, yellow = needs-work):

1. RECURRING CANDIDATES (agent/triage-queue). The rolling triage branch appends refactor candidates to
   Docs/*_CANDIDATES.md. The candidate dedupe keys on file + first identifier, so a candidate filed under a file path
   that later moved (AC-198 applyBrainDumpSort vs the older AC-10) slips through. Here a candidate is a duplicate when
   its FUNCTION NAME, taken from the heading, already appears in a candidate heading on master, whatever file it names.
   Every added candidate a duplicate -> discard; a mix -> needs-work naming the new ones (so a genuinely new candidate
   like AC-197 is not thrown away with its duplicates).

2. SUPERSEDED ALTERNATIVES. Two open branches from DIFFERENT hubs that cannot both merge (they conflict with each
   other) are alternatives. If one actually rewires code (removes non-comment, non-export lines) and the other only
   adds unused helpers, the add-only one is superseded -> discard. Two add-only alternatives, or two rewiring ones, stay
   needs-work with the rival named: which to keep is a human call. Same-hub branches are never alternatives (stacked
   siblings legitimately touch the same lines), and a branch with no hub label is never compared.

What this does NOT do: an equivalent change that already landed on master under different code (an "already merged
rival") is not detectable without judging intent; that stays with the chat verifier (verify-unmerged-branches skill),
which records it as a discard verdict.

Standalone like branch_removals.py / branch_verdicts.py: no `import app`; the git runner is injected (app.py's _run_git).
"""
import re

_HEADING_RE = re.compile(r"^###\s+([A-Za-z]+-\d+)\s*[·\-–—:]\s*(.+?)\s*$")
_BACKTICK_RE = re.compile(r"`([A-Za-z_][\w.]*)`")
_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_HUB_LABEL_RE = re.compile(r"\b(HUB\d+)\b")
_TEST_PATH_RE = re.compile(r"(^|/)(test_[^/]+\.py|[^/]+\.test\.[jt]sx?|tests?/)")
_CANDIDATE_DOC_GLOB = "Docs/*_CANDIDATES.md"
_CONFLICT_RE = re.compile(r"^CONFLICT \(", re.MULTILINE)


def _git(run_git, args, cwd):
    """(ok, stdout). run_git raises RuntimeError (or an OSError) on a failing command."""
    try:
        return True, run_git(args, cwd)
    except Exception as exc:  # noqa: BLE001 -- every check here is best-effort and must never break the list
        return False, str(exc)


def candidate_identifier(title):
    """The function name a candidate is about, from its heading title, or None when there is no reliable one.

    Preference: the first backticked identifier (`api_queue_state`); else the first camelCase or snake_case token
    (applyBrainDumpSort, renderHardwareTab) of length >= 6. Plain words never count, so a title with no code name
    yields None and is treated as 'new' rather than guessed at.
    """
    m = _BACKTICK_RE.search(title or "")
    if m:
        return m.group(1).split(".")[-1]
    for tok in _TOKEN_RE.findall(title or ""):
        if len(tok) >= 6 and ("_" in tok.strip("_") or (re.search(r"[a-z][A-Z]", tok) is not None)):
            return tok
    return None


def parse_candidate_headings(doc_text):
    """[{id, title, ident}] for every '### AC-N · title' heading in a candidates doc."""
    out = []
    for line in (doc_text or "").splitlines():
        m = _HEADING_RE.match(line)
        if m:
            out.append({"id": m.group(1), "title": m.group(2), "ident": candidate_identifier(m.group(2))})
    return out


def check_duplicate_candidates(run_git, repo_root, main_branch, branch):
    """(verdict, reasons) if the branch adds candidate headings to a Docs/*_CANDIDATES.md, else None.

    discard when every added candidate duplicates one already on master; needs-work when some do and some are new.
    """
    ok, names = _git(run_git, ["diff", "--name-only", f"origin/{main_branch}...origin/{branch}", "--", _CANDIDATE_DOC_GLOB], repo_root)
    docs = [n for n in names.splitlines() if n.strip()] if ok else []
    if not docs:
        return None
    added, existing = [], {}
    for doc in docs:
        ok, diff = _git(run_git, ["diff", "-U0", f"origin/{main_branch}...origin/{branch}", "--", doc], repo_root)
        if not ok:
            continue
        for line in diff.splitlines():
            if line.startswith("+###"):
                added.extend(parse_candidate_headings(line[1:]))
        ok, master_text = _git(run_git, ["show", f"origin/{main_branch}:{doc}"], repo_root)
        for c in parse_candidate_headings(master_text if ok else ""):
            if c["ident"]:
                existing.setdefault(c["ident"], c["id"])
    if not added:
        return None
    dups = [(c, existing[c["ident"]]) for c in added if c["ident"] and c["ident"] in existing]
    new = [c for c in added if not (c["ident"] and c["ident"] in existing)]
    dup_txt = "; ".join(f"{c['id']} {c['ident']} = {orig} already on {main_branch}" for c, orig in dups)
    if dups and not new:
        return ("discard", [f"recurring: all {len(dups)} candidate(s) this branch adds are duplicates of ones on {main_branch} ({dup_txt})"])
    if dups:
        new_txt = ", ".join(f"{c['id']}" + (f" ({c['ident']})" if c["ident"] else "") for c in new)
        return ("needs-work", [f"adds {len(new)} new candidate(s): {new_txt}", f"and {len(dups)} recurring duplicate(s) to drop: {dup_txt}"])
    return None


def hub_label(subject):
    m = _HUB_LABEL_RE.search(subject or "")
    return m.group(1) if m else None


def _changed_files(run_git, repo_root, main_branch, branch):
    ok, out = _git(run_git, ["diff", "--name-only", f"origin/{main_branch}...origin/{branch}"], repo_root)
    return [n for n in out.splitlines() if n.strip()] if ok else []


def rewires_code(run_git, repo_root, main_branch, branch):
    """True if the branch removes real code from a non-test file; False if it only adds; None if unknown.

    Removed comment lines, blank lines and module.exports / __all__ edits do not count: an add-only branch that
    just appends its new helper names to the export list is still add-only.
    """
    ok, diff = _git(run_git, ["diff", "-U0", f"origin/{main_branch}...origin/{branch}"], repo_root)
    if not ok:
        return None
    path = ""
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            path = line[6:]
            continue
        if not line.startswith("-") or line.startswith("---") or _TEST_PATH_RE.search(path):
            continue
        body = line[1:].strip()
        if not body or body.startswith(("//", "#", "*", "/*")):
            continue
        if re.match(r"(module\.exports\b|exports\.|__all__\b)", body):
            continue
        return True
    return False


def _conflicts(run_git, repo_root, a, b):
    """True only when git reports a real content CONFLICT between the two branch heads (never on a git failure)."""
    ok, out = _git(run_git, ["merge-tree", "--write-tree", "--name-only", f"origin/{a}", f"origin/{b}"], repo_root)
    return (not ok) and bool(_CONFLICT_RE.search(out))


def find_alternatives(branches, repo_root, main_branch, run_git):
    """{branch: (verdict, reasons)} for branches that have a rival from a different hub.

    `branches` are the tab's branch dicts (need 'branch' and 'subject'). See the module docstring for the rule.
    """
    info = {}
    for b in branches:
        label = hub_label(b.get("subject"))
        if label:
            info[b["branch"]] = {"label": label, "files": set(_changed_files(run_git, repo_root, main_branch, b["branch"])), "rewires": None}
    out = {}
    names = sorted(info)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            ia, ib = info[a], info[b]
            if ia["label"] == ib["label"] or not (ia["files"] & ib["files"]):
                continue
            if not _conflicts(run_git, repo_root, a, b):
                continue
            for name in (a, b):
                if info[name]["rewires"] is None:
                    info[name]["rewires"] = rewires_code(run_git, repo_root, main_branch, name)
            ra, rb = info[a]["rewires"], info[b]["rewires"]
            shared = ", ".join(sorted(ia["files"] & ib["files"]))
            for me, rival, mine, theirs in ((a, b, ra, rb), (b, a, rb, ra)):
                rl = info[rival]["label"]
                if mine is False and theirs is True:
                    res = ("discard", [f"superseded by {rival} ({rl}): the two cannot both merge (they conflict in {shared}), and {rival} rewires the code while this branch only adds unused helpers"])
                elif mine is not None and mine == theirs:
                    # Same class on both sides: which to keep is a human call. (A rewiring branch against an add-only rival
                    # is the winner and gets no flag at all.)
                    kind = "both only add helpers" if mine is False else "both rewire the same code"
                    res = ("needs-work", [f"alternative to {rival} ({rl}): the two cannot both merge (they conflict in {shared}) and {kind}; keep one, close the other"])
                else:
                    continue
                prev = out.get(me)
                if prev is None or (res[0] == "discard" and prev[0] != "discard"):
                    out[me] = res
                elif prev[0] == res[0]:
                    out[me] = (prev[0], prev[1] + res[1])
    return out


def merge_results(base, extra):
    """Combine two (verdict|None, reasons) results: discard beats needs-work beats nothing; reasons are concatenated."""
    if not extra:
        return base
    if not base or not base[0]:
        return extra
    rank = {"needs-work": 1, "discard": 2}
    verdict = base[0] if rank.get(base[0], 0) >= rank.get(extra[0], 0) else extra[0]
    reasons = list(base[1])
    reasons += [r for r in extra[1] if r not in reasons]
    return (verdict, reasons)
