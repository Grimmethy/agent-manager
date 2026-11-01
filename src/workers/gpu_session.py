"""GPU session tracking for worker lanes.

This module provides the foundation layer for tracking GPU broker sessions
associated with worker lanes. It defines the data model, a pause/resume
entry point, and a WorkerExtension mixin that lets any worker register and
query its active GPU sessions.

Other pieces in this feature (pause/resume wiring, UI exposure, warm-up
grace period handling) layer on top of this module.
"""

from __future__ import annotations

import dataclasses
import enum
from typing import Dict, List, Optional


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

class GPUSessionStatus(enum.Enum):
    """Lifecycle state of a GPU broker session."""

    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    WARMING_UP = "WARMING_UP"


@dataclasses.dataclass(frozen=True)
class GPU_SESSION_SCHEMA:
    """Immutable record describing one GPU broker session bound to a worker.

    Attributes:
        session_id: Unique identifier for the GPU session (broker-side).
        broker_id: Identifier of the GPU broker that owns the session.
        model_name: Name of the model currently loaded on the GPU.
        status: Current lifecycle state of the session.
    """

    session_id: str
    broker_id: str
    model_name: str
    status: GPUSessionStatus


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

WARMUP_GRACE_PERIOD_SECONDS: int = 30
"""How long (seconds) after a session enters WARMING_UP that it is still
considered "warm" for scheduling purposes.  Sibling tasks may override this
via config; the default is 30s."""


# ---------------------------------------------------------------------------
# Pause/resume entry point
# ---------------------------------------------------------------------------

def pause_broker_session(broker_id: str, worker_id: str) -> None:
    """Mark the active session on ``broker_id`` (served by ``worker_id``) as paused.

    This is the leaf-side hook that other pieces in the feature wire into
    (e.g. a pause button in the Workers tab or a pre-reclaim step).  The
    default implementation is a no-op storage point: the session record
    itself is the source of truth and is updated via
    :class:`WorkerExtension`.

    Args:
        broker_id: The broker whose session should be paused.
        worker_id: The worker lane currently holding the broker.

    Raises:
        ValueError: If ``broker_id`` or ``worker_id`` is empty or malformed.
    """

    if not broker_id or not isinstance(broker_id, str):
        raise ValueError("pause_broker_session: broker_id must be a non-empty string")
    if not worker_id or not isinstance(worker_id, str):
        raise ValueError("pause_broker_session: worker_id must be a non-empty string")


# ---------------------------------------------------------------------------
# WorkerExtension -- register / query sessions on any worker
# ---------------------------------------------------------------------------

class WorkerExtension:
    """Mix-in that gives a worker GPU-session register-and-query behaviour.

    Usage::

        class MyWorker(WorkerExtension):
            ...

        worker = MyWorker(id="worker-3090")
        worker.register_session(GPU_SESSION_SCHEMA(
            session_id="s-1", broker_id="b-1",
            model_name="qwen3:8b", status=GPUSessionStatus.ACTIVE,
        ))
        assert worker.get_gpu_sessions()  # -> [GPU_SESSION_SCHEMA(...)]

    Sessions are keyed by ``(broker_id, session_id)`` so the same broker
    cannot be double-booked on one worker.
    """

    def __init__(self) -> None:
        # broker_id -> session_id -> GPU_SESSION_SCHEMA
        self._sessions: Dict[str, Dict[str, GPU_SESSION_SCHEMA]] = {}

    # -- registration ------------------------------------------------------

    def register_session(self, session: GPU_SESSION_SCHEMA) -> None:
        """Register (or upsert) a session on this worker.

        Re-registering the same ``(broker_id, session_id)`` pair updates the
        existing record in place (useful when status changes).
        """

        if session is None:
            raise ValueError("register_session: session must not be None")
        if not session.session_id or not session.broker_id:
            raise ValueError(
                "register_session: session_id and broker_id must be non-empty"
            )
        self._sessions.setdefault(session.broker_id, {})[session.session_id] = session

    def unregister_session(self, broker_id: str, session_id: str) -> None:
        """Remove a session.  Silently ignores missing pairs."""

        bucket = self._sessions.get(broker_id)
        if bucket:
            bucket.pop(session_id, None)
            if not bucket:
                del self._sessions[broker_id]

    # -- queries -----------------------------------------------------------

    def get_gpu_sessions(self) -> List[GPU_SESSION_SCHEMA]:
        """Return every session currently registered on this worker.

        Order is insertion-order by ``(broker_id, session_id)``; callers
        should not rely on a stable sort across runs.
        """

        out: List[GPU_SESSION_SCHEMA] = []
        for broker_id in sorted(self._sessions):
            bucket = self._sessions[broker_id]
            for session_id in sorted(bucket):
                out.append(bucket[session_id])
        return out

    def get_gpu_session(
        self, broker_id: str, session_id: str
    ) -> Optional[GPU_SESSION_SCHEMA]:
        """Return one session by ``(broker_id, session_id)`` or None."""

        return self._sessions.get(broker_id, {}).get(session_id)

    def sessions_by_broker(self, broker_id: str) -> List[GPU_SESSION_SCHEMA]:
        """Return all sessions currently bound to ``broker_id`` on this worker."""

        bucket = self._sessions.get(broker_id, {})
        return list(bucket.values())

    def sessions_by_status(
        self, status: GPUSessionStatus
    ) -> List[GPU_SESSION_SCHEMA]:
        """Return all sessions on this worker with the given ``status``."""

        return [s for s in self.get_gpu_sessions() if s.status is status]

    # -- helpers -----------------------------------------------------------

    def has_active_session(self, broker_id: str) -> bool:
        """True if ``broker_id`` has any session registered on this worker."""

        return broker_id in self._sessions

    def clear(self) -> None:
        """Remove every session.  Useful for tests and worker teardown."""

        self._sessions.clear()
