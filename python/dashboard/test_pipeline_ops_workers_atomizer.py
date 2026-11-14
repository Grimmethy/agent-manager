"""The Workers tab's card for the task atomizer (routes/pipeline_ops_workers.py, agent-manager-pipeline-ops docs/task-atomizer.md), 2026-11-13.

A separate file from test_pipeline_ops_workers.py on purpose: that file's module-level helpers sit under the size ratchet and grow with every line added to it.
Everything the route reads lives in a temp HOME: no real ledger, no real drain.
Run: .venv/bin/python -m unittest python.dashboard.test_pipeline_ops_workers_atomizer -v   (from the repo root)
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes import pipeline_ops_workers as po  # noqa: E402


class AtomizerCard(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="po-atomizer-")
        self.state = os.path.join(self.home, ".local", "state", "pipeline-ops")
        patch = mock.patch.dict(os.environ, {"HOME": self.home})
        patch.start()
        self.addCleanup(patch.stop)
        self.client = app.app.test_client()

    def test_the_atomizer_is_a_worker_after_the_hub(self):
        self.assertEqual(po.WORKERS[-2:], ("hub", "atomizer"))

    def test_its_paths_follow_the_worker_name(self):
        env = {"HOME": "/h"}
        base = os.path.join("/h", ".local", "state", "pipeline-ops")
        self.assertEqual(po.ledger_path("atomizer", env), os.path.join(base, "atomizer-ledger.jsonl"))
        self.assertEqual(po.switch_path("atomizer", env), os.path.join(base, "atomizer-disabled"))
        self.assertEqual(po.ledger_path("atomizer", {"HOME": "/h", "ATOMIZER_LEDGER_PATH": "/x/a"}), "/x/a")
        self.assertEqual(po.switch_path("atomizer", {"HOME": "/h", "ATOMIZER_DISABLED_PATH": "/x/m"}), "/x/m")

    def test_without_a_trace_it_is_not_configured_and_with_a_ledger_it_is(self):
        self.assertEqual(self.client.get("/api/pipeline-ops-workers").get_json()["workers"]["atomizer"], {"configured": False, "name": "atomizer"})
        os.makedirs(self.state)
        row = {"at": "2020-01-01T12:00:00Z", "mode": "dry-run", "key": "stalled/classify", "version": "v1", "outcome": "CAPTURE-CASES", "reason": "no cases", "evidence_keys": ["cases.count"],
               "factsKey": "f", "phase": "result", "action": "capture", "result": "dry-run: not executed"}
        with open(os.path.join(self.state, "atomizer-ledger.jsonl"), "w") as f:
            f.write(json.dumps(row) + "\n")
        got = self.client.get("/api/pipeline-ops-workers").get_json()["workers"]
        self.assertTrue(got["atomizer"]["configured"])
        self.assertEqual((got["atomizer"]["mode"], got["atomizer"]["decisions"]), ("dry-run", 1))
        self.assertEqual(got["atomizer"]["today"], {})
        self.assertEqual(got["hub"], {"configured": False, "name": "hub"})

    def test_turning_it_off_and_on_writes_and_removes_only_its_own_marker(self):
        r = self.client.post("/api/pipeline-ops-workers/atomizer/enabled", json={"enabled": False})
        self.assertEqual((r.status_code, r.get_json()["name"], r.get_json()["switch"]["disabled"]), (200, "atomizer", True))
        self.assertEqual(os.listdir(self.state), ["atomizer-disabled"])
        got = self.client.get("/api/pipeline-ops-workers").get_json()["workers"]
        self.assertTrue(got["atomizer"]["switch"]["disabled"])
        self.assertFalse(got["hub"]["configured"])
        r = self.client.post("/api/pipeline-ops-workers/atomizer/enabled", json={"enabled": True})
        self.assertEqual(r.get_json()["switch"], {"disabled": False, "disabledAt": None})
        self.assertEqual(os.listdir(self.state), [])


if __name__ == "__main__":
    unittest.main()
