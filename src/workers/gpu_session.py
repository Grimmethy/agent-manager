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
import threading
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
# Worker registry
# ---------------------------------------------------------------------------

_worker_registry: Dict[str, WorkerExtension] = {}
_registry_lock = threading.Lock()


def register_worker(worker_id: str, extension: WorkerExtension) -> None:
    """Register a worker extension so pause/resume can find it by id.

    Args:
        worker_id: The worker lane identifier.
        extension: The WorkerExtension instance to register.

    Raises:
        ValueError: If ``worker_id`` is empty or ``extension`` is None.
    """

    if not worker_id or not isinstance(worker_id, str):
        raise ValueError("register_worker: worker_id must be a non-empty string")
    if extension is None:
        raise ValueError("register_worker: extension must not be None")
    with _registry_lock:
        _worker_registry[worker_id] = extension


def _lookup_worker(worker_id: str) -> WorkerExtension:
    """Return the registered WorkerExtension for ``worker_id`` or None."""

    with _registry_lock:
        return _worker_registry.get(worker_id)


def _clear_registry() -> None:
    """Remove every registered worker.  Useful for tests."""

    with _registry_lock:
        _worker_registry.clear()


# ---------------------------------------------------------------------------
# Pause/resume entry point
# ---------------------------------------------------------------------------

def pause_broker_session(broker_id: str, worker_id: str) -> None:
    """Mark the active session on ``broker_id`` (served by ``worker_id``) as paused.

    This is the leaf-side hook that other pieces in the feature wire into
    (e.g. a pause button in the Workers tab or a pre-reclaim step).  It
    looks up the registered :class:`WorkerExtension` for ``worker_id`` and
    calls :meth:`WorkerExtension.pause_session` to perform the state
    transition.

    Args:
        broker_id: The broker whose session should be paused.
        worker_id: The worker lane currently holding the broker.

    Raises:
        ValueError: If ``broker_id`` or ``worker_id`` is empty or malformed.
        KeyError: If no worker is registered for ``worker_id``.
    """

    if not broker_id or not isinstance(broker_id, str):
        raise ValueError("pause_broker_session: broker_id must be a non-empty string")
    if not worker_id or not isinstance(worker_id, str):
        raise ValueError("pause_broker_session: worker_id must be a non-empty string")

    extension = _lookup_worker(worker_id)
    if extension is None:
        raise KeyError(
            f"pause_broker_session: no worker registered for worker_id={worker_id!r}"
        )
    session = extension.pause_session(broker_id)
    if session is None:
        raise ValueError(
            f"pause_broker_session: no session found for broker_id={broker_id!r} "
            f"on worker {worker_id!r}"
        )


def resume_broker_session(broker_id: str, worker_id: str) -> None:
    """Resume (un-pause) the active session on ``broker_id`` (served by ``worker_id``).

    Mirror of :func:`pause_broker_session`: looks up the registered
    :class:`WorkerExtension` for ``worker_id`` and calls
    :meth:`WorkerExtension.resume_session` to perform the state transition.

    Args:
        broker_id: The broker whose session should be resumed.
        worker_id: The worker lane currently holding the broker.

    Raises:
        ValueError: If ``broker_id`` or ``worker_id`` is empty or malformed.
        KeyError: If no worker is registered for ``worker_id``.
    """

    if not broker_id or not isinstance(broker_id, str):
        raise ValueError("resume_broker_session: broker_id must be a non-empty string")
    if not worker_id or not isinstance(worker_id, str):
        raise ValueError("resume_broker_session: worker_id must be a non-empty string")

    extension = _lookup_worker(worker_id)
    if extension is None:
        raise KeyError(
            f"resume_broker_session: no worker registered for worker_id={worker_id!r}"
        )
    session = extension.resume_session(broker_id)
    if session is None:
        raise ValueError(
            f"resume_broker_session: no session found for broker_id={broker_id!r} "
            f"on worker {worker_id!r}"
        )


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

    # -- pause / resume ----------------------------------------------------

    def pause_session(self, broker_id: str) -> Optional[GPU_SESSION_SCHEMA]:
        """Pause the first active session on ``broker_id``.

        Returns the updated session record, or ``None`` if no session exists
        for ``broker_id`` on this worker.

        Idempotent: pausing an already-``PAUSED`` session is a no-op and
        returns the existing paused record.  Sessions in ``WARMING_UP`` are
        also paused (the warm-up grace period is handled by sibling tasks).

        Args:
            broker_id: The broker whose session should be paused.

        Raises:
            ValueError: If ``broker_id`` is empty or malformed.
        """

        if not broker_id or not isinstance(broker_id, str):
            raise ValueError("pause_session: broker_id must be a non-empty string")

        bucket = self._sessions.get(broker_id)
        if not bucket:
            return None

        # Pick the first (and typically only) session for this broker.
        session_id, session = next(iter(bucket.items()))
        if session.status is GPUSessionStatus.PAUSED:
            # Idempotent: already paused.
            return session
        # Create a new paused record (dataclass is frozen, so we upsert).
        paused = dataclasses.replace(session, status=GPUSessionStatus.PAUSED)
        bucket[session_id] = paused
        return paused

    def resume_session(self, broker_id: str) -> Optional[GPU_SESSION_SCHEMA]:
        """Resume (un-pause) the first paused session on ``broker_id``.

        Returns the updated session record, or ``None`` if no session exists
        for ``broker_id`` on this worker.

        If the session is currently ``WARMING_UP``, it is left as-is (resume
        during warm-up is a no-op).  If the session is ``ACTIVE``, it is
        returned unchanged.

        Args:
            broker_id: The broker whose session should be resumed.

        Raises:
            ValueError: If ``broker_id`` is empty or malformed.
        """

        if not broker_id or not isinstance(broker_id, str):
            raise ValueError("resume_session: broker_id must be a non-empty string")

        bucket = self._sessions.get(broker_id)
        if not bucket:
            return None

        session_id, session = next(iter(bucket.items()))
        if session.status is GPUSessionStatus.ACTIVE:
            # Already active, nothing to do.
            return session
        if session.status is GPUSessionStatus.WARMING_UP:
            # Resume during warm-up is a no-op per contract.
            return session
        # Session is PAUSED: transition back to ACTIVE.
        resumed = dataclasses.replace(session, status=GPUSessionStatus.ACTIVE)
        bucket[session_id] = resumed
        return resumed

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
