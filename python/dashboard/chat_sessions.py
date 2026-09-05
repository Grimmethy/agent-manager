"""Chat panel session logic -- Brain Dump #153 (Grimmethy): "a hideable panel on the
right side of the app for a conversational AI, very similar to the claude terminal I have
been using externally. It should be able to access the project files and make edits to
the system... the chat in the machine."

2026-08-31 (Grimmethy: "It should be rooted in agent manager always, and have access to
all active plugins"): the panel is no longer scoped to whichever project the pipeline is
pointed at. It is one global, system-wide conversation ROOTED at the agent-manager repo,
with real Read/Grep/Glob/Edit/Write/Bash access to agent-manager PLUS every registered
plugin (plugins.json) and project (projects.json). `session["roots"]` carries that list,
`roots[0]` (agent-manager) is the primary/`cwd`; app.py's `_chat_roots()` builds it and
the storage dir is fixed at the agent-manager repo root, not the active pipelineDir.

Deliberately NOT built on discuss_sessions.py's shape despite some surface similarity:
Discuss is per-subject (a task/note/brain-dump entry), read-only, and rebuilds a fresh
prompt+transcript every turn because neither provider has real session continuity wired
in there. Chat is global (one ongoing conversation per project, not tied to any subject),
has real Edit/Write/Bash access on both providers, and -- for Claude -- uses the CLI's own
`--resume` session continuity (see claude_client.py's own header) instead of replaying a
transcript. The local provider still has no native session-resume (Ollama's /api/generate
is stateless), so it keeps Discuss's proven transcript-replay approach -- but now through
local_tool_client.py's tool-calling loop (allow_write=True) instead of a bare completion,
since Chat's local provider needs real Read/Grep/Glob/Edit/Write/Bash tool access, not
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
# -- this is the whole point of the Chat panel (Brain Dump #153: "make edits to the
# system"). cwd is the live repoRoot, not an isolated worktree -- see this module's own
# header on the trust model this mirrors (this actual terminal session).
CHAT_CLAUDE_ALLOWED_TOOLS = "Read,Grep,Glob,Edit,Write,Bash"
CHAT_CLAUDE_MAX_TURNS = 30
# 2026-08-26, Grimmethy: "Seems like qwen got hung up" -- root-caused live, not actually
# hung: model-stats.db showed 4 real completed calls (65s/16s/75s/102s), zero errors, zero
# degenerate flags. It genuinely ran out of its 5-turn budget mid-investigation ("look at
# AC-3, what went wrong" needs locate-doc -> find-AC-3 -> check-git-log -> read-source,
# comfortably more than 5 read-only-plus-bash tool calls for a model this size) and
# returned whatever text happened to be attached to its LAST tool-calling turn -- "I'll
# check X next," not a real answer, since local-tool-client.js's own loop only returns a
# synthesized final response when a turn comes back with NO tool calls at all. Raised
# from 5 to 15 first, then to 100 the same night after a live AC-3 test still ran out of
# the 15-turn budget mid-investigation without reaching a conclusion (a multi-hop
# investigation -- locate doc, read doc, read referenced source, read a second file,
# check a third -- can legitimately need more than 15 read-only-plus-bash calls for a
# model this size). See local_tool_client.py's own SUBPROCESS_TIMEOUT_S comment for the
# matching wall-clock headroom this needed too -- that value MUST scale with this one.
CHAT_LOCAL_MAX_TURNS = 100


def chat_sessions_path(storage_dir: Path) -> Path:
    return storage_dir / ".agent-manager-chat-sessions.json"


def _read_sessions(storage_dir: Path) -> dict:
    p = chat_sessions_path(storage_dir)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_sessions(storage_dir: Path, sessions: dict):
    chat_sessions_path(storage_dir).write_text(json.dumps(sessions, indent=2), encoding="utf-8")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _new_session(roots: list, instances_dir, provider: str, model: str, effort: str) -> dict:
    session_id = f"chat-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    roots = [r for r in (roots or []) if r] or ["."]
    return {
        "id": session_id,
        "provider": provider,
        "model": model,
        "effort": effort,
        # roots[0] is the primary (agent-manager) repo -- Claude's cwd, and where a
        # relative path resolves for the local provider. roots[1:] are the additional
        # plugin/project repos, all read/write. See app.py:_chat_roots().
        "roots": roots,
        "repoRoot": roots[0],
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


def get_active_session(storage_dir: Path, roots: list, instances_dir=None,
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
    session = _new_session(roots, instances_dir, provider, model, effort)
    sessions[session["id"]] = session
    _write_sessions(storage_dir, sessions)
    return session


def start_new_conversation(storage_dir: Path, roots: list, instances_dir=None,
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
    session = _new_session(roots, instances_dir, provider, model, effort)
    sessions[session["id"]] = session
    _write_sessions(storage_dir, sessions)
    return session


def _roots_blurb(session: dict) -> str:
    roots = session.get("roots") or [session["repoRoot"]]
    lines = [f"- {roots[0]}  (agent-manager -- primary; relative paths resolve here)"]
    for r in roots[1:]:
        lines.append(f"- {r}")
    return "\n".join(lines)


# 2026-09-05, Grimmethy: "Have it read agents.md for sure. I'd like to set that up as the
# de facto starting point" -- confirmed live that neither provider ever read it before:
# the local system prompt only announced accessible repos, and the Claude provider's CLI
# auto-reads CLAUDE.md from cwd (a different file, a different convention) but never
# AGENTS.md. A generous cap, not a tight one -- the real file here is a few KB; this only
# guards against a pathological one blowing the prompt.
AGENTS_MD_MAX_CHARS = 20000


def _read_agents_md(session: dict) -> str:
    """The primary repo's (roots[0]) own AGENTS.md, best-effort -- a project without one
    just gets no section, never an error that would block a chat turn."""
    roots = session.get("roots") or [session["repoRoot"]]
    try:
        content = (Path(roots[0]) / "AGENTS.md").read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    if not content:
        return ""
    if len(content) > AGENTS_MD_MAX_CHARS:
        content = content[:AGENTS_MD_MAX_CHARS] + "\n...[truncated]"
    return content


def _agents_md_blurb(agents_md: str) -> str:
    return (
        "The primary repo's own AGENTS.md -- its de facto starting point. Read this "
        "before anything else: it documents repo-specific hazards and conventions "
        "(e.g. what's safe to hand-edit vs. what needs a real mechanism) that a generic "
        "coding assistant would not otherwise know.\n\n" + agents_md
    )


def _send_claude(session: dict, message: str) -> str:
    started = time.time()
    roots = session.get("roots") or [session["repoRoot"]]
    # First turn only: the CLI's --add-dir makes the extra repos reachable but doesn't
    # announce them, and nothing else primes Claude with this repo's own AGENTS.md (the
    # CLI's own auto-read only covers CLAUDE.md). Tell it both on turn one; --resume
    # carries all of this forward on every later turn, same as before.
    if not session.get("claudeSessionId"):
        preamble_parts = []
        if len(roots) > 1:
            preamble_parts.append(
                "You are rooted at the agent-manager repo and also have full read/write "
                "access to these additional repos:\n" + _roots_blurb(session)
            )
        agents_md = _read_agents_md(session)
        if agents_md:
            preamble_parts.append(_agents_md_blurb(agents_md))
        if preamble_parts:
            message = "\n\n---\n\n".join(preamble_parts) + "\n\n---\n\n" + message
    result = claude_client.generate(
        message, model=session.get("model"), effort=session.get("effort"),
        cwd=session["repoRoot"], allowed_tools=CHAT_CLAUDE_ALLOWED_TOOLS,
        max_turns=CHAT_CLAUDE_MAX_TURNS, resume=session.get("claudeSessionId"),
        add_dirs=roots[1:],
    )
    if result.get("sessionId"):
        session["claudeSessionId"] = result["sessionId"]
    model_stats_client.record_call("chat-session", result["model"], int((time.time() - started) * 1000),
                                    stage="chat", result=result, source="chat")
    return result["response"].strip()


_LOCAL_SYSTEM_PROMPT = (
    "You are a coding assistant embedded in the agent-manager system's own dashboard, "
    "with real Read/Grep/Glob/Edit/Write/Bash access to live repositories via your tools "
    "-- not a sandbox, not a draft that goes through review. A human is directly present "
    "and watching, the same way they would be pairing with you in a terminal. Make real "
    "changes when asked; explain what you did.\n\n"
    "You are ROOTED at the agent-manager repo (relative paths resolve there) and also have "
    "full read/write access to every registered plugin and project repo. Call list_roots "
    "to see them; use an absolute path (or grep_codebase's `root` argument) to reach a "
    "non-primary repo."
)


def _local_system_prompt(session: dict) -> str:
    prompt = _LOCAL_SYSTEM_PROMPT + "\n\nAccessible repos:\n" + _roots_blurb(session)
    agents_md = _read_agents_md(session)
    if agents_md:
        prompt += "\n\n---\n\n" + _agents_md_blurb(agents_md)
    return prompt


def _build_local_messages(session: dict, message: str) -> list:
    """2026-08-26 (Open WebUI investigation, Grimmethy): replaces the old approach of
    flattening the whole conversation into one giant string inside a single
    {role:'user'} message -- Ollama's /api/chat (like every real chat frontend, Open
    WebUI included) expects the actual conversation as a per-turn array of
    {role, content} objects, not narrated "You:"/"User:" text glued together. This also
    incidentally means only a session's very first-ever message is ever a length-1
    request now -- see local-tool-client.js's own comment on why that shape is the one
    that can hit TokenFold's flaky single-message cache path."""
    messages = [{"role": "system", "content": _local_system_prompt(session)}]
    for turn in session["transcript"]:
        role = "assistant" if turn["role"] == "assistant" else "user"
        messages.append({"role": role, "content": turn["text"]})
    messages.append({"role": "user", "content": message})
    return messages


def _stream_local(session: dict, message: str):
    """Yields plain text chunks as the local model generates them (Open WebUI-style live
    streaming, see this module's own recent header note) -- the caller accumulates them
    into the final transcript entry."""
    started = time.time()
    messages = _build_local_messages(session, message)
    roots = session.get("roots") or [session["repoRoot"]]
    result = None
    for event in local_tool_client.stream_plan_with_tools(
        messages=messages, max_turns=CHAT_LOCAL_MAX_TURNS, source="chat", allow_write=True,
        primary_root=roots[0], extra_roots=roots[1:], force_summary_on_cap=True,
    ):
        if event.get("type") == "chunk":
            yield event["text"]
        elif event.get("type") == "final":
            result = event
    model_stats_client.record_call("chat-session", ollama_client.MODEL, int((time.time() - started) * 1000),
                                    stage="chat", result=result or {}, source="chat")
    # 2026-09-05, Grimmethy: force_summary_on_cap=True is now passed above, so both a
    # turn-cap hit AND a context-budget hit (see local-tool-client.js's own
    # RESERVED_RESPONSE_TOKENS/estimateMessagesTokens check) now force one extra no-tools
    # turn that produces a real considered answer with a RESOLUTION: line, rather than
    # returning whatever rode along with the run's last tool call. `forcedSummary` /
    # `forcedSummaryReason` are the real signal for that now -- prefer them over the old
    # turnsUsed >= max_turns heuristic below (kept only as a fallback for the
    # exceedingly rare case where forcedSummary itself never got set, e.g. the tools-
    # disabled kill-switch path).
    if result and result.get("forcedSummary"):
        budget = "context room" if result.get("forcedSummaryReason") == "context" else f"its {CHAT_LOCAL_MAX_TURNS}-turn tool budget"
        yield f"\n\n*(Ran out of {budget} mid-investigation, so it gave its best final answer using what it had already learned.)*"
    elif result and result.get("turnsUsed") is not None and result["turnsUsed"] >= CHAT_LOCAL_MAX_TURNS:
        yield (
            f"\n\n*(Ran out of its {CHAT_LOCAL_MAX_TURNS}-turn tool budget mid-investigation -- "
            "the above may be a status update rather than a finished answer. Ask again, or "
            "narrow the question, to let it continue.)*"
        )


