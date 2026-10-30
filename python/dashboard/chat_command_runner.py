"""The restricted host-side runner behind Chat's owner-approved write commands (owner decision A, 2026-10-25; design:
docs/write-command-allowlist-design.md in the agent-manager-chat-plugin repo).

Chat is read-only by design; a few operational commands (for example `python3 -m inventory sales email`, which ingests sales into a database) must run
for real after the owner has confirmed them in the chat pane. This module is the ONLY place that happens, and it is deliberately small:

- a plain function called once per request by routes/internal_chat.py -- no daemon, no state beyond one lock and an audit log;
- the argv must equal an entry of the allowlist file (decision B: one central file in the chat plugin's storage dir) for exactly that repo, byte for byte;
- no shell: the argv list goes straight to subprocess with shell=False, stdin closed, cwd = the repo's realpath;
- the environment is a minimal base plus ONLY the entry's `env`; the run is cut off after the entry's timeout (default 120 s, at most 900 s);
- stdout and stderr are each capped at 20000 characters; one command runs at a time; every attempt, accepted or refused, is one line in an append-only audit log;
- everything is refused while the queue/.chat-write-tools-disabled kill-switch file is present, and a proposalId can run at most once (replay refused).

The caller (the plugin) holds the persisted owner confirmation; this module re-checks what it can (a confirmedAt that is recent) and never trusts the allowlist or
the kill switch to anyone else.
"""
import json
import os
import signal
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_TIMEOUT_S = 120
MAX_TIMEOUT_S = 900
MAX_OUTPUT_CHARS = 20000
CONFIRM_MAX_AGE_S = 900  # a confirmation older than this is stale: the owner must confirm again
KILL_SWITCH_NAME = ".chat-write-tools-disabled"
BASE_ENV_KEYS = ("PATH", "HOME", "LANG")

_run_lock = threading.Lock()


def allowlist_path() -> Path:
    override = os.environ.get("AGENT_MANAGER_CHAT_COMMAND_ALLOWLIST_PATH")
    if override:
        return Path(override)
    return Path.home() / ".local" / "state" / "agent-manager-chat-plugin" / "command-allowlist.json"


def audit_log_path() -> Path:
    override = os.environ.get("AGENT_MANAGER_CHAT_COMMAND_AUDIT_PATH")
    if override:
        return Path(override)
    return Path.home() / ".local" / "state" / "agent-manager" / "chat-command-audit.jsonl"


def _real(path) -> str:
    try:
        return os.path.realpath(str(path))
    except OSError:
        return str(path)


def load_allowlist(path=None) -> list:
    """The valid entries of the allowlist file as [{repo (realpath), argv, env, timeoutSeconds}]. A missing, unreadable or malformed file is an empty
    allowlist; a malformed entry is skipped (never partly honoured)."""
    try:
        data = json.loads(Path(path or allowlist_path()).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    commands = data.get("commands") if isinstance(data, dict) else None
    if not isinstance(commands, list):
        return []
    out = []
    for entry in commands:
        if not isinstance(entry, dict):
            continue
        repo, argv, env, timeout = entry.get("repo"), entry.get("argv"), entry.get("env", {}), entry.get("timeoutSeconds", DEFAULT_TIMEOUT_S)
        if not isinstance(repo, str) or not os.path.isabs(repo):
            continue
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and a for a in argv):
            continue
        if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
            continue
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0:
            continue
        out.append({"repo": _real(repo), "argv": list(argv), "env": dict(env), "timeoutSeconds": min(timeout, MAX_TIMEOUT_S)})
    return out


def find_entry(entries: list, repo, argv):
    """The allowlist entry whose repo realpath equals `repo`'s and whose argv is exactly `argv`, else None. No prefix, glob or partial match."""
    if not isinstance(repo, str) or not repo or not isinstance(argv, list):
        return None
    real = _real(repo)
    for e in entries:
        if e["repo"] == real and e["argv"] == argv:
            return e
    return None


