"""Tests for GET /api/nodes (routes/nodes.py, nested under the instances blueprint): the node registry list with computed statuses, read through the node CLI
(src/node-registry.js) with a temp registry directory (AGENT_MANAGER_NODES_DIR), and the error paths when node cannot run.

Run: .venv/bin/python -m unittest python.dashboard.test_nodes_routes -v
"""
import json
import os
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes import nodes as nodes_routes  # noqa: E402


class NodesRoutesTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name) / "nodes"
        self._env = mock.patch.dict(os.environ, {"AGENT_MANAGER_NODES_DIR": str(self.dir)})
        self._env.start()
        self.client = app.app.test_client()

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def _write(self, nodes):
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "nodes.json").write_text(json.dumps(nodes), encoding="utf-8")

    def _seen(self, minutes_ago):
        return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")

    def test_an_empty_or_missing_registry_is_an_empty_list(self):
        r = self.client.get("/api/nodes")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json(), [])

    def test_lists_every_node_sorted_by_id_with_its_status(self):
        self._write({
            "wok": {"id": "wok", "lastSeen": self._seen(1), "state": "up", "paused": False},
            "grimm": {"id": "grimm", "lastSeen": self._seen(1), "state": "up", "paused": True, "cores": 4},
            "old": {"id": "old", "lastSeen": self._seen(60), "state": "up", "paused": False},
            "parked": {"id": "parked", "lastSeen": self._seen(1), "state": "off", "paused": False},
            "never": {"id": "never", "lastSeen": None},
        })
        got = self.client.get("/api/nodes").get_json()
        self.assertEqual([(n["id"], n["status"]) for n in got], [("grimm", "paused"), ("never", "stale"), ("old", "stale"), ("parked", "off"), ("wok", "up")])
        self.assertEqual(got[0]["cores"], 4)

    def test_no_token_ever_appears_in_the_list(self):
        self.dir.mkdir(parents=True)
        (self.dir / "nodes-tokens.json").write_text(json.dumps({"grimm": "SECRET-TOKEN"}), encoding="utf-8")
        self._write({"grimm": {"id": "grimm", "lastSeen": self._seen(1), "state": "up"}})
        self.assertNotIn("SECRET-TOKEN", self.client.get("/api/nodes").get_data(as_text=True))

    def test_a_node_that_cannot_run_is_a_500_with_a_message(self):
        with mock.patch.object(nodes_routes.subprocess, "run", side_effect=OSError("node missing")):
            r = self.client.get("/api/nodes")
        self.assertEqual(r.status_code, 500)
        self.assertIn("node missing", r.get_json()["description"])

    def test_a_failing_registry_and_a_non_json_answer_are_500s(self):
        failed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="boom")
        with mock.patch.object(nodes_routes.subprocess, "run", return_value=failed):
            r = self.client.get("/api/nodes")
        self.assertEqual((r.status_code, r.get_json()["description"]), (500, "boom"))
        junk = subprocess.CompletedProcess(args=[], returncode=0, stdout="<html>", stderr="")
        with mock.patch.object(nodes_routes.subprocess, "run", return_value=junk):
            r = self.client.get("/api/nodes")
        self.assertEqual(r.status_code, 500)
        self.assertIn("not JSON", r.get_json()["description"])

    def test_a_slow_node_is_a_500_and_the_call_carries_the_timeout_and_the_environment(self):
        with mock.patch.object(nodes_routes.subprocess, "run", side_effect=subprocess.TimeoutExpired(cmd="node", timeout=10)):
            r = self.client.get("/api/nodes")
        self.assertEqual(r.status_code, 500)
        self.assertIn("could not run the node registry", r.get_json()["description"])
        ok = subprocess.CompletedProcess(args=[], returncode=0, stdout="[]", stderr="")
        with mock.patch.object(nodes_routes.subprocess, "run", return_value=ok) as run:
            self.client.get("/api/nodes")
        self.assertEqual(run.call_args.kwargs["timeout"], nodes_routes.TIMEOUT_S)
        self.assertEqual(run.call_args.kwargs["env"]["AGENT_MANAGER_NODES_DIR"], str(self.dir))

    def test_the_route_is_read_only(self):
        self.assertEqual(self.client.post("/api/nodes", json={}).status_code, 405)


if __name__ == "__main__":
    unittest.main()
