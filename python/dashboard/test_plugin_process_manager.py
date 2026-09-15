"""Tests for plugin_process_manager.py -- particularly the port-guard fix
(2026-09-15) for a real incident confirmed live twice in one session: an untracked
process already serving a plugin's configured port made start() falsely report
"started"/"healthy" while the new child silently failed to bind and the OLD, stale
process kept answering health checks.

Run: .venv/bin/python -m unittest test_plugin_process_manager -v
"""
import socket
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import plugin_process_manager as ppm  # noqa: E402


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class TmpStateDirTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._patches = [
            mock.patch.object(ppm, "PID_DIR", self.tmp / "pids"),
            mock.patch.object(ppm, "LOG_DIR", self.tmp / "logs"),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)


class PortHelpersTest(unittest.TestCase):
    def test_port_from_url_parses_a_real_url(self):
        self.assertEqual(ppm._port_from_url("http://localhost:7442"), 7442)

    def test_port_from_url_returns_none_for_garbage(self):
        self.assertIsNone(ppm._port_from_url(""))
        self.assertIsNone(ppm._port_from_url("not a url"))

    def test_port_in_use_true_for_a_real_bound_port(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as srv:
            srv.bind(("127.0.0.1", 0))
            srv.listen(1)
            port = srv.getsockname()[1]
            self.assertTrue(ppm._port_in_use(port))

    def test_port_in_use_false_for_a_free_port(self):
        port = free_port()
        self.assertFalse(ppm._port_in_use(port))


class StartPortGuardTest(TmpStateDirTest):
    def test_start_refuses_when_port_is_answering_but_untracked(self):
        """The exact incident: something is on the port, our pidfile has never heard
        of it. start() must refuse loudly, not spawn a duplicate."""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as orphan:
            orphan.bind(("127.0.0.1", 0))
            orphan.listen(1)
            port = orphan.getsockname()[1]
            entry = {
                "name": "test-plugin", "url": f"http://localhost:{port}",
                "process": {"command": "/bin/sleep", "args": ["30"]},
            }
            result = ppm.start(entry)
            self.assertFalse(result)
            self.assertFalse(ppm._pidfile("test-plugin").exists(), "must not have written a pidfile for a refused start")

    def test_start_succeeds_normally_when_the_port_is_genuinely_free(self):
        port = free_port()
        entry = {
            "name": "test-plugin", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        try:
            result = ppm.start(entry)
            self.assertTrue(result)
            self.assertTrue(ppm.is_running("test-plugin"))
        finally:
            ppm.stop("test-plugin")

    def test_start_with_no_url_skips_the_port_guard_entirely(self):
        # A malformed/incomplete entry (no url) must not crash the guard -- falls
        # through to the normal spawn path unaffected.
        entry = {"name": "test-plugin", "process": {"command": "/bin/sleep", "args": ["30"]}}
        try:
            result = ppm.start(entry)
            self.assertTrue(result)
        finally:
            ppm.stop("test-plugin")

    def test_is_running_already_true_short_circuits_before_the_port_guard(self):
        # Idempotent-start path: if OUR OWN tracked pid is genuinely alive, start()
        # returns True immediately without even consulting the port guard.
        port = free_port()
        entry = {
            "name": "test-plugin", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        try:
            self.assertTrue(ppm.start(entry))
            with mock.patch.object(ppm, "_port_in_use") as spy:
                self.assertTrue(ppm.start(entry))
                spy.assert_not_called()
        finally:
            ppm.stop("test-plugin")


class StopTest(TmpStateDirTest):
    def test_stop_kills_a_real_process_and_removes_the_pidfile(self):
        port = free_port()
        entry = {
            "name": "test-plugin", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        ppm.start(entry)
        self.assertTrue(ppm.is_running("test-plugin"))
        self.assertTrue(ppm.stop("test-plugin"))
        self.assertFalse(ppm.is_running("test-plugin"))
        self.assertFalse(ppm._pidfile("test-plugin").exists())

    def test_stop_on_an_already_gone_process_is_a_harmless_no_op(self):
        self.assertTrue(ppm.stop("never-started-plugin"))


if __name__ == "__main__":
    unittest.main()
