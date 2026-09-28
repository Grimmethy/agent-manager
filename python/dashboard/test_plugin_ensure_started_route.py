"""Tests for POST /api/plugins/<name>/ensure-started (routes/plugins.py,
api_plugin_ensure_started) -- the real lazy-start a script-kind dashboard tab
(PromptForge/AdForge/ScriptForge) calls before pointing its iframe at the plugin's url,
so opening the tab actually starts the backend process instead of silently embedding an
iframe pointed at a dead port.

Run: .venv/bin/python -m unittest python.dashboard.test_plugin_ensure_started_route -v
"""
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import plugin_process_manager as ppm  # noqa: E402


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class EnsureStartedTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._root = Path(self._tmp.name)

        self._orig_manifest = app.PLUGINS_MANIFEST_PATH
        app.PLUGINS_MANIFEST_PATH = self._root / "plugins.json"
        self.client = app.app.test_client()

        state_tmp = Path(tempfile.mkdtemp())
        self._state_patches = [
            mock.patch.object(ppm, "PID_DIR", state_tmp / "pids"),
            mock.patch.object(ppm, "LOG_DIR", state_tmp / "logs"),
        ]
        for p in self._state_patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        app.PLUGINS_MANIFEST_PATH = self._orig_manifest
        self._tmp.cleanup()

    def _write_manifest(self, entries):
        app._write_plugins_manifest(entries)


class UnknownOrMalformedPluginTest(EnsureStartedTestBase):
    def test_unknown_plugin_is_404(self):
        self._write_manifest([])
        resp = self.client.post("/api/plugins/nope/ensure-started")
        self.assertEqual(resp.status_code, 404)
        self.assertIn("no plugin named", resp.get_json()["description"])

    def test_plugin_with_no_process_block_is_400(self):
        # A pure register.js task-source plugin (e.g. agent-manager-hygiene) has
        # nothing this route could ever start.
        self._write_manifest([{"name": "hygiene-plugin", "registerPath": "/x/register.js", "enabled": True}])
        resp = self.client.post("/api/plugins/hygiene-plugin/ensure-started")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("no process block", resp.get_json()["description"])


class EnsureStartedRealProcessTest(EnsureStartedTestBase):
    def test_not_yet_running_starts_it_and_waits_for_health(self):
        port = free_port()
        entry = {
            "name": "test-plugin", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        self._write_manifest([entry])
        try:
            with mock.patch.object(app, "_wait_for_plugin_health", return_value=True) as health_spy:
                resp = self.client.post("/api/plugins/test-plugin/ensure-started")
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            self.assertEqual(body["name"], "test-plugin")
            self.assertEqual(body["url"], entry["url"])
            self.assertFalse(body["alreadyRunning"])
            self.assertTrue(body["started"])
            self.assertTrue(body["healthy"])
            health_spy.assert_called_once()
            self.assertTrue(ppm.is_running("test-plugin"))
        finally:
            ppm.stop("test-plugin")

    def test_already_running_reports_alreadyRunning_and_skips_the_health_poll(self):
        port = free_port()
        entry = {
            "name": "test-plugin", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        self._write_manifest([entry])
        try:
            self.assertTrue(ppm.start(entry))
            with mock.patch.object(app, "_wait_for_plugin_health") as health_spy:
                resp = self.client.post("/api/plugins/test-plugin/ensure-started")
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            self.assertTrue(body["alreadyRunning"])
            self.assertTrue(body["started"], "start() itself is idempotent and still reports True")
            self.assertTrue(body["healthy"])
            health_spy.assert_not_called()
        finally:
            ppm.stop("test-plugin")

    def test_shared_processName_entry_is_recognized_as_already_running(self):
        # Mirrors test_plugin_process_manager.py's SharedProcessKeyTest: a second
        # manifest entry sharing another's processName must be recognized as the same
        # live process, not treated as needing its own start.
        port = free_port()
        entry_a = {
            "name": "wikiforge-secondbrain", "processName": "wikiforge", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        entry_b = {
            "name": "wikiforge-propertyforager", "processName": "wikiforge", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        self._write_manifest([entry_a, entry_b])
        try:
            self.assertTrue(ppm.start(entry_a))
            with mock.patch.object(app, "_wait_for_plugin_health") as health_spy:
                resp = self.client.post("/api/plugins/wikiforge-propertyforager/ensure-started")
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json()
            self.assertTrue(body["alreadyRunning"])
            health_spy.assert_not_called()
        finally:
            ppm.stop(ppm.process_key(entry_a))


if __name__ == "__main__":
    unittest.main()
