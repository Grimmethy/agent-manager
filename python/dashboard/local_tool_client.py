"""Python-side wrapper for src/local-tool-client.js's CLI mode -- the local model's
multi-turn tool-calling loop (grep_codebase/read_file/list_directory, plus Ghost's own
opt-in write_file/edit_file/run_bash), needed by the dashboard's Ghost panel the same way
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

# local-tool-client.js's own REQUEST_TIMEOUT_MS default is 240s; headroom for Node
# startup itself, matching claude_client.py's identical SUBPROCESS_TIMEOUT_S convention.
SUBPROCESS_TIMEOUT_S = 270


class LocalToolClientError(RuntimeError):
    """Raised when local-tool-client.js itself fails (non-zero exit, non-JSON stdout) --
    the message is that module's own stderr text."""


def run_plan_with_tools(prompt: str, max_turns: int = 5, source: str = None,
                         allow_write: bool = False) -> dict:
    """Returns local-tool-client.js's own result shape:
    {response, toolCallLog, turnsUsed, toolsDisabled}.

    allow_write=True (Ghost panel only) opts into write_file/edit_file/run_bash on top
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
        result = subprocess.run(
            ["node", str(LOCAL_TOOL_CLIENT_JS), str(tmp_path)],
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S,
        )
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
