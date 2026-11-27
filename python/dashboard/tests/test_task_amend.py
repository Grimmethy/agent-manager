"""Tests for routes/task_amend.py (amend + insert-piece). Run: python3 python/dashboard/tests/test_task_amend.py"""
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask, jsonify

ROUTE_FILE = Path(__file__).resolve().parents[1] / "routes" / "task_amend.py"

# Stub the existing requeue view so the amend route can be tested without the full dashboard.
_stub = types.ModuleType("routes.task")
_stub.requeued = []


def _fake_requeue(state, task_id):
    _stub.requeued.append((state, task_id))
    return jsonify({"ok": True, "requeued": task_id}), 200


_stub.api_task_requeue = _fake_requeue
_stub._qdir_for_request = lambda body=None, queue_only=False: ((Path(os.environ["AGENT_MANAGER_PIPELINE_DIR"]) / "queue") if os.environ.get("AGENT_MANAGER_PIPELINE_DIR") else None, None)
sys.modules["routes.task"] = _stub

spec = importlib.util.spec_from_file_location("task_amend_under_test", ROUTE_FILE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class AmendRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pdir = Path(self.tmp.name)
        (self.pdir / "queue" / "blocked").mkdir(parents=True)
        (self.pdir / "queue" / "done").mkdir(parents=True)
        self.env = mock.patch.dict(os.environ, {"AGENT_MANAGER_PIPELINE_DIR": str(self.pdir)})
        self.env.start()
        app = Flask(__name__)
        app.register_blueprint(mod.task_amend_bp)
        self.client = app.test_client()
        _stub.requeued.clear()
        self.target = self.pdir / "queue" / "blocked" / "T1.json"
        self.other = self.pdir / "queue" / "blocked" / "T2.json"
        base = {"id": "T1", "promptContext": {"rawText": "Do the thing.\nFiles: a.py"}, "blockedReason": "same blocker", "localRejectCount": 3}
        self.target.write_text(json.dumps(base), encoding="utf-8")
        other = {"id": "T2", "promptContext": {"rawText": "Other."}, "blockedReason": "same blocker"}
        self.other.write_text(json.dumps(other), encoding="utf-8")

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_amend_edits_only_target_and_clears_block(self):
        r = self.client.post("/api/task/blocked/T1/amend", json={"reason": "fixed", "rawText": "New text.", "files": ["b.py"]})
        self.assertEqual(r.status_code, 200)
        rec = json.loads(self.target.read_text(encoding="utf-8"))
        self.assertEqual(rec["promptContext"]["rawText"], "New text.\nFiles: b.py")
        self.assertIsNone(rec["blockedReason"])
        self.assertEqual(rec["localRejectCount"], 0)
        self.assertEqual([h for h in rec["history"] if h["stage"] == "amended"].__len__(), 1)
        self.assertEqual(_stub.requeued, [("blocked", "T1")])
        # Case A: the other task with the same blocker text is untouched.
        other = json.loads(self.other.read_text(encoding="utf-8"))
        self.assertEqual(other["blockedReason"], "same blocker")
        self.assertNotIn("history", other)

    def test_rejects_done_and_archived_without_writing(self):
        for state in ("done", "archived"):
            before = self.target.read_text(encoding="utf-8")
            r = self.client.post(f"/api/task/{state}/T1/amend", json={"reason": "x", "rawText": "y"})
            self.assertEqual(r.status_code, 400)
            self.assertEqual(self.target.read_text(encoding="utf-8"), before)
        self.assertEqual(_stub.requeued, [])

    def test_requires_reason(self):
        r = self.client.post("/api/task/blocked/T1/amend", json={"rawText": "y"})
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("history", json.loads(self.target.read_text(encoding="utf-8")))

    def test_requires_rawtext_or_files(self):
        r = self.client.post("/api/task/blocked/T1/amend", json={"reason": "x"})
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("history", json.loads(self.target.read_text(encoding="utf-8")))

    def test_missing_task_is_404(self):
        r = self.client.post("/api/task/blocked/NOPE/amend", json={"reason": "x", "rawText": "y"})
        self.assertEqual(r.status_code, 404)


class InsertPieceRouteTests(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.register_blueprint(mod.task_amend_bp)
        self.client = app.test_client()

    def test_requires_exactly_one_anchor(self):
        base = {"title": "T", "rawText": "R"}
        r = self.client.post("/api/hub/H1/insert-piece", json=dict(base, before="a", after="b"))
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/api/hub/H1/insert-piece", json=base)
        self.assertEqual(r.status_code, 400)

    def test_cli_error_mapping(self):
        def run_with(stdout, code=1):
            return mock.Mock(stdout=stdout, stderr="", returncode=code)
        body = {"title": "T", "rawText": "R", "before": "a"}
        with mock.patch.object(mod.subprocess, "run", return_value=run_with(json.dumps({"ok": False, "error": "no coordinating hub 'H1'"}) + "\n")):
            self.assertEqual(self.client.post("/api/hub/H1/insert-piece", json=body).status_code, 404)
        with mock.patch.object(mod.subprocess, "run", return_value=run_with(json.dumps({"ok": False, "error": "anchor 'a' is in state done"}) + "\n")):
            self.assertEqual(self.client.post("/api/hub/H1/insert-piece", json=body).status_code, 409)
        with mock.patch.object(mod.subprocess, "run", return_value=run_with(json.dumps({"ok": True, "id": "X"}) + "\n", 0)) as run:
            self.assertEqual(self.client.post("/api/hub/H1/insert-piece", json=body).status_code, 200)
            args = run.call_args[0][0]
            self.assertIn("--before", args)
            self.assertFalse(run.call_args[1].get("shell", False))


if __name__ == "__main__":
    unittest.main()
