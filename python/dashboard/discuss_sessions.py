"""Discuss session logic -- an open-ended conversation with the local model to add
context to something before it's finalized, without going through Grill Me's more
structured flow. Two callers share this module: the Brain Dump tab's "Discuss" action (on
a captured entry, not yet sorted into the vault) and the Second Brain file viewer's
"Discuss" button (on an already-filed vault note, alongside Grill Me/Grill With Docs --
added 2026-08-16 once the Brain Dump version proved useful enough to want everywhere).
Deliberately NOT built on top of grill_sessions.py despite the similar shape: that flow is
Socratic-quiz-style with a model-decided completion point (see its own MAX_EXCHANGES
comment); this is free-form chat that ends only when the USER says so. Different enough
that sharing code would mean threading "except for the discuss kind" branches through
grill_sessions.py instead of two small, separately-readable modules.

Generic over WHAT is being discussed -- a subject_id (a brain-dump entry id or a vault
note's relative path) plus its current text is all this module needs; it never looks at
brain-dump.json or a note file itself, and never decides what "ending" does to the
original source. That decision (append to the entry's rawText vs. append a "## Discuss
session" section to the note file) lives entirely in app.py, which already owns both of
those data stores and their own edit/reset conventions -- duplicating that here would
just drift out of sync with it over time.

storage_dir is passed in by the caller rather than assumed: brain-dump sessions live
alongside brain-dump.json (the pipeline dir), note sessions live alongside the vault
(SECOND_BRAIN_DIR) -- same "session file next to the thing it's about" convention
grill_sessions.py already uses for its own storage.
"""
import json
import time
import uuid
from pathlib import Path

import ollama_client
import claude_client
import model_stats_client

# session["provider"] is one of these two -- "local" keeps the original Ollama-only
# behavior; "claude" routes through claude_client.py (Claude Code CLI under a
# subscription -- see that module's own header for the billing-safety reasoning).
# Chosen once at start_session() and held for the session's lifetime rather than
# re-selectable per turn: a mid-conversation provider switch would hand the new model
# a transcript it didn't generate half of, with no way to tell it that happened.
PROVIDER_LOCAL = "local"
PROVIDER_CLAUDE = "claude"

# Read-only real-file access for a claude-provider chat turn (2026-08-17, brain-dump
# entry: "Claude in the agent-manager has no access to or context about the system
# it's housed inside... essentially a naive dummy chat"). Read/Grep/Glob only -- no
# Edit/Write/Bash -- a Discuss session is meant to help someone think, not touch the
# codebase; Claude's own recommendation elsewhere for read-only tools before write
# access is proven applies just as much here. Multiple turns needed (not the module's
# usual single-shot) so a turn that reads a file still has a turn left to answer with
# what it found.
CLAUDE_DISCUSS_ALLOWED_TOOLS = "Read,Grep,Glob"
CLAUDE_DISCUSS_MAX_TURNS = 8


def _generate(provider: str, model: str, effort: str, prompt: str, temperature: float, num_predict: int,
               repo_root: str = None) -> dict:
    """Routes to the right backend and records the call to model-stats.db either way --
    see model_stats_client.py's own header for why interactive sessions weren't tracked
    at all before this, on any provider.

    repo_root, when set, is only meaningful for the claude provider: it's passed as the
    real working directory alongside CLAUDE_DISCUSS_ALLOWED_TOOLS, so Read/Grep/Glob
    resolve the actual active project instead of claude-client.js's isolated scratch
    dir. Unset (no active project, or provider is local) keeps the previous plain-text
    behavior -- Ornith has no tool-calling path through this module at all."""
    started = time.time()
    if provider == PROVIDER_CLAUDE:
        if repo_root:
            result = claude_client.generate(
                prompt, model=model, effort=effort,
                cwd=repo_root, allowed_tools=CLAUDE_DISCUSS_ALLOWED_TOOLS, max_turns=CLAUDE_DISCUSS_MAX_TURNS,
            )
        else:
            result = claude_client.generate(prompt, model=model, effort=effort)
        # claude_client.generate() already returns the "claude:"-prefixed label.
        stats_model = result["model"]
    else:
        result = ollama_client.generate(prompt, think=False, temperature=temperature, num_predict=num_predict)
        stats_model = ollama_client.MODEL
    latency_ms = int((time.time() - started) * 1000)
    model_stats_client.record_call("discuss-session", stats_model, latency_ms, stage="discuss", result=result)
    return result

