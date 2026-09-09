"""Python-side wrapper for src/requeue-attribution.js's `classify` CLI -- lets the Flask
dashboard record a MANUAL requeue (api_task_requeue and friends) into
requeue-attribution.db.

Why this exists: Requeue Attribution (src/requeue-attribution.js) fires on every
PIPELINE-MECHANISM requeue -- blocked-drain, needs-clarification-triage, context-trim-
sweep, decompose-loop-autoroute -- but the one requeue that IS the "ghost in the machine"
(a human clicking Requeue) is pure Python and reached the classifier via nothing at all.
This wrapper closes that gap so the actor dimension ('operator-manual' vs
'pipeline-mechanism') is real, and the concept card can show a hand-fixes-vs-mechanism-
recoveries trend.

Deliberately shells out to the existing Node classifier rather than reimplementing the
Rollbar-style signature hash + burn-rate escalation in Python -- same reasoning as
grep_fetch_client.py / claude_client.py: one implementation, shared by the Node pipeline
and this Python caller.

Best-effort by contract: every failure mode (node missing, bad payload, timeout, non-JSON
stdout) is swallowed and returns None. A telemetry write must NEVER turn a working requeue
into a 500.
"""
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent.parent / "src"
REQUEUE_ATTRIBUTION_JS = SRC_DIR / "requeue-attribution.js"

# The classify path is deterministic-only (skipFallbackModel is forced on inside the CLI),
# so this should return in well under a second; the timeout is just a stall guard.
SUBPROCESS_TIMEOUT_S = 20


def classify_requeue(task: dict, *, reason_hint, requeue_writer, actor,
                     blocked_stage: str = None, pipeline_dir: str = None) -> dict | None:
    """Record one requeue's cause + actor. Returns the {"signature", "category"} dict on
    success, or None on any failure. `task` is the task record (its `id` is required for
    the write to land). `actor` is one of 'operator-manual' / 'agent-session' /
    'pipeline-mechanism'."""
    if not task or not task.get("id"):
        return None
    tmp_path = Path(tempfile.gettempdir()) / f"requeue-attribution-classify-{uuid.uuid4().hex}.json"
    env = dict(os.environ)
    if pipeline_dir:
        env["AGENT_MANAGER_PIPELINE_DIR"] = pipeline_dir
    payload = {
        "task": task,
        "reasonHint": reason_hint,
        "requeueWriter": requeue_writer,
        "actor": actor,
        "blockedStage": blocked_stage,
    }
    try:
        tmp_path.write_text(json.dumps(payload), encoding="utf-8")
        result = subprocess.run(
            ["node", str(REQUEUE_ATTRIBUTION_JS), "classify", str(tmp_path)],
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S, env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass

    if result.returncode != 0:
        return None
    try:
        parsed = json.loads(result.stdout or "{}")
        return parsed or None
    except json.JSONDecodeError:
        return None
