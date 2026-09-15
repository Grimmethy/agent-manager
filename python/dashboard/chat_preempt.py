"""Chat "make GPU space" preemption (brain dump #5), extracted from app.py (2026-09-15)
so it can be vendored into a standalone Chat plugin repo without dragging app.py's whole
Flask surface along. Verbatim port -- no behavior change -- of app.py's own preempt
functions; see git history for the pre-extraction version if a diff is ever needed.

The Chat panel is for live repo investigation and shares the one resident local model
with the pipeline's worker/reviewer lanes on the same single-flight lock. When they're
busy a chat turn can sit in `flock -w 600` for many minutes. Holding the lock (the
Reserve feature) doesn't interrupt an in-flight call -- only killing the in-flight
`local-draft.js` / `review-task.js` child frees the GPU now. On every local-provider
chat message we kill BOTH worker lanes' in-flight draft outright -- chat takes priority
over the pipeline, full stop (2026-09-02, Grimmethy: "Chat should preclude workers").
Only the `reviewer` stays age-gated (a review vote is short; and a chat turn that lands
just as a vote completes gains little by killing it). Set
AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING=true to go back to sparing a
worker-reasoning agentic draft older than AGENT_MANAGER_CHAT_PREEMPT_REASONING_MAX_AGE_S.
A killed worker task is `mv`'d drafting/ -> pending/ first so no retry budget is burnt;
the daemons treat the empty child result as a retryable failed call
(scripts/local-worker.sh:239-434) and recover on their own next tick.

app.py's own shared utilities (read_json_safe, parse_hb_timestamp, read_env_file,
instances_dir, queue_dir, PACKAGE_ROOT, ENV_FILE_PATH) are imported lazily inside each
function, not at module top-level -- app.py imports THIS module, so a top-level
`from app import ...` here would be a circular import that only fails when app.py is the
entrypoint (how the dashboard runs). Same pattern routes/chat.py's own header already
documents and uses.
"""

import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_PREEMPT_LANES_ALWAYS = ("worker-1", "worker-reasoning")
_PREEMPT_LANES_AGE_GATED = ("reviewer",)
# instances/<lane>.json currentPass values in which the heartbeat `pid` is the node
# child (local-draft.js / review-task.js), NOT the bash daemon -- safe to signal. The
# `int(hb["pid"]) != daemon_pid` guard below is the real safety net; this just filters out
# `idle`/`claim`/`starting`.
_PREEMPT_CHILD_PASSES = frozenset({
    "plan", "implement", "implement-retry", "critique", "revise",
    "harness-search", "local-agentic", "local-agentic-write", "vote", "review",
    # 2026-09-07, Grimmethy: "I was able to select the decompose task but it still
    # doesn't seem to set it as the queued task" -- this exact allowlist-goes-stale-
    # when-a-new-pass-is-added failure class the 2026-09-02 comment below already
    # names, recurring for a genuinely new (non-prefix-sharing) label instead of a
    # variant of an existing one: 'orient' (src/orient-pass.js's own maybeLocked
    # label, the pre-plan investigation pass) and 'decompose-check' (local-draft.js's
    # preliminary one-cheap-call decompose check, before any tier runs) were both
    # missing, so a task caught mid-orient/decompose-check could never actually be
    # preempted -- assign-task's own preempt step silently returned killed:false and
    # the operator's pin just sat there with nothing to reclaim it until whatever was
    # running happened to finish or fail on its own.
    "orient", "decompose-check",
})
# Prefixes for the adhoc agentic-draft family (local-draft.js's maybeLocked labels:
# local-agentic, local-agentic-write, local-agentic-test-*). Matched by prefix so a new
# tier label can't silently drop out of preemption again -- 2026-09-02, worker-reasoning
# held the GPU 12 min in `local-agentic-write` (missing from the set above) while a chat
# turn blocked, because the exact-match check skipped it entirely.
_PREEMPT_CHILD_PASS_PREFIXES = ("local-agentic", "harness-search")
_MODEL_INFLIGHT_STALE_S = 300  # mirrors src/model-inflight-lock.js STALE_MS


def _is_preemptable_child_pass(pass_name) -> bool:
    if not pass_name:
        return False
    return pass_name in _PREEMPT_CHILD_PASSES or pass_name.startswith(_PREEMPT_CHILD_PASS_PREFIXES)