# Same reasoning as grill_sessions.py's MAX_EXCHANGES, confirmed live there: a model
# that's good at asking follow-ups can keep a conversation going indefinitely without it
# ever degrading in quality. The difference here is this session type is DELIBERATELY
# open-ended and user-ended -- that's the entire point vs. Grill Me's structured cap --
# so this is not a normal stopping point, only a runaway-cost backstop set far above any
# real conversation length, for the pathological case alone.
MAX_TURNS = 40


def discuss_sessions_path(storage_dir: Path) -> Path:
    return storage_dir / ".agent-manager-discuss-sessions.json"


def _read_sessions(storage_dir: Path) -> dict:
    p = discuss_sessions_path(storage_dir)
    if not p.exists():
        return {}
    try:
        sessions = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    # One-time migration: sessions written before 2026-08-16 (brain-dump-only, this
    # module's original scope) used "entryId" -- renamed to the generic "subjectId" once
    # vault-note sessions needed the same field to mean "note path" instead. Read-time
    # only, not rewritten to disk here -- the next write (send_message/end_session) picks
    # up the new key naturally, no separate migration step needed.
    for session in sessions.values():
        if "subjectId" not in session and "entryId" in session:
            session["subjectId"] = session["entryId"]
    return sessions


def _write_sessions(storage_dir: Path, sessions: dict):
    discuss_sessions_path(storage_dir).write_text(json.dumps(sessions, indent=2), encoding="utf-8")


def _build_chat_prompt(subject_text: str, transcript: list, tools_available: bool = False) -> str:
    lines = [
        "You are a thoughtful assistant helping someone think out loud about a note, "
        "before it's finalized. Have a genuine, open-ended conversation -- ask "
        "clarifying questions, surface implications they may not have considered -- but "
        "don't lecture or quiz them, and don't ask more than one question at a time. "
        "Keep each reply to a few sentences.",
    ]
    if tools_available:
        lines.append(
            "You have real, read-only access to this project's own files via Read/Grep/"
            "Glob, rooted at the project actually being worked on right now -- use it "
            "when the note is about this system (agent-manager) itself, e.g. to check "
            "how something actually works before answering. README.md, CONTEXT.md, and "
            "AGENTS.md are good starting points for orienting yourself if you're unsure "
            "what you're looking at. Don't go investigate on your own initiative for a "
            "note that has nothing to do with this codebase."
        )
    lines += [
        "",
        "=== THE NOTE ===",
        subject_text,
        "",
    ]
    if transcript:
        lines.append("=== CONVERSATION SO FAR ===")
        for turn in transcript:
            role = "You" if turn["role"] == "assistant" else "User"
            lines.append(f"{role}: {turn['text']}")
        lines.append("")
    lines.append("Respond with your next conversational reply only -- no labels, no preamble.")
    return "\n".join(lines)


def _build_summary_prompt(subject_text: str, transcript: list) -> str:
    lines = [
        "The user just had the conversation below about the note quoted first, then chose "
        "to end it. Write a 2-4 sentence summary of the important context, decisions, or "
        "clarifications that came out of the discussion -- written as durable notes to "
        "append to the original note, not a transcript recap. If nothing substantive came "
        "up, say so plainly in one sentence rather than padding it out.",
        "",
        "=== ORIGINAL NOTE ===",
        subject_text,
        "",
        "=== CONVERSATION ===",
    ]
    for turn in transcript:
        role = "You" if turn["role"] == "assistant" else "User"
        lines.append(f"{role}: {turn['text']}")
    lines.append("")
    lines.append("Respond with ONLY the summary text, nothing else.")
    return "\n".join(lines)


