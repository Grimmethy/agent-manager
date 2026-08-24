"""Python-side wrapper for src/claude-client.js's CLI mode -- lets the dashboard's
interactive sessions (Discuss, Grill Me/Grill With Docs) use Claude Code under a
subscription as an alternative to the local Ollama model, alongside ollama_client.py.

Deliberately shells out to the Node module (`node claude-client.js <request.json>`)
rather than reimplementing the subprocess-invocation logic in Python: the auth-safety
guarantees there (refuse to run without CLAUDE_CODE_OAUTH_TOKEN, strip
ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN from the child env so a stray key can never
silently switch billing to the metered API) are the entire point of that module, and a
second, separately-maintained copy of that logic in Python is exactly how the two
would drift apart over time on the one part that actually matters. One implementation
of the dangerous part, called from two languages.
"""
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent.parent / "src"
CLAUDE_CLIENT_JS = SRC_DIR / "claude-client.js"

# Mirrors claude-client.js's own REQUEST_TIMEOUT_MS default (300s) plus headroom for
# Node startup itself -- the JS side already enforces its own timeout on the `claude`
# subprocess; this is the outer bound on the `node` process wrapping it.
SUBPROCESS_TIMEOUT_S = 330


class ClaudeClientError(RuntimeError):
    """Raised when claude-client.js itself fails or refuses to run (e.g. missing
    CLAUDE_CODE_OAUTH_TOKEN) -- the message is that module's own error text, already
    written to be actionable on its own."""


def generate(prompt: str, model: str = None, effort: str = None, think: bool = False,
             temperature: float = None, num_predict: int = None,
             cwd: str = None, allowed_tools: str = None, max_turns: int = None,
             resume: str = None) -> dict:
    """Same return shape as ollama_client.generate(): {"response": str, "thinking": str}.
    `think`/`temperature`/`num_predict` are accepted but ignored -- they're Ollama sampling
    knobs with no Claude Code CLI equivalent; kept in the signature only so callers built
    against ollama_client.generate()'s interface don't need a separate call shape per
    provider. `model`/`effort` map to claude-client.js's own model/effort selection
    (falling back to its CLAUDE_MODEL/CLAUDE_EFFORT env defaults when omitted).

    `cwd`/`allowed_tools`/`max_turns` are the real-file-access knobs (2026-08-17, brain-
    dump entry: "Claude in the agent-manager has no access to... the system it's housed
    inside") -- pass all three together to let this call actually Read/Grep/Glob a real
    project directory instead of claude-client.js's isolated scratch dir. Omitting them
    keeps the existing plain-text-completion behavior (no tools, no real cwd).

    `resume` (2026-08-24, Chat panel -- Brain Dump #153) is a prior call's own
    `sessionId` (returned below), threaded through to claude-client.js's `--resume` flag
    so the CLI's own session storage carries real conversation state forward -- the
    caller doesn't need to rebuild a transcript from scratch each turn the way
    Discuss/Grill already do for lack of this."""
    request = {"prompt": prompt}
    if model:
        request["model"] = model
    if effort:
        request["effort"] = effort
    if cwd:
        request["cwd"] = cwd
    if allowed_tools:
        request["allowedTools"] = allowed_tools
    if max_turns:
        request["maxTurns"] = max_turns
    if resume:
        request["resume"] = resume

    tmp_path = Path(tempfile.gettempdir()) / f"claude-client-req-{uuid.uuid4().hex}.json"
    try:
        tmp_path.write_text(json.dumps(request), encoding="utf-8")
        try:
            result = subprocess.run(
                ["node", str(CLAUDE_CLIENT_JS), str(tmp_path)],
                capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as e:
            # 2026-08-24 -- caught live via the Chat panel's sibling module
            # (local_tool_client.py had the identical gap): subprocess.TimeoutExpired
            # does NOT inherit from TimeoutError, so it was never caught by any of this
            # module's own error handling OR by app.py's _call_discuss/_call_chat
            # (which only know to catch ClaudeClientError/LocalToolClientError plus the
            # builtin TimeoutError/ConnectionError/OSError trio) -- it fell all the way
            # through as a raw, unhandled 500 with no indication of what happened. Every
            # OTHER failure mode of this subprocess call already gets normalized into
            # ClaudeClientError below; a hang past SUBPROCESS_TIMEOUT_S is just as much
            # this module's own failure mode as a non-zero exit or bad JSON, and belongs
            # in the same one exception type callers already know to catch.
            raise ClaudeClientError(f"claude -p (via claude-client.js) did not respond within {SUBPROCESS_TIMEOUT_S}s") from e
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass

    if result.returncode != 0:
        # claude-client.js's CLI mode writes its error message to stderr on failure
        # (auth guard, CLI exit failure, non-JSON output) -- already actionable text,
        # not a generic subprocess-failed message.
        raise ClaudeClientError((result.stderr or "claude-client.js failed with no stderr output").strip())

    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise ClaudeClientError(f"claude-client.js returned non-JSON stdout: {result.stdout[:500]}") from e

    # Prefixed to match model-provider.js's labelFor() convention on the JS pipeline
    # side -- without this, Claude-sourced stats rows are indistinguishable from a
    # hypothetical local Ollama model literally named "sonnet" in model-stats.db.
    resolved_model = model or os.environ.get("CLAUDE_MODEL", "sonnet")
    return {
        "response": parsed.get("response", ""),
        "thinking": parsed.get("thinking", ""),
        "degenerate": parsed.get("degenerate"),
        "model": f"claude:{resolved_model}",
        # 2026-08-24 (Chat panel) -- the CLI's own session id, for a caller that wants
        # real multi-turn continuity to pass back in as `resume` on its next call.
        "sessionId": parsed.get("sessionId"),
    }
