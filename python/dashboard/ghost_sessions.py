"""Ghost panel session logic -- Brain Dump #153 (Grimmethy): "a hideable panel on the
right side of the app for a conversational AI, very similar to the claude terminal I have
been using externally. It should be able to access the project files and make edits to
the system... the ghost in the machine."

Deliberately NOT built on discuss_sessions.py's shape despite some surface similarity:
Discuss is per-subject (a task/note/brain-dump entry), read-only, and rebuilds a fresh
prompt+transcript every turn because neither provider has real session continuity wired
in there. Ghost is global (one ongoing conversation per project, not tied to any subject),
has real Edit/Write/Bash access on both providers, and -- for Claude -- uses the CLI's own
`--resume` session continuity (see claude_client.py's own header) instead of replaying a
transcript. The local provider still has no native session-resume (Ollama's /api/generate
is stateless), so it keeps Discuss's proven transcript-replay approach -- but now through
local_tool_client.py's tool-calling loop (allow_write=True) instead of a bare completion,
since Ghost's local provider needs real Read/Grep/Glob/Edit/Write/Bash tool access, not
just text.

Git safety (edits landing on the LIVE working tree, not an isolated worktree) is handled
by the CALLER, not here -- app.py wraps each send_message() call in the exact same
_acquire_apply_lock()/_release_apply_lock() pair already used by the merge-branch
endpoint, so this module never needs its own git-mutex logic.
"""
import json
import time
import uuid
from pathlib import Path

import claude_client
import local_tool_client
import model_stats_client
import ollama_client

PROVIDER_LOCAL = "local"
PROVIDER_CLAUDE = "claude"

# Real Edit/Write/Bash, unlike Discuss's deliberately read-only CLAUDE_DISCUSS_ALLOWED_TOOLS
# -- this is the whole point of the Ghost panel (Brain Dump #153: "make edits to the
# system"). cwd is the live repoRoot, not an isolated worktree -- see this module's own
# header on the trust model this mirrors (this actual terminal session).
GHOST_CLAUDE_ALLOWED_TOOLS = "Read,Grep,Glob,Edit,Write,Bash"
GHOST_CLAUDE_MAX_TURNS = 30
# Tight cap for the local provider's own tool loop -- matches arch_discovery's existing
# ceiling (local-tool-client.js's runPlanWithTools default), deliberately not widened for
# Ghost; see local-tool-client.js's own WRITE_TOOLS header on why hard bounds stay hard.
GHOST_LOCAL_MAX_TURNS = 5


def ghost_sessions_path(storage_dir: Path) -> Path:
    return storage_dir / ".agent-manager-ghost-sessions.json"


def _read_sessions(storage_dir: Path) -> dict:
    p = ghost_sessions_path(storage_dir)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_sessions(storage_dir: Path, sessions: dict):
    ghost_sessions_path(storage_dir).write_text(json.dumps(sessions, indent=2), encoding="utf-8")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _new_session(repo_root: str, instances_dir, provider: str, model: str, effort: str) -> dict:
    session_id = f"ghost-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    return {
        "id": session_id,
        "provider": provider,
        "model": model,
        "effort": effort,
        "repoRoot": repo_root,
        "instancesDir": str(instances_dir) if instances_dir else None,
        # Only meaningful for the Claude provider (claude_client.generate()'s own
        # `resume` param) -- the CLI's real session id, captured from the first reply and
        # threaded into every call after. Local provider continuity comes from replaying
        # `transcript` instead (see this module's own header).
        "claudeSessionId": None,
        "transcript": [],
        "status": "active",
        "startedAt": _now_iso(),
        "endedAt": None,
        # "fully reserving the reasoning model" (Brain Dump #153) -- whether this
        # session currently holds .pipeline-single-flight.lock across turns, not just for
        # the span of one call. The actual held file handle lives in a process-local
        # registry (app.py), NOT here -- an open file object isn't JSON-serializable and
        # wouldn't survive a process restart meaningfully anyway.
        "reserved": False,
    }


