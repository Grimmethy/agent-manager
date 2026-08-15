"""Grill session logic for the Second Brain 'Grill Me' / 'Grill With Docs' skills --
Matt Pocock-style Socratic questioning that enriches a second-brain note through an
interactive Q&A loop. Session state persists to a JSON file alongside the vault (same
convention as .agent-manager-project-links.json in app.py) so it survives a dashboard
restart.
"""
import json
import time
import uuid
from pathlib import Path

from ollama_client import generate

# Hard cap on user answers per session -- confirmed live 2026-08-14: without an enforced
# limit, a real session (pci-ai-accelerators.md) ran to 73 turns and counting, still
# active, because the prompt's own "roughly 4-6 exchanges" instruction is a soft
# suggestion the model kept finding reasons not to follow -- each answer honestly did
# prompt a good, on-topic follow-up (the conversation never degraded in quality, it just
# never stopped). A soft prompt hint alone is not a real constraint against a model that
# is, if anything, TOO good at finding the next interesting question. This is enforced in
# code below, not left to the model's judgment.
MAX_EXCHANGES = 6


def grill_sessions_path(second_brain_dir: Path) -> Path:
    return second_brain_dir / ".agent-manager-grill-sessions.json"


def _read_sessions(second_brain_dir: Path) -> dict:
    p = grill_sessions_path(second_brain_dir)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_sessions(second_brain_dir: Path, sessions: dict):
    grill_sessions_path(second_brain_dir).write_text(json.dumps(sessions, indent=2), encoding="utf-8")


def _build_prompt(note_content: str, mode: str, source_url, transcript: list, force_complete: bool = False) -> str:
    lines = []
    if mode == "grill-with-docs" and source_url:
        lines.append(
            f"You are Matt Pocock, a Socratic TypeScript/software teacher. Quiz the user on the "
            f"documentation/source at {source_url}, using the note below as their current understanding."
        )
    else:
        lines.append(
            "You are Matt Pocock, a Socratic TypeScript/software teacher. Quiz the user on the "
            "note below to deepen and test their understanding."
        )
    lines.append("")
    lines.append("=== NOTE CONTENT ===")
    lines.append(note_content)
    lines.append("")
    if transcript:
        lines.append("=== CONVERSATION SO FAR ===")
        for turn in transcript:
            role = "You" if turn["role"] == "assistant" else "User"
            lines.append(f"{role}: {turn['text']}")
        lines.append("")
    if force_complete:
        # Backstop for the MAX_EXCHANGES cap in submit_answer -- that cap is enforced in
        # code regardless of what the model says, but a prompt that still asks for another
        # question here would just get its question thrown away, wasting the call. Ask for
        # the real thing directly instead.
        lines.append(
            "This is the FINAL exchange of this session -- do not ask another question, no "
            "matter how promising a follow-up seems. Respond with EXACTLY:\n"
            "STATUS: COMPLETE\n"
            "SUMMARY: <2-4 sentences on what the user now demonstrably understands, written as "
            "durable notes to append to their second brain>"
        )
    else:
        lines.append(
            "Ask ONE focused question at a time, Socratic style -- don't lecture. If the user's last "
            "answer was strong, briefly affirm why, then ask a deeper follow-up. If it was weak or "
            "missing, offer a gentle hint and re-ask. After a genuinely thorough back-and-forth (roughly "
            "4-6 solid exchanges), instead of another question, respond with:\n"
            "STATUS: COMPLETE\n"
            "SUMMARY: <2-4 sentences on what the user now demonstrably understands, written as durable "
            "notes to append to their second brain>\n"
            "Otherwise, always start your response with:\n"
            "STATUS: CONTINUE\n"
            "QUESTION: <your next question>"
        )
    return "\n".join(lines)


def _parse_response(text: str) -> dict:
    is_complete = "STATUS: COMPLETE" in text
    if is_complete:
        summary = text.split("SUMMARY:", 1)[1].strip() if "SUMMARY:" in text else text.strip()
        return {"complete": True, "text": summary}
    question = text.split("QUESTION:", 1)[1].strip() if "QUESTION:" in text else text.strip()
    return {"complete": False, "text": question}


def start_session(second_brain_dir: Path, note_path: str, mode: str, source_url=None) -> dict:
    note_file = second_brain_dir / note_path
    note_content = note_file.read_text(encoding="utf-8") if note_file.is_file() else ""

    result = generate(_build_prompt(note_content, mode, source_url, []), think=False, temperature=0.5, num_predict=500)
    parsed = _parse_response(result["response"])

    session_id = f"grill-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    session = {
        "id": session_id,
        "notePath": note_path,
        "mode": mode,
        "sourceUrl": source_url,
        "status": "complete" if parsed["complete"] else "active",
        "transcript": [{"role": "assistant", "text": parsed["text"]}],
        "startedAt": now,
        "completedAt": now if parsed["complete"] else None,
    }
    sessions = _read_sessions(second_brain_dir)
    sessions[session_id] = session
    _write_sessions(second_brain_dir, sessions)
    return session


def submit_answer(second_brain_dir: Path, session_id: str, answer: str):
    sessions = _read_sessions(second_brain_dir)
    session = sessions.get(session_id)
    if not session or session["status"] != "active":
        return session

    note_file = second_brain_dir / session["notePath"]
    note_content = note_file.read_text(encoding="utf-8") if note_file.is_file() else ""

    session["transcript"].append({"role": "user", "text": answer})
    user_turns = sum(1 for t in session["transcript"] if t["role"] == "user")
    force_complete = user_turns >= MAX_EXCHANGES
    result = generate(
        _build_prompt(note_content, session["mode"], session.get("sourceUrl"), session["transcript"], force_complete=force_complete),
        think=False, temperature=0.5, num_predict=500,
    )
    parsed = _parse_response(result["response"])
    # Hard enforcement: once the cap is reached, this session ends on this turn regardless
    # of what the model actually said -- the force_complete prompt above is a strong hint,
    # not a guarantee, and "a hint alone doesn't reliably stop it" is the exact failure
    # this cap exists to fix (see MAX_EXCHANGES's own comment).
    if force_complete:
        parsed["complete"] = True
    session["transcript"].append({"role": "assistant", "text": parsed["text"]})
    if parsed["complete"]:
        session["status"] = "complete"
        session["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    sessions[session_id] = session
    _write_sessions(second_brain_dir, sessions)
    return session


def get_session(second_brain_dir: Path, session_id: str):
    return _read_sessions(second_brain_dir).get(session_id)


def enrich_note(second_brain_dir: Path, session_id: str):
    sessions = _read_sessions(second_brain_dir)
    session = sessions.get(session_id)
    if not session or session["status"] != "complete":
        return None

    summary = session["transcript"][-1]["text"] if session["transcript"] else ""
    note_file = second_brain_dir / session["notePath"]
    stamp = time.strftime("%Y-%m-%d", time.gmtime())
    heading = "Grill Me" if session["mode"] == "grill-me" else "Grill With Docs"
    entry = f"\n\n## {heading} session -- {stamp}\n\n{summary}\n"
    if note_file.is_file():
        note_file.write_text(note_file.read_text(encoding="utf-8") + entry, encoding="utf-8")
    session["enrichedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    sessions[session_id] = session
    _write_sessions(second_brain_dir, sessions)
    return session