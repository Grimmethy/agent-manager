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
import re
import time
import uuid
from pathlib import Path

import ollama_client
import claude_client
import grep_fetch_client
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

# Harness-mediated retrieval for the local (Ornith) provider (2026-08-17, brain-dump
# #57 discussion: "does Ornith get the same project awareness [as Claude]? If not, how
# can we give it to it?"). Ornith has no tool-calling path through ollama_client.py at
# all -- generate() is a bare completion call -- so unlike Claude's Read/Grep/Glob above,
# giving it real grounding means the HARNESS decides what to search for (via a cheap,
# separate proposal call, see _ornith_harness_context below) and greps on the model's
# behalf, then hands back real content as part of the actual prompt. Same two-call shape
# ornith-draft.js's own arch_import plan->implement step already uses in production
# (propose search terms, harness runs grep-codebase-tool.js, implement pass gets real
# hits) -- this is that same pattern's Discuss-side twin, via grep_fetch_client.py.
QUERY_LINE_RE = re.compile(r'^QUERY:\s*(.+)$', re.MULTILINE)
MAX_HARNESS_QUERIES = 3
# grep-codebase-tool.js's own matching is a plain case-sensitive substring check, no
# fuzzy/regex matching (see that module's grepCodebase()) -- but Ornith's proposal call
# routinely answers in natural-language phrases ("worker heartbeat timeout") rather than
# a literal identifier, which then matches nothing even when the real thing (e.g.
# WORKER_ZOMBIE_THRESHOLD_SECONDS) is right there. Confirmed live 2026-08-17: tightening
# the proposal PROMPT to demand single-token output just made Ornith answer NONE more
# often instead of answering correctly formatted -- prompting alone couldn't close this
# gap reliably. So the HARNESS does the format normalization instead of trusting the
# model to: each raw phrase is expanded into its individual words (>=4 chars, skipping
# short/common connector words) in both cases, since a real identifier is usually built
# from exactly those words even when the model didn't spell it out that way.
MIN_EXPANDED_WORD_LEN = 4
MAX_HARNESS_GREP_TERMS = 15
# Well under arch-import-fetch.js's own 12000-char MAX_CONTENT_CHARS cap -- THIS budget
# shares ollama_client.py's fixed num_ctx=8192 window with the note text, the whole
# conversation so far, and this turn's own reply, none of which arch_import's dedicated
# implement pass has to compete with.
MAX_HARNESS_CONTEXT_CHARS = 3000