def get_active_session(storage_dir: Path, repo_root: str, instances_dir=None,
                        provider: str = PROVIDER_LOCAL, model: str = None, effort: str = None) -> dict:
    """The single ongoing conversation for this project (Brain Dump #153: "hideable panel
    on the right side of the app" -- global, not per-subject like Discuss). Creates one if
    none is currently active. Does NOT re-resolve provider/model/effort for an existing
    active session -- same "fixed for the session's lifetime" reasoning discuss_sessions.py
    already documents (a mid-conversation provider switch would hand the new
    provider/model a transcript or --resume history it didn't generate)."""
    sessions = _read_sessions(storage_dir)
    active = [s for s in sessions.values() if s.get("status") == "active"]
    if active:
        active.sort(key=lambda s: s.get("startedAt") or "", reverse=True)
        return active[0]
    session = _new_session(repo_root, instances_dir, provider, model, effort)
    sessions[session["id"]] = session
    _write_sessions(storage_dir, sessions)
    return session


def start_new_conversation(storage_dir: Path, repo_root: str, instances_dir=None,
                            provider: str = PROVIDER_LOCAL, model: str = None, effort: str = None) -> dict:
    """Ends whatever's currently active (if anything -- same shape as Discuss's own
    end_session, but here there's no subject-owning caller to fold a summary back into,
    so this just closes it out) and starts a fresh one."""
    sessions = _read_sessions(storage_dir)
    now = _now_iso()
    for s in sessions.values():
        if s.get("status") == "active":
            s["status"] = "ended"
            s["endedAt"] = now
    session = _new_session(repo_root, instances_dir, provider, model, effort)
    sessions[session["id"]] = session
    _write_sessions(storage_dir, sessions)
    return session


def _send_claude(session: dict, message: str) -> str:
    started = time.time()
    result = claude_client.generate(
        message, model=session.get("model"), effort=session.get("effort"),
        cwd=session["repoRoot"], allowed_tools=GHOST_CLAUDE_ALLOWED_TOOLS,
        max_turns=GHOST_CLAUDE_MAX_TURNS, resume=session.get("claudeSessionId"),
    )
    if result.get("sessionId"):
        session["claudeSessionId"] = result["sessionId"]
    model_stats_client.record_call("ghost-session", result["model"], int((time.time() - started) * 1000),
                                    stage="ghost", result=result)
    return result["response"].strip()


def _build_local_prompt(transcript: list, message: str) -> str:
    lines = [
        "You are a coding assistant embedded in this project's own dashboard, with real "
        "Read/Grep/Glob/Edit/Write/Bash access to the live repository via your tools -- "
        "not a sandbox, not a draft that goes through review. A human is directly present "
        "and watching, the same way they would be pairing with you in a terminal. Make "
        "real changes when asked; explain what you did.",
        "",
    ]
    if transcript:
        lines.append("=== CONVERSATION SO FAR ===")
        for turn in transcript:
            role = "You" if turn["role"] == "assistant" else "User"
            lines.append(f"{role}: {turn['text']}")
        lines.append("")
    lines.append(f"User: {message}")
    return "\n".join(lines)


def _send_local(session: dict, message: str) -> str:
    started = time.time()
    prompt = _build_local_prompt(session["transcript"], message)
    result = local_tool_client.run_plan_with_tools(
        prompt, max_turns=GHOST_LOCAL_MAX_TURNS, source="ghost", allow_write=True,
    )
    model_stats_client.record_call("ghost-session", ollama_client.MODEL, int((time.time() - started) * 1000),
                                    stage="ghost", result=result)
    return (result.get("response") or "").strip()


def send_message(storage_dir: Path, session_id: str, message: str) -> dict:
    sessions = _read_sessions(storage_dir)
    session = sessions.get(session_id)
    if not session or session["status"] != "active":
        return session

    session["transcript"].append({"role": "user", "text": message})
    if session["provider"] == PROVIDER_CLAUDE:
        reply = _send_claude(session, message)
    else:
        reply = _send_local(session, message)
    session["transcript"].append({"role": "assistant", "text": reply})

    sessions[session_id] = session
    _write_sessions(storage_dir, sessions)
    return session


def get_session(storage_dir: Path, session_id: str):
    return _read_sessions(storage_dir).get(session_id)


def set_reserved(storage_dir: Path, session_id: str, reserved: bool):
    """Just the persisted flag -- app.py's reservation registry owns actually
    acquiring/releasing the lock and the idle-timeout watchdog; this only keeps the
    dashboard's own display of "is this session reserved" in sync with that."""
    sessions = _read_sessions(storage_dir)
    session = sessions.get(session_id)
    if not session:
        return None
    session["reserved"] = reserved
    sessions[session_id] = session
    _write_sessions(storage_dir, sessions)
    return session
