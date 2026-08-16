"""Discuss session logic for the Brain Dump tab's "Discuss" action -- an open-ended
conversation with the local model to add context to a captured brain-dump entry, without
going through Grill Me's more structured flow. Deliberately NOT built on top of
grill_sessions.py despite the similar shape: that flow is Socratic-quiz-style, has a
model-decided completion point (with a hard MAX_EXCHANGES backstop -- see its own
comment), and operates on an already-filed second-brain note file. This is free-form
chat, ends only when the USER says so, and operates on a brain-dump entry that hasn't
been sorted into the vault yet -- different enough in every dimension that sharing code
would mean threading a bunch of "except when it's the brain-dump kind" branches through
grill_sessions.py instead of just having two small, separately-readable modules.

Session state persists to a JSON file in the pipeline dir (mirrors grill_sessions.py's
own convention of a JSON file alongside the vault) so it survives a dashboard restart.
"""
import json
import time
import uuid
from pathlib import Path

from ollama_client import generate

# Same reasoning as grill_sessions.py's MAX_EXCHANGES, confirmed live there: a model
# that's good at asking follow-ups can keep a conversation going indefinitely without it
# ever degrading in quality. The difference here is this session type is DELIBERATELY
# open-ended and user-ended -- that's the entire point vs. Grill Me's structured cap --
# so this is not a normal stopping point, only a runaway-cost backstop set far above any
# real conversation length, for the pathological case alone.
MAX_TURNS = 40


def discuss_sessions_path(pipeline_dir: Path) -> Path:
    return pipeline_dir / ".agent-manager-discuss-sessions.json"


def _read_sessions(pipeline_dir: Path) -> dict:
    p = discuss_sessions_path(pipeline_dir)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_sessions(pipeline_dir: Path, sessions: dict):
    discuss_sessions_path(pipeline_dir).write_text(json.dumps(sessions, indent=2), encoding="utf-8")


def _build_chat_prompt(raw_text: str, transcript: list) -> str:
    lines = [
        "You are a thoughtful assistant helping someone think out loud about a note they "
        "just jotted down, before it gets filed into their personal knowledge base. Have a "
        "genuine, open-ended conversation -- ask clarifying questions, surface implications "
        "they may not have considered -- but don't lecture or quiz them, and don't ask more "
        "than one question at a time. Keep each reply to a few sentences.",
        "",
        "=== THE NOTE THEY JOTTED DOWN ===",
        raw_text,
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


def _build_summary_prompt(raw_text: str, transcript: list) -> str:
    lines = [
        "The user just had the conversation below about the note quoted first, then chose "
        "to end it. Write a 2-4 sentence summary of the important context, decisions, or "
        "clarifications that came out of the discussion -- written as durable notes to "
        "append to the original entry, not a transcript recap. If nothing substantive came "
        "up, say so plainly in one sentence rather than padding it out.",
        "",
        "=== ORIGINAL NOTE ===",
        raw_text,
        "",
        "=== CONVERSATION ===",
    ]
    for turn in transcript:
        role = "You" if turn["role"] == "assistant" else "User"
        lines.append(f"{role}: {turn['text']}")
    lines.append("")
    lines.append("Respond with ONLY the summary text, nothing else.")
    return "\n".join(lines)


def start_session(pipeline_dir: Path, entry_id: str, raw_text: str) -> dict:
    result = generate(_build_chat_prompt(raw_text, []), think=False, temperature=0.6, num_predict=400)
    opener = result["response"].strip()

    session_id = f"discuss-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    session = {
        "id": session_id,
        "entryId": entry_id,
        "rawText": raw_text,
        "status": "active",
        "transcript": [{"role": "assistant", "text": opener}],
        "startedAt": now,
        "endedAt": None,
        "summary": None,
    }
    sessions = _read_sessions(pipeline_dir)
    sessions[session_id] = session
    _write_sessions(pipeline_dir, sessions)
    return session


def send_message(pipeline_dir: Path, session_id: str, message: str):
    sessions = _read_sessions(pipeline_dir)
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
        _write_sessions(pipeline_dir, sessions)
        return session

    result = generate(
        _build_chat_prompt(session["rawText"], session["transcript"]),
        think=False, temperature=0.6, num_predict=400,
    )
    session["transcript"].append({"role": "assistant", "text": result["response"].strip()})
    sessions[session_id] = session
    _write_sessions(pipeline_dir, sessions)
    return session


def end_session(pipeline_dir: Path, session_id: str):
    """User-triggered end -- the entire reason this session type exists alongside Grill
    Me's model-decided completion. Generates one final summary call (skipped if the user
    ended before ever actually saying anything -- nothing to summarize) and marks the
    session ended. Deliberately does NOT touch brain-dump.json itself: app.py already
    owns read_brain_dump_entries()/write_brain_dump_entries() and the sorted->captured
    reset logic PUT /api/brain-dump/<id> uses for exactly this kind of text change --
    duplicating that here would just drift out of sync with it over time."""
    sessions = _read_sessions(pipeline_dir)
    session = sessions.get(session_id)
    if not session:
        return None
    if session["status"] == "active":
        user_said_anything = any(t["role"] == "user" for t in session["transcript"])
        if user_said_anything:
            result = generate(
                _build_summary_prompt(session["rawText"], session["transcript"]),
                think=False, temperature=0.3, num_predict=300,
            )
            session["summary"] = result["response"].strip()
        else:
            session["summary"] = ""
        session["status"] = "ended"
        session["endedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        sessions[session_id] = session
        _write_sessions(pipeline_dir, sessions)
    return session


def get_session(pipeline_dir: Path, session_id: str):
    return _read_sessions(pipeline_dir).get(session_id)


def latest_session_for_entry(pipeline_dir: Path, entry_id: str):
    """Most recently started session for this entry, or None. Same "don't silently start
    a duplicate session next to an existing one" reasoning as grill_sessions.py's own
    latest_session_for_note() -- see that function's comment for the incident this
    pattern already fixed once for Grill Me; applying it here from the start rather than
    waiting to hit the same bug independently."""
    sessions = _read_sessions(pipeline_dir)
    candidates = [s for s in sessions.values() if s.get("entryId") == entry_id]
    if not candidates:
        return None
    candidates.sort(key=lambda s: s.get("startedAt") or "", reverse=True)
    return candidates[0]