def _build_search_proposal_prompt(subject_text: str, transcript: list) -> str:
    lines = [
        "Below is a note and an ongoing conversation about it. Decide whether answering "
        "well requires looking at REAL files in this codebase (agent-manager) -- e.g. the "
        "note references a specific file, function, or existing mechanism you would "
        "otherwise have to guess about.",
        "",
        "If yes: reply with up to 3 lines, one per search term, each starting exactly with "
        "'QUERY: ' followed by a short keyword or identifier likely to appear in the "
        "relevant file(s) -- not a full sentence.",
        "If no -- the note doesn't need real file context to discuss well -- reply with "
        "exactly: NONE",
        "Reply with nothing else, no explanation either way.",
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
    return "\n".join(lines)


def _expand_grep_terms(raw_queries: list) -> list:
    """Turns each model-proposed query into extra grep-friendly variants -- see this
    module's own MIN_EXPANDED_WORD_LEN comment for why. The raw phrase is tried first
    (a lucky exact match costs nothing extra), then each long-enough word from it, both
    upper- and lower-cased, covering the two case conventions this codebase's own
    identifiers actually use (UPPER_SNAKE constants, camelCase/lowercase everything
    else) without needing full case-insensitive matching support in grep-codebase-tool.js
    itself."""
    terms = []
    seen = set()

    def add(t):
        if t and t not in seen and len(terms) < MAX_HARNESS_GREP_TERMS:
            seen.add(t)
            terms.append(t)

    for raw in raw_queries:
        raw = raw.strip()
        add(raw)
        for word in re.findall(r'[A-Za-z0-9]+', raw):
            if len(word) >= MIN_EXPANDED_WORD_LEN:
                add(word.upper())
                add(word.lower())
    return terms


def _ornith_harness_context(subject_text: str, transcript: list, repo_root: str, grep_dirs: str = None) -> str | None:
    """Returns a block of real file content to inject into this turn's prompt, or None
    (Ornith decided it didn't need one, the search came back empty, or the search itself
    failed). Two calls: a short/cheap/low-temperature proposal call decides WHETHER and
    WHAT to search for, then (only if it asked for something) a real grep via
    grep_fetch_client.py -- mirrors _generate()'s own two-provider split by keeping the
    "harness does the legwork" call entirely separate from the actual conversational
    reply that follows it.

    Recorded to model-stats.db as its own row (stage="discuss-harness-search") rather
    than folded into the reply call that follows -- it's a real Ollama call with its own
    latency, and model_stats_client.py's whole reason for existing (see its own header)
    was to stop interactive-session calls from being invisible to the Models tab; adding
    a second real call here that skips that recording would quietly reopen the same gap."""
    started = time.time()
    proposal = ollama_client.generate(
        _build_search_proposal_prompt(subject_text, transcript), think=False, temperature=0.2, num_predict=120,
    )
    model_stats_client.record_call("discuss-session", ollama_client.MODEL, int((time.time() - started) * 1000),
                                    stage="discuss-harness-search", result=proposal)
    queries = QUERY_LINE_RE.findall(proposal["response"])[:MAX_HARNESS_QUERIES]
    if not queries:
        return None

    try:
        fetched = grep_fetch_client.fetch_for_queries(_expand_grep_terms(queries), repo_root, grep_dirs)
    except grep_fetch_client.GrepFetchError:
        # Best-effort -- a broken search must never break the actual conversation turn,
        # same "non-fatal, fall through" treatment ornith-draft.js's own harness-search
        # branches give a failed archImportFetch() call.
        return None

    files = fetched.get("files") or []
    if not files:
        return None

    blocks = []
    budget = 0
    for f in files:
        if budget >= MAX_HARNESS_CONTEXT_CHARS:
            break
        content = f["content"]
        if budget + len(content) > MAX_HARNESS_CONTEXT_CHARS:
            content = content[:MAX_HARNESS_CONTEXT_CHARS - budget]
        blocks.append(f"--- {f['path']} ---\n{content}")
        budget += len(content)
    return f"Searched this codebase for: {', '.join(queries)}\n\n" + "\n\n".join(blocks)


def _chat_prompt_for_turn(provider: str, subject_text: str, transcript: list, repo_root: str, grep_dirs: str = None) -> str:
    """Builds the prompt for one Discuss turn, branching on how each provider gets project
    awareness: Claude reaches for real files itself (tools_available, above), Ornith has
    none, so the harness greps on its behalf first (_ornith_harness_context) when a
    project is active."""
    if provider == PROVIDER_CLAUDE:
        return _build_chat_prompt(subject_text, transcript, tools_available=bool(repo_root))
    harness_context = _ornith_harness_context(subject_text, transcript, repo_root, grep_dirs) if repo_root else None
    return _build_chat_prompt(subject_text, transcript, harness_context=harness_context)


def _generate(provider: str, model: str, effort: str, prompt: str, temperature: float, num_predict: int,
               repo_root: str = None) -> dict:
    """Routes to the right backend and records the call to model-stats.db either way --
    see model_stats_client.py's own header for why interactive sessions weren't tracked
    at all before this, on any provider.

    repo_root, when set and provider is claude, is passed as the real working directory
    alongside CLAUDE_DISCUSS_ALLOWED_TOOLS, so Read/Grep/Glob resolve the actual active
    project instead of claude-client.js's isolated scratch dir. For the local provider,
    repo_root plays no role here at all -- Ornith's own project awareness (if any) is
    already baked into `prompt` by the caller via _chat_prompt_for_turn before this
    function ever runs, since Ornith has no tool-calling path of its own to hand a
    working directory to."""
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


def _build_chat_prompt(subject_text: str, transcript: list, tools_available: bool = False, harness_context: str = None) -> str:
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
    elif harness_context:
        # Ornith has no tool-calling path of its own (see this module's own
        # _ornith_harness_context) -- this IS its real-file access, already fetched by
        # the harness based on a search Ornith itself asked for one call ago. Framed as a
        # fait accompli ("here's what was found"), not an offer to search again, since
        # there's no mechanism for it to actually trigger a second search mid-reply.
        lines.append(
            "Real content from this project's own files, fetched for you based on a "
            "search you asked for a moment ago (you have no direct file access of your "
            "own -- this is the result of that search):"
        )
        lines += ["", "=== CODEBASE SEARCH RESULTS ===", harness_context, "=== END SEARCH RESULTS ==="]
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
                   repo_root: str = None, grep_dirs: str = None) -> dict:
    prompt = _chat_prompt_for_turn(provider, subject_text, [], repo_root, grep_dirs)
    result = _generate(provider, model, effort, prompt, 0.6, 400, repo_root=repo_root)
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
        # for why this isn't re-selectable per turn. repoRoot/grepDirs ride along the
        # same way (whatever project was active when the session started, not
        # re-resolved per turn) so a mid-conversation project switch can't silently
        # redirect an in-progress session's tool access (or Ornith's harness-search
        # scope) to a different codebase.
        "provider": provider,
        "model": model,
        "effort": effort,
        "repoRoot": repo_root,
        "grepDirs": grep_dirs,
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
    provider = session.get("provider", PROVIDER_LOCAL)
    prompt = _chat_prompt_for_turn(provider, session["rawText"], session["transcript"], repo_root, session.get("grepDirs"))
    result = _generate(
        provider, session.get("model"), session.get("effort"),
        prompt, 0.6, 400,
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