def start_session(storage_dir: Path, subject_id: str, subject_text: str, kind: str = None,
                   provider: str = PROVIDER_LOCAL, model: str = None, effort: str = None,
                   repo_root: str = None) -> dict:
    result = _generate(provider, model, effort, _build_chat_prompt(subject_text, [], tools_available=bool(repo_root)),
                        0.6, 400, repo_root=repo_root)
    opener = result["response"].strip()

    session_id = f"discuss-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    session = {
        "id": session_id,
        "subjectId": subject_id,
        # Opaque to this module -- app.py's own routing hint for what "ending" should do
        # (append to a brain-dump entry vs. a vault note vs. re-open a held
        # queue/needs-clarification/ task for another resolution attempt). Needed because
        # two of the three kinds (brain-dump entries and held tasks) share the same
        # storage_dir (pipeline_dir) -- storage location alone can no longer tell them
        # apart the way it still can for a vault note (SECOND_BRAIN_DIR).
        "kind": kind,
        "rawText": subject_text,
        "status": "active",
        # Fixed for the session's lifetime -- see this module's own PROVIDER_* comment
        # for why this isn't re-selectable per turn. repoRoot rides along the same way
        # (whatever project was active when the session started, not re-resolved per
        # turn) so a mid-conversation project switch can't silently redirect an
        # in-progress session's tool access to a different codebase.
        "provider": provider,
        "model": model,
        "effort": effort,
        "repoRoot": repo_root,
        "transcript": [{"role": "assistant", "text": opener}],
        "startedAt": now,
        "endedAt": None,
        "summary": None,
    }
    sessions = _read_sessions(storage_dir)
    sessions[session_id] = session
    _write_sessions(storage_dir, sessions)
    return session


def send_message(storage_dir: Path, session_id: str, message: str):
    sessions = _read_sessions(storage_dir)
    session = sessions.get(session_id)
    if not session or session["status"] != "active":
        return session

    session["transcript"].append({"role": "user", "text": message})
    user_turns = sum(1 for t in session["transcript"] if t["role"] == "user")
    if user_turns >= MAX_TURNS:
        # Runaway-cost backstop only -- see MAX_TURNS's own comment above. Ends the
        # session here without a model reply to this last message; the summary call in
        # end_session() below still runs normally as a separate, one-shot request, so the
        # user's final message is still captured in what gets summarized.
        session["status"] = "ended"
        session["endedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        sessions[session_id] = session
        _write_sessions(storage_dir, sessions)
        return session

    repo_root = session.get("repoRoot")
    result = _generate(
        session.get("provider", PROVIDER_LOCAL), session.get("model"), session.get("effort"),
        _build_chat_prompt(session["rawText"], session["transcript"], tools_available=bool(repo_root)), 0.6, 400,
        repo_root=repo_root,
    )
    session["transcript"].append({"role": "assistant", "text": result["response"].strip()})
    sessions[session_id] = session
    _write_sessions(storage_dir, sessions)
    return session


def end_session(storage_dir: Path, session_id: str):
    """User-triggered end -- the entire reason this session type exists alongside Grill
    Me's model-decided completion. Generates one final summary call (skipped if the user
    ended before ever actually saying anything -- nothing to summarize) and marks the
    session ended. Deliberately does NOT touch the original brain-dump entry or note file
    -- see this module's own header for why that decision belongs to app.py."""
    sessions = _read_sessions(storage_dir)
    session = sessions.get(session_id)
    if not session:
        return None
    if session["status"] == "active":
        user_said_anything = any(t["role"] == "user" for t in session["transcript"])
        if user_said_anything:
            result = _generate(
                session.get("provider", PROVIDER_LOCAL), session.get("model"), session.get("effort"),
                _build_summary_prompt(session["rawText"], session["transcript"]), 0.3, 300,
            )
            session["summary"] = result["response"].strip()
        else:
            session["summary"] = ""
        session["status"] = "ended"
        session["endedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        sessions[session_id] = session
        _write_sessions(storage_dir, sessions)
    return session


def get_session(storage_dir: Path, session_id: str):
    return _read_sessions(storage_dir).get(session_id)


def latest_session_for_subject(storage_dir: Path, subject_id: str):
    """Most recently started session for this subject, or None. Same "don't silently
    start a duplicate session next to an existing one" reasoning as grill_sessions.py's
    own latest_session_for_note() -- see that function's comment for the incident this
    pattern already fixed once for Grill Me; applying it here from the start rather than
    waiting to hit the same bug independently."""
    sessions = _read_sessions(storage_dir)
    candidates = [s for s in sessions.values() if s.get("subjectId") == subject_id]
    if not candidates:
        return None
    candidates.sort(key=lambda s: s.get("startedAt") or "", reverse=True)
    return candidates[0]