def _chat_preempt_enabled() -> bool:
    from app import ENV_FILE_PATH, read_env_file
    v = (os.environ.get("AGENT_MANAGER_CHAT_PREEMPT")
         or read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_CHAT_PREEMPT") or "true")
    return str(v).strip().lower() not in ("0", "false", "no", "off")


def _chat_preempt_max_age_s() -> int:
    from app import ENV_FILE_PATH, read_env_file
    v = (os.environ.get("AGENT_MANAGER_CHAT_PREEMPT_REASONING_MAX_AGE_S")
         or read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_CHAT_PREEMPT_REASONING_MAX_AGE_S"))
    try:
        return max(0, int(str(v).strip()))
    except (TypeError, ValueError):
        return 180


def _preempt_spare_long_reasoning() -> bool:
    """Opt back in to the old behaviour: spare a worker-reasoning agentic draft that has
    been running longer than the max-age. Off by default -- chat precludes workers."""
    from app import ENV_FILE_PATH, read_env_file
    v = (os.environ.get("AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING")
         or read_env_file(ENV_FILE_PATH).get("AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING") or "false")
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _preempt_lane_sets():
    """(always_kill, age_gated) lane tuples for this chat turn. worker-reasoning is
    always-kill unless AGENT_MANAGER_CHAT_PREEMPT_SPARE_LONG_REASONING opts it back into
    age-gating."""
    if _preempt_spare_long_reasoning():
        return ("worker-1",), ("worker-reasoning", "reviewer")
    return _PREEMPT_LANES_ALWAYS, _PREEMPT_LANES_AGE_GATED


def _preempt_decision(lane, kill_pid, started_epoch, now, max_age_s, always=None):
    """Pure. -> (action, reason). action in {"kill", "spare", "skip"}.
    kill_pid: the resolved in-flight node child pid (or None). started_epoch: unix time
    the call/task started (or None = age unknown). `always`: whether this lane is
    unconditionally preempted -- defaults to membership in _PREEMPT_LANES_ALWAYS (the
    static default set) when not passed, so existing callers/tests keep working."""
    if always is None:
        always = lane in _PREEMPT_LANES_ALWAYS
    if not kill_pid:
        return ("skip", "no in-flight model call")
    if always:
        return ("kill", "always")
    if started_epoch is None:
        return ("spare", "age unknown")
    age = now - started_epoch
    if age < max_age_s:
        return ("kill", f"{int(age)}s old (< {max_age_s}s)")
    return ("spare", f"{int(age)}s old")


def _read_fresh_model_locks(inst_dir: Path) -> dict:
    """{instanceId: {pid, startedAt}} for every non-stale entry in instances/.model-locks/
    -- mirrors src/model-inflight-lock.js readActiveLocks()."""
    from app import read_json_safe
    out = {}
    d = inst_dir / ".model-locks"
    try:
        names = [f for f in os.listdir(d) if f.endswith(".json")]
    except OSError:
        return out
    now = time.time()
    for name in names:
        fp = d / name
        try:
            if now - fp.stat().st_mtime > _MODEL_INFLIGHT_STALE_S:
                continue
            data = read_json_safe(fp)
        except OSError:
            continue
        if data and data.get("instanceId") and data.get("pid"):
            out[data["instanceId"]] = data
    return out


def _kill_and_requeue_instance(instance_id: str, note: str) -> dict:
    """Kill whatever `instance_id` is doing right now and requeue its in-flight task
    (content untouched -- 'current state' is already continuously checkpointed by the
    Node persist hook, see task-history.js's setHistoryPersistHook) with a history event
    explaining why it stopped. Generalizes the reviewer-only legacy kill-and-requeue
    block below (inside _preempt_pipeline_for_chat) into something usable for ANY worker
    lane -- unconditionally (no age gate; an explicit operator action always kills),
    unlike that block's _preempt_decision age check, which is specific to chat-preempt
    and deliberately left untouched rather than risking a regression there (2026-09-06,
    for POST /api/instances/<id>/assign-task -- Grimmethy: "whatever is being worked on
    should save its current state to the task log and then cancel itself as soon as
    possible").

    Safe to call on a worker-1/worker-reasoning lane even though those normally go
    through the GPU arbiter for chat-preempt's class-based cancel-below: SIGKILLing the
    pid directly here, without going through the arbiter, is fine because
    gpu-arbiter.js's own liveTickets() already self-heals a ticket whose pid has died
    (`!pidAlive(t.pid)` -> unlink) the next time anything reads tickets -- no phantom
    "still holding" state is left behind.

    Returns {"killed": bool, "taskId": str|None}."""
    from app import instances_dir, queue_dir, read_json_safe
    inst_dir = instances_dir()
    qdir = queue_dir()
    if not inst_dir or not inst_dir.is_dir() or not qdir:
        return {"killed": False, "taskId": None}

    hb = read_json_safe(inst_dir / f"{instance_id}.json") or {}
    locks = _read_fresh_model_locks(inst_dir)
    lock = locks.get(instance_id)

    kill_pid = None
    if lock:
        try:
            kill_pid = int(lock.get("pid"))
        except (TypeError, ValueError):
            kill_pid = None
    if kill_pid is None and hb.get("status") in ("working", "queued") \
            and _is_preemptable_child_pass(hb.get("currentPass")) and hb.get("pid"):
        pids_dir = Path(os.environ.get("HOME") or "~").expanduser() / ".local/state/agent-manager/pids"
        daemon_pid = None
        try:
            daemon_pid = int((pids_dir / f"{instance_id}.pid").read_text().strip())
        except (OSError, ValueError):
            pass
        if daemon_pid is None or int(hb["pid"]) != daemon_pid:
            kill_pid = int(hb["pid"])

    task_id = hb.get("currentTaskId")
    if not kill_pid:
        return {"killed": False, "taskId": task_id}

    if task_id:
        src = qdir / "drafting" / instance_id / f"{task_id}.json"
        try:
            if src.is_file():
                import json
                data = json.loads(src.read_text(encoding="utf-8"))
                data.setdefault("history", []).append({
                    "stage": "operator-preempted", "at": datetime.now(timezone.utc).isoformat(),
                    "detail": note,
                })
                src.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except (OSError, ValueError):
            pass  # best-effort -- still proceed with the kill even if the history stamp failed
        dst = qdir / "pending" / f"{task_id}.json"
        try:
            if src.is_file() and not dst.exists():
                os.replace(src, dst)
        except OSError:
            pass

    try:
        os.kill(kill_pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    if lock:
        try:
            for name in os.listdir(inst_dir / ".model-locks"):
                lp = inst_dir / ".model-locks" / name
                d = read_json_safe(lp) or {}
                if d.get("pid") == kill_pid:
                    lp.unlink()
        except OSError:
            pass

    return {"killed": True, "taskId": task_id}


def _arbiter_cancel_below(cls: str = "interactive") -> list:
    """Ask the GPU arbiter (src/gpu-arbiter.js, via its CLI) to cancel every ticket below
    `cls` -- the worker draft lanes. The arbiter marks each cancelRequested and SIGKILLs
    any active holder; the worker daemon requeues its task. Replaces the old
    heartbeat/pidfile/mtime reconstruction for the worker lanes. Best-effort."""
    from app import ENV_FILE_PATH, PACKAGE_ROOT, read_env_file
    import json
    cli = PACKAGE_ROOT / "scripts" / "gpu-arbiter-cli.js"
    if not cli.is_file():
        return []
    try:
        cp = subprocess.run(
            ["node", str(cli), "cancel-below", "--cls", cls],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, **read_env_file(ENV_FILE_PATH)},
        )
        rows = json.loads((cp.stdout or "[]").strip() or "[]")
        return [{"lane": r.get("cls"), "action": r.get("action"),
                 "taskId": r.get("taskId"), "ageSeconds": None} for r in rows]
    except Exception as e:  # noqa: BLE001 -- best-effort, never block a chat turn
        print(f"[chat-preempt] arbiter cancel-below failed (non-fatal): {e}", file=sys.stderr, flush=True)
        return []


def _preempt_pipeline_for_chat() -> list:
    """Free the local model for a chat turn. Worker draft lanes go through the GPU arbiter
    now -- one cancel-below call. The reviewer is not on the arbiter yet, so it keeps the
    age-gated legacy kill below. Best-effort throughout. Returns [{lane, action, taskId,
    ageSeconds}]."""
    from app import instances_dir, parse_hb_timestamp, queue_dir, read_json_safe
    if os.name == "nt":
        return []
    inst_dir = instances_dir()
    qdir = queue_dir()
    if not inst_dir or not inst_dir.is_dir():
        return []

    summary = _arbiter_cancel_below("interactive")

    pids_dir = Path(os.environ.get("HOME") or "~").expanduser() / ".local/state/agent-manager/pids"
    locks = _read_fresh_model_locks(inst_dir)
    max_age = _chat_preempt_max_age_s()
    _, age_gated_lanes = _preempt_lane_sets()
    now = time.time()

    # Only the reviewer stays on this legacy heartbeat-based path -- the worker draft lanes
    # were handled by _arbiter_cancel_below above. (age_gated_lanes is ('reviewer',).)
    for lane in age_gated_lanes:
        try:
            hb = read_json_safe(inst_dir / f"{lane}.json") or {}
            lock = locks.get(lane)

            kill_pid = None
            started_epoch = None
            if lock:
                try:
                    kill_pid = int(lock.get("pid"))
                except (TypeError, ValueError):
                    kill_pid = None
                sdt = parse_hb_timestamp(lock.get("startedAt"))
                started_epoch = sdt.timestamp() if sdt else None
            if kill_pid is None and hb.get("status") in ("working", "queued") \
                    and _is_preemptable_child_pass(hb.get("currentPass")) and hb.get("pid"):
                daemon_pid = None
                try:
                    daemon_pid = int((pids_dir / f"{lane}.pid").read_text().strip())
                except (OSError, ValueError):
                    pass
                if daemon_pid is None or int(hb["pid"]) != daemon_pid:
                    kill_pid = int(hb["pid"])

            task_id = hb.get("currentTaskId")
            # For an age-gated lane with no fresh model-lock, fall back to the task JSON's
            # claimedAt, then its mtime (a conservative lower bound on task age).
            if started_epoch is None and lane in age_gated_lanes and task_id and qdir:
                tf = qdir / "drafting" / lane / f"{task_id}.json"
                try:
                    tdata = read_json_safe(tf) or {}
                    cdt = parse_hb_timestamp(tdata.get("claimedAt"))
                    started_epoch = cdt.timestamp() if cdt else tf.stat().st_mtime
                except OSError:
                    pass

            action, reason = _preempt_decision(lane, kill_pid, started_epoch, now, max_age,
                                               always=False)  # reviewer only -- always age-gated
            age_s = int(now - started_epoch) if started_epoch else None

            if action != "kill":
                if kill_pid:
                    summary.append({"lane": lane, "action": action, "taskId": task_id, "ageSeconds": age_s})
                print(f"[chat-preempt] {lane}: {action} ({reason})", file=sys.stderr, flush=True)
                continue

            # Requeue the worker task before signalling (zero retry-budget cost); the
            # reviewer keeps its task in queue/review/ and is re-reviewed next tick.
            if lane != "reviewer" and task_id and qdir:
                src = qdir / "drafting" / lane / f"{task_id}.json"
                dst = qdir / "pending" / f"{task_id}.json"
                try:
                    if src.is_file() and not dst.exists():
                        os.replace(src, dst)
                except OSError:
                    pass

            kill_denied = False
            try:
                os.kill(kill_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                kill_denied = True
                print(f"[chat-preempt] {lane}: WARNING os.kill({kill_pid}) denied – process still alive",
                      file=sys.stderr, flush=True)
            if lock:
                for name in os.listdir(inst_dir / ".model-locks"):
                    try:
                        lp = inst_dir / ".model-locks" / name
                        d = read_json_safe(lp) or {}
                        if d.get("pid") == kill_pid:
                            lp.unlink()
                    except OSError:
                        pass

            if kill_denied:
                summary.append({"lane": lane, "action": "kill_denied", "killed": False, "taskId": task_id, "ageSeconds": age_s})
            else:
                summary.append({"lane": lane, "action": "killed", "taskId": task_id, "ageSeconds": age_s})
                print(f"[chat-preempt] killed {lane} pid={kill_pid} task={task_id} ({reason}) -> requeued",
                      file=sys.stderr, flush=True)
        except Exception as e:  # noqa: BLE001 -- best-effort, never block the chat turn
            print(f"[chat-preempt] {lane}: skipped ({e})", file=sys.stderr, flush=True)
    return summary
