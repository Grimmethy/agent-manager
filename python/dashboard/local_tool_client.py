"""Python-side wrapper for src/local-tool-client.js's CLI mode -- the local model's
multi-turn tool-calling loop (grep_codebase/read_file/list_directory, plus Chat's own
opt-in write_file/edit_file/run_bash), needed by the dashboard's Chat panel the same way
claude_client.py already wraps claude-client.js for the Claude provider.

Deliberately shells out to the Node module rather than reimplementing the /api/chat
tool-loop logic in Python -- same "one implementation of the real thing, called from two
languages" reasoning as claude_client.py's own header.
"""
import json
import subprocess
import tempfile
import uuid
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent.parent / "src"
LOCAL_TOOL_CLIENT_JS = SRC_DIR / "local-tool-client.js"

# local-tool-client.js's own REQUEST_TIMEOUT_MS default is 240s per TURN, not per call --
# this was originally sized as "one slow turn plus headroom for Node startup," which was
# fine back when every caller passed a small max_turns. 2026-08-26, Grimmethy: raised
# Chat's own CHAT_LOCAL_MAX_TURNS well past that assumption (see chat_sessions.py's own
# comment for the incident) -- a real multi-turn investigative call can legitimately need
# several turns at ~15-20s each (confirmed live via model-stats.db: 65s/16s/75s/102s for
# 5-turn runs, ~15-20s/turn average), so the ceiling now needs real headroom for the
# WHOLE loop, not one turn. 900s comfortably covers 15 turns at 3x the observed average
# pace before this becomes a real bound rather than a rubber stamp.
SUBPROCESS_TIMEOUT_S = 900


class LocalToolClientError(RuntimeError):
    """Raised when local-tool-client.js itself fails (non-zero exit, non-JSON stdout) --
    the message is that module's own stderr text."""


def run_plan_with_tools(prompt: str, max_turns: int = 5, source: str = None,
                         allow_write: bool = False) -> dict:
    """Returns local-tool-client.js's own result shape:
    {response, toolCallLog, turnsUsed, toolsDisabled}.

    allow_write=True (Chat panel only) opts into write_file/edit_file/run_bash on top
    of the always-available read-only tools -- see local-tool-client.js's own WRITE_TOOLS
    header for why this is a deliberate, separate opt-in, not a default."""
    request = {"prompt": prompt, "maxTurns": max_turns}
    if source:
        request["source"] = source
    if allow_write:
        request["allowWrite"] = True

    tmp_path = Path(tempfile.gettempdir()) / f"local-tool-client-req-{uuid.uuid4().hex}.json"
    try:
        tmp_path.write_text(json.dumps(request), encoding="utf-8")
        try:
            result = subprocess.run(
                ["node", str(LOCAL_TOOL_CLIENT_JS), str(tmp_path)],
                capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as e:
            # 2026-08-24 -- caught live: subprocess.TimeoutExpired does NOT inherit from
            # TimeoutError, so a hang past SUBPROCESS_TIMEOUT_S (here, most often the
            # local-tool-client.js call queued a long time behind a stuck/misbehaving
            # worker-lane task via the GPU lock added earlier tonight) fell straight
            # through every layer of error handling as a raw, unhandled 500. Same fix as
            # claude_client.py's identical gap -- normalize into this module's own
            # exception type, the one thing every caller already knows to catch.
            raise LocalToolClientError(f"local-tool-client.js did not respond within {SUBPROCESS_TIMEOUT_S}s -- it may be queued behind a slow or stuck worker-lane task") from e
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass

    if result.returncode != 0:
        raise LocalToolClientError((result.stderr or "local-tool-client.js failed with no stderr output").strip())

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise LocalToolClientError(f"local-tool-client.js returned non-JSON stdout: {result.stdout[:500]}") from e
