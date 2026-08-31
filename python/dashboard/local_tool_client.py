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
# WHOLE loop, not one turn. This MUST scale with CHAT_LOCAL_MAX_TURNS -- it was 900s for
# a 15-turn budget (15 * ~20s/turn * 3x margin); CHAT_LOCAL_MAX_TURNS is now 100, so this
# is scaled proportionally to 6000s (100 minutes) to keep the same 3x margin. A message
# that genuinely uses the whole budget can now legitimately take up to that long before
# this fires -- that's the deliberate tradeoff of a 100-turn budget, not a bug.
SUBPROCESS_TIMEOUT_S = 6000


class LocalToolClientError(RuntimeError):
    """Raised when local-tool-client.js itself fails (non-zero exit, non-JSON stdout) --
    the message is that module's own stderr text."""


def run_plan_with_tools(prompt: str, max_turns: int = 5, source: str = None,
                         allow_write: bool = False, primary_root: str = None,
                         extra_roots: list = None) -> dict:
    """Returns local-tool-client.js's own result shape:
    {response, toolCallLog, turnsUsed, toolsDisabled}.

    allow_write=True (Chat panel only) opts into write_file/edit_file/run_bash on top
    of the always-available read-only tools -- see local-tool-client.js's own WRITE_TOOLS
    header for why this is a deliberate, separate opt-in, not a default.

    primary_root / extra_roots (2026-08-31, system-wide Chat panel): the repo the
    assistant is rooted at, plus additional accessible repo roots. Passed via the request
    JSON, NOT the child env -- AGENT_MANAGER_PIPELINE_DIR stays inherited so the node
    child's GPU single-flight lock keeps coordinating with the running workers. Omitting
    both keeps local-tool-client.js on the single configured repoRoot exactly as before."""
    request = {"prompt": prompt, "maxTurns": max_turns}
    if source:
        request["source"] = source
    if allow_write:
        request["allowWrite"] = True
    if primary_root:
        request["primaryRoot"] = primary_root
    if extra_roots:
        request["extraRoots"] = list(extra_roots)

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


def stream_plan_with_tools(messages: list = None, prompt: str = None, max_turns: int = 5,
                            source: str = None, allow_write: bool = False,
                            primary_root: str = None, extra_roots: list = None):
    """Generator sibling of run_plan_with_tools for the Chat panel's live-streamed replies
    (2026-08-26, Grimmethy: "vastly improve the chat system... Open WebUI" investigation --
    Open WebUI streams tokens over Socket.IO/SSE as they generate instead of blocking for
    the whole reply). Mirrors local-tool-client.js's own CLI `stream: true` mode: yields
    {"type": "chunk", "text": ...} as each piece arrives, then exactly one
    {"type": "final", response, toolCallLog, turnsUsed, toolsDisabled} -- the same result
    shape run_plan_with_tools returns in one shot, just delivered incrementally.

    Uses Popen instead of run_plan_with_tools' subprocess.run: the whole point is reading
    stdout line-by-line AS the child writes it, not waiting for it to exit first."""
    request = {"maxTurns": max_turns, "stream": True}
    if messages is not None:
        request["messages"] = messages
    else:
        request["prompt"] = prompt
    if source:
        request["source"] = source
    if allow_write:
        request["allowWrite"] = True
    if primary_root:
        request["primaryRoot"] = primary_root
    if extra_roots:
        request["extraRoots"] = list(extra_roots)

    tmp_path = Path(tempfile.gettempdir()) / f"local-tool-client-req-{uuid.uuid4().hex}.json"
    tmp_path.write_text(json.dumps(request), encoding="utf-8")
    proc = subprocess.Popen(
        ["node", str(LOCAL_TOOL_CLIENT_JS), str(tmp_path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        final = None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "final":
                final = obj
            else:
                yield obj
        try:
            returncode = proc.wait(timeout=SUBPROCESS_TIMEOUT_S)
        except subprocess.TimeoutExpired as e:
            proc.kill()
            raise LocalToolClientError(f"local-tool-client.js did not respond within {SUBPROCESS_TIMEOUT_S}s -- it may be queued behind a slow or stuck worker-lane task") from e
        if returncode != 0:
            stderr = proc.stderr.read()
            raise LocalToolClientError((stderr or "local-tool-client.js failed with no stderr output").strip())
        if final is None:
            raise LocalToolClientError("local-tool-client.js streaming mode ended without a final result")
        yield final
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        if proc.poll() is None:
            proc.kill()