def stream_message(storage_dir: Path, session_id: str, message: str):
    """Generator sibling of the old send_message -- yields {"type": "chunk", "text"} as
    the reply generates, then exactly one {"type": "final", "session": {...}} carrying
    the same updated-session shape send_message() used to return in one shot, once the
    transcript is persisted. Claude sessions still resolve in a single blocking
    _send_claude() call (Claude-side token streaming isn't wired up here) but go through
    this same generator shape so app.py's SSE route doesn't need to special-case either
    provider."""
    sessions = _read_sessions(storage_dir)
    session = sessions.get(session_id)
    if not session or session["status"] != "active":
        yield {"type": "final", "session": session}
        return

    # 2026-09-01 (Grimmethy: "time stamps to the second programmed into each
    # thought segment"): capture the turn's wall-clock time so the transcript
    # render (grillRenderTranscript in index.html) can stamp each segment. Old
    # persisted entries simply lack the key -- the renderer falls back to no
    # stamp, so this is safe against existing sessions.
    session["transcript"].append({"role": "user", "text": message, "timestamp": _now_iso()})
    # In-progress placeholder, rewritten and PERSISTED after every chunk (not just once
    # at the end) -- 2026-08-26, Grimmethy: "It thought a lot and then the chat record
    # just disappeared." Root-caused live: a 30+-minute real investigation was killed
    # outright when the dashboard's own file-watcher reloader restarted this process
    # mid-stream (chat_sessions.py itself got edited while that turn was still running)
    # -- the old persist-once-at-the-end design meant the ENTIRE turn vanished, not just
    # whatever hadn't streamed yet. Any interruption now loses at most the last unwritten
    # chunk, regardless of cause (a reloader restart, a crash, a dropped connection) --
    # the whole point is not depending on reaching a specific line of code at the end.
    session["transcript"].append({"role": "assistant", "text": "", "timestamp": _now_iso()})
    sessions[session_id] = session
    _write_sessions(storage_dir, sessions)

    reply_parts = []
    if session["provider"] == PROVIDER_CLAUDE:
        reply = _send_claude(session, message)
        reply_parts.append(reply)
        session["transcript"][-1]["text"] = reply
        sessions[session_id] = session
        _write_sessions(storage_dir, sessions)
        yield {"type": "chunk", "text": reply}
    else:
        for chunk in _stream_local(session, message):
            reply_parts.append(chunk)
            session["transcript"][-1]["text"] = "".join(reply_parts)
            sessions[session_id] = session
            _write_sessions(storage_dir, sessions)
            yield {"type": "chunk", "text": chunk}

    session["transcript"][-1]["text"] = "".join(reply_parts).strip()
    sessions[session_id] = session
    _write_sessions(storage_dir, sessions)
    yield {"type": "final", "session": session}


def get_session(storage_dir: Path, session_id: str):
    return _read_sessions(storage_dir).get(session_id)


def inject_user_message(storage_dir: Path, session_id: str, text: str):
    """Appends `text` as a user turn to an existing active session and persists it --
    NO model call, NO assistant placeholder. Same {role, text} turn shape stream_message
    uses when it records the user side of a turn, so the session's transcript is
    indistinguishable from a normal chat that hasn't received its reply yet. Returns the
    updated session dict, or None if the session doesn't exist / isn't active. This is
    what app.py's POST /api/chat/inject endpoint calls so dashboard "Send to chat"
    buttons (task detail, Brain Dump) can push a task log / brain-dump dump into the
    conversation for follow-up without triggering a model turn."""
    sessions = _read_sessions(storage_dir)
    session = sessions.get(session_id)
    if not session or session.get("status") != "active":
        return None
    session["transcript"].append({"role": "user", "text": text, "timestamp": _now_iso()})
    sessions[session_id] = session
    _write_sessions(storage_dir, sessions)
    return session


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
