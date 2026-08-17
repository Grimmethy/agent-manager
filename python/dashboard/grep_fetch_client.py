"""Python-side wrapper for src/arch-import-fetch.js's CLI mode -- lets Ornith Discuss
sessions ground their replies in real files from the active project via HARNESS-mediated
retrieval (2026-08-17, following up on Brain Dump #48/#57's context-access work).

Ornith has no tool-calling path at all in this pipeline -- ollama_client.generate() is a
bare Ollama /api/generate completion call, nothing more (unlike the Claude provider,
which reaches for real files itself via claude-client.js's CLI --allowedTools). So giving
Ornith comparable grounding means the HARNESS runs the search on the model's behalf and
hands back real content, exactly the shape ornith-draft.js's own arch_import plan->
implement step already uses (propose search terms, harness greps, implement pass gets
real hits) -- see discuss_sessions.py's _ornith_harness_context for the Discuss-side
version of that same pattern.

Deliberately shells out to arch-import-fetch.js rather than reimplementing repo-grep in
Python -- same reasoning as claude_client.py's own header: one implementation of "grep
this repo for these queries, return capped real content" shared by both the Node
pipeline's own arch_import task source and this Python-side caller, not two copies of the
same MAX_CONTENT_CHARS budgeting logic drifting apart over time.
"""
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent.parent / "src"
ARCH_IMPORT_FETCH_JS = SRC_DIR / "arch-import-fetch.js"

# A local grep across a handful of directories -- generous for real work, but bounded so
# a broken/hanging repo (huge node_modules accidentally included in grepAllowedDirs, a
# network filesystem stall) can't stall a Discuss reply indefinitely the way an unbounded
# subprocess call would.
SUBPROCESS_TIMEOUT_S = 30


class GrepFetchError(RuntimeError):
    """Raised when arch-import-fetch.js itself fails (bad AGENT_MANAGER_REPO_ROOT, a
    node crash, non-JSON stdout). Callers in this codebase treat this as best-effort --
    see discuss_sessions.py's own try/except around fetch_for_queries -- a broken search
    should never break the actual conversation turn."""


def fetch_for_queries(queries: list, repo_root: str, grep_dirs: str = None) -> dict:
    """Returns {"hits": [...], "files": [{"path": str, "content": str}, ...]} -- the exact
    shape arch-import-fetch.js's own CLI prints (see that module's header). grep_dirs, if
    given, is the same comma-separated, repoRoot-relative format as the
    AGENT_MANAGER_GREP_DIRS env var itself; omitted, arch-import-fetch.js's own getConfig()
    call falls back to its usual 'frontend/src,backend/src' default.

    repo_root/grep_dirs are passed as env overrides on the CHILD process only (a copy of
    this process's own env, not a mutation of it) -- config.js's getConfig() reads them
    from process.env, and this is the one Python caller of that Node module operating on
    a project that isn't necessarily the pipeline's own currently-configured
    AGENT_MANAGER_REPO_ROOT (e.g. mid-session against whatever project was active when a
    Discuss session started)."""
    tmp_path = Path(tempfile.gettempdir()) / f"arch-import-fetch-req-{uuid.uuid4().hex}.json"
    env = dict(os.environ)
    env["AGENT_MANAGER_REPO_ROOT"] = repo_root
    if grep_dirs:
        env["AGENT_MANAGER_GREP_DIRS"] = grep_dirs
    try:
        tmp_path.write_text(json.dumps({"queries": queries}), encoding="utf-8")
        result = subprocess.run(
            ["node", str(ARCH_IMPORT_FETCH_JS), str(tmp_path)],
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S, env=env,
        )
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass

    if result.returncode != 0:
        raise GrepFetchError((result.stderr or "arch-import-fetch.js failed with no stderr output").strip())

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise GrepFetchError(f"arch-import-fetch.js returned non-JSON stdout: {result.stdout[:500]}") from e