def kill_switch_present(pipeline_dir) -> bool:
    return bool(pipeline_dir) and (Path(pipeline_dir) / "queue" / KILL_SWITCH_NAME).exists()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(text):
    if not isinstance(text, str) or not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _audit(path: Path, record: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"at": _now().isoformat(), **record}, ensure_ascii=False) + "\n")
    except OSError:
        pass  # an audit write failure must not turn a refusal into a run, and never changes what ran


def _already_ran(path: Path, proposal_id: str) -> bool:
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("proposalId") == proposal_id and rec.get("outcome") == "ran":
                    return True
    except OSError:
        return False
    return False


def _cap(text) -> str:
    text = text or ""
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + f"\n...[truncated: output exceeded {MAX_OUTPUT_CHARS} characters]"


def run_approved(argv, repo, proposal_id, confirmed_at, session_id=None, *, allowlist=None, pipeline_dir=None, audit=None) -> dict:
    """Runs one owner-confirmed, allowlisted command. Returns { ok, exitCode, stdout, stderr, durationMs } for a command that ran (ok is exit code 0), or
    { ok: False, refused: '<reason>' } when it was not run. Never raises for an expected failure."""
    audit_file = Path(audit) if audit else audit_log_path()
    base = {"proposalId": proposal_id, "sessionId": session_id, "repo": repo, "argv": argv}

    def refuse(reason):
        _audit(audit_file, {**base, "outcome": f"refused: {reason}"})
        return {"ok": False, "refused": reason}

    if kill_switch_present(pipeline_dir):
        return refuse("the chat write kill switch (queue/.chat-write-tools-disabled) is present")
    if not isinstance(proposal_id, str) or not proposal_id.strip():
        return refuse("proposalId is required")
    confirmed = _parse_iso(confirmed_at)
    if confirmed is None:
        return refuse("confirmedAt is required (an ISO timestamp of the owner's persisted confirmation)")
    age = (_now() - confirmed).total_seconds()
    if age < -60 or age > CONFIRM_MAX_AGE_S:
        return refuse("the confirmation is stale or from the future; the owner must confirm again")
    entry = find_entry(load_allowlist(allowlist) if not isinstance(allowlist, list) else allowlist, repo, argv)
    if entry is None:
        return refuse("this exact command is not on the allowlist for that repo")
    if not os.path.isdir(entry["repo"]):
        return refuse("the repo directory does not exist")
    if _already_ran(audit_file, proposal_id):
        return refuse("this proposal has already been run; propose it again to run it again")
    if not _run_lock.acquire(blocking=False):
        return refuse("another chat command is running; try again when it has finished")
    try:
        env = {k: os.environ[k] for k in BASE_ENV_KEYS if k in os.environ}
        env.update(entry["env"])
        started = time.monotonic()
        try:
            # Its own process group, so a timeout can kill the command's children too, not just the direct child.
            proc = subprocess.Popen(
                entry["argv"], cwd=entry["repo"], env=env, shell=False, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace", start_new_session=True,
            )
        except OSError as exc:
            _audit(audit_file, {**base, "outcome": f"refused: could not start ({exc.__class__.__name__})"})
            return {"ok": False, "refused": f"the command could not be started: {exc}"}
        try:
            stdout, stderr = proc.communicate(timeout=entry["timeoutSeconds"])
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                proc.kill()
            stdout, stderr = proc.communicate()
            duration = int((time.monotonic() - started) * 1000)
            _audit(audit_file, {**base, "outcome": "ran", "exitCode": None, "timedOut": True, "durationMs": duration})
            return {"ok": False, "exitCode": None, "stdout": _cap(stdout), "stderr": _cap((stderr or "") + f"\ntimed out after {entry['timeoutSeconds']} seconds and was killed"), "durationMs": duration}
        duration = int((time.monotonic() - started) * 1000)
        _audit(audit_file, {**base, "outcome": "ran", "exitCode": proc.returncode, "durationMs": duration})
        return {"ok": proc.returncode == 0, "exitCode": proc.returncode, "stdout": _cap(stdout), "stderr": _cap(stderr), "durationMs": duration}
    finally:
        _run_lock.release()
