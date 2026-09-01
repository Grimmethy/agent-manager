"""Python-side wrapper for src/model-stats-db.js's record-call/record-outcome CLI --
the Python equivalent of src/model-stats-client.js, so the dashboard's interactive
sessions (Discuss, Grill Me/Grill With Docs) show up in the same model-stats.db the
Models tab already reads, on both providers. Before this, only the Node pipeline's
implement-pass calls were ever recorded -- every interactive dashboard session (Ollama
or, now, Claude) was invisible to the Models tab regardless of provider.

Same "never let stats recording break the real feature" contract as the JS version:
every function here swallows its own errors.
"""
import json
import logging
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent.parent / "src"
MODEL_STATS_DB_JS = SRC_DIR / "model-stats-db.js"

logger = logging.getLogger(__name__)


def _run_event(event: str, payload: dict):
    tmp_path = Path(tempfile.gettempdir()) / f"model-stats-{event}-{uuid.uuid4().hex}.json"
    try:
        tmp_path.write_text(json.dumps(payload), encoding="utf-8")
        subprocess.run(["node", str(MODEL_STATS_DB_JS), event, str(tmp_path)],
                        capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        pass
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass


def record_call(task_id: str, model: str, latency_ms: int, stage: str = "discuss",
                 result: dict = None, started_at: str = None, source: str = None) -> str:
    """Call once per interactive-session model call. Returns a callId for a later
    record_outcome() (there usually isn't one for free-form chat -- discuss/grill
    sessions have no approve/reject verdict -- so most callers just keep the callId
    unused; it's still useful as a stable row identifier if a caller wants it).

    turnsUsed/source (2026-08-26, Grimmethy: "add turnsUsed recording... a data point we
    track for each job type in the Job List itself (min/max/average)"): chat_sessions.py's
    own local_tool_client.stream_plan_with_tools() result always carries a real turnsUsed
    count -- it just never reached this far before. result.get("turnsUsed") is None for
    every shape that isn't a runPlanWithTools()-backed result (e.g. a bare Claude Code
    reply), matching this file's own existing degenerate-field convention."""
    call_id = str(uuid.uuid4())
    result = result or {}
    _run_event("record-call", {
        "callId": call_id,
        "taskId": task_id,
        "stage": stage,
        "model": model,
        "startedAt": started_at or datetime.now(timezone.utc).isoformat(),
        "latencyMs": latency_ms,
        "evalDurationNs": None,
        "promptEvalCount": None,
        "evalCount": None,
        "attempts": None,
        "degenerate": result.get("degenerate"),
        "turnsUsed": result.get("turnsUsed"),
        "source": source,
    })
    return call_id


def get_turns_summary() -> dict | None:
    """Per-source MIN/MAX/AVG(turns_used) (2026-08-26, see record_call's own turnsUsed
    comment) -- for the Job List tab. Same best-effort-returns-None shape as the JS
    wrapper's getTurnsSummary(), captures real stdout instead of the fire-and-forget
    _run_event() pattern above since this actually needs the result."""
    try:
        proc = subprocess.run(
            ["node", "--no-warnings", str(MODEL_STATS_DB_JS), "turns-summary"],
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode != 0:
            return None
        return json.loads(proc.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        logger.warning("model-stats client failed: %s", exc, exc_info=True)
        return None


def record_outcome(call_id: str, outcome: str, outcome_stage: str = "discuss", outcome_reason: str = None):
    if not call_id:
        return
    _run_event("record-outcome", {
        "callId": call_id,
        "outcome": outcome,
        "outcomeStage": outcome_stage,
        "outcomeReason": outcome_reason,
    })
