"""Tests for src/workers/gpu_session.py"""

import sys
import unittest
from src.workers.gpu_session import (
    GPU_SESSION_SCHEMA,
    GPUSessionStatus,
    WARMUP_GRACE_PERIOD_SECONDS,
    pause_broker_session,
    resume_broker_session,
    WorkerExtension,
    register_worker,
    _clear_registry,
)


class TestGPUSessionSchema(unittest.TestCase):
    def test_schema_fields(self):
        session = GPU_SESSION_SCHEMA(
            session_id="s-1",
            broker_id="b-1",
            model_name="qwen3:8b",
            status=GPUSessionStatus.ACTIVE,
        )
        self.assertEqual(session.session_id, "s-1")
        self.assertEqual(session.broker_id, "b-1")
        self.assertEqual(session.model_name, "qwen3:8b")
        self.assertEqual(session.status, GPUSessionStatus.ACTIVE)

    def test_schema_is_frozen(self):
        session = GPU_SESSION_SCHEMA(
            session_id="s-1",
            broker_id="b-1",
            model_name="qwen3:8b",
            status=GPUSessionStatus.ACTIVE,
        )
        with self.assertRaises(AttributeError):
            session.status = GPUSessionStatus.PAUSED


class TestWARMUPGracePeriod(unittest.TestCase):
    def test_default_value(self):
        self.assertEqual(WARMUP_GRACE_PERIOD_SECONDS, 30)


class TestPauseBrokerSession(unittest.TestCase):
    def setUp(self):
        _clear_registry()
        self.worker = WorkerExtension()
        register_worker("worker-1", self.worker)

    def tearDown(self):
        _clear_registry()

    def test_pause_sets_session_paused(self):
        self.worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-1",
                broker_id="b-1",
                model_name="qwen3:8b",
                status=GPUSessionStatus.ACTIVE,
            )
        )
        pause_broker_session("b-1", "worker-1")
        sessions = self.worker.get_gpu_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].status, GPUSessionStatus.PAUSED)

    def test_double_pause_is_idempotent(self):
        self.worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-1",
                broker_id="b-1",
                model_name="qwen3:8b",
                status=GPUSessionStatus.ACTIVE,
            )
        )
        pause_broker_session("b-1", "worker-1")
        pause_broker_session("b-1", "worker-1")
        sessions = self.worker.get_gpu_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].status, GPUSessionStatus.PAUSED)

    def test_unknown_worker_raises_keyerror(self):
        with self.assertRaises(KeyError):
            pause_broker_session("b-1", "unknown-worker")

    def test_empty_broker_id_raises_valueerror(self):
        with self.assertRaises(ValueError):
            pause_broker_session("", "worker-1")

    def test_empty_worker_id_raises_valueerror(self):
        with self.assertRaises(ValueError):
            pause_broker_session("b-1", "")


class TestResumeBrokerSession(unittest.TestCase):
    def setUp(self):
        _clear_registry()
        self.worker = WorkerExtension()
        register_worker("worker-1", self.worker)

    def tearDown(self):
        _clear_registry()

    def test_resume_during_warmup_is_noop(self):
        self.worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-1",
                broker_id="b-1",
                model_name="qwen3:8b",
                status=GPUSessionStatus.WARMING_UP,
            )
        )
        resume_broker_session("b-1", "worker-1")
        sessions = self.worker.get_gpu_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].status, GPUSessionStatus.WARMING_UP)

    def test_resume_paused_session(self):
        self.worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-1",
                broker_id="b-1",
                model_name="qwen3:8b",
                status=GPUSessionStatus.ACTIVE,
            )
        )
        pause_broker_session("b-1", "worker-1")
        resume_broker_session("b-1", "worker-1")
        sessions = self.worker.get_gpu_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].status, GPUSessionStatus.ACTIVE)

    def test_unknown_worker_raises_keyerror(self):
        with self.assertRaises(KeyError):
            resume_broker_session("b-1", "unknown-worker")


class TestWorkerExtension(unittest.TestCase):
    def test_get_gpu_sessions_empty(self):
        worker = WorkerExtension()
        self.assertEqual(worker.get_gpu_sessions(), [])

    def test_get_gpu_sessions_with_sessions(self):
        worker = WorkerExtension()
        worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-1",
                broker_id="b-1",
                model_name="qwen3:8b",
                status=GPUSessionStatus.ACTIVE,
            )
        )
        worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-2",
                broker_id="b-2",
                model_name="llama3:70b",
                status=GPUSessionStatus.PAUSED,
            )
        )
        sessions = worker.get_gpu_sessions()
        self.assertEqual(len(sessions), 2)
        self.assertEqual(sessions[0].broker_id, "b-1")
        self.assertEqual(sessions[1].broker_id, "b-2")

    def test_get_gpu_session_by_id(self):
        worker = WorkerExtension()
        session = GPU_SESSION_SCHEMA(
            session_id="s-1",
            broker_id="b-1",
            model_name="qwen3:8b",
            status=GPUSessionStatus.ACTIVE,
        )
        worker.register_session(session)
        found = worker.get_gpu_session("b-1", "s-1")
        self.assertEqual(found, session)
        self.assertIsNone(worker.get_gpu_session("b-1", "s-999"))

    def test_sessions_by_broker(self):
        worker = WorkerExtension()
        worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-1",
                broker_id="b-1",
                model_name="qwen3:8b",
                status=GPUSessionStatus.ACTIVE,
            )
        )
        worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-2",
                broker_id="b-1",
                model_name="llama3:70b",
                status=GPUSessionStatus.PAUSED,
            )
        )
        sessions = worker.sessions_by_broker("b-1")
        self.assertEqual(len(sessions), 2)

    def test_sessions_by_status(self):
        worker = WorkerExtension()
        worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-1",
                broker_id="b-1",
                model_name="qwen3:8b",
                status=GPUSessionStatus.ACTIVE,
            )
        )
        worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-2",
                broker_id="b-2",
                model_name="llama3:70b",
                status=GPUSessionStatus.PAUSED,
            )
        )
        active = worker.sessions_by_status(GPUSessionStatus.ACTIVE)
        paused = worker.sessions_by_status(GPUSessionStatus.PAUSED)
        self.assertEqual(len(active), 1)
        self.assertEqual(len(paused), 1)

    def test_has_active_session(self):
        worker = WorkerExtension()
        self.assertFalse(worker.has_active_session("b-1"))
        worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-1",
                broker_id="b-1",
                model_name="qwen3:8b",
                status=GPUSessionStatus.ACTIVE,
            )
        )
        self.assertTrue(worker.has_active_session("b-1"))

    def test_unregister_session(self):
        worker = WorkerExtension()
        worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-1",
                broker_id="b-1",
                model_name="qwen3:8b",
                status=GPUSessionStatus.ACTIVE,
            )
        )
        worker.unregister_session("b-1", "s-1")
        self.assertEqual(worker.get_gpu_sessions(), [])
        worker.unregister_session("b-999", "s-999")

    def test_clear(self):
        worker = WorkerExtension()
        worker.register_session(
            GPU_SESSION_SCHEMA(
                session_id="s-1",
                broker_id="b-1",
                model_name="qwen3:8b",
                status=GPUSessionStatus.ACTIVE,
            )
        )
        worker.clear()
        self.assertEqual(worker.get_gpu_sessions(), [])


if __name__ == "__main__":
    unittest.main()
