"""Project-scoped amend (routes/task_amend.py). Run: python3 python/dashboard/test_task_amend_project.py

The amend route picks its queue like the other task routes: ?project=<repoRoot> selects a registered project's queue, no project means the active
queue, an unregistered project is a 404 that never falls back to the active queue. Everything lives in a temp dir; routes.task is stubbed."""
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask, abort, jsonify, request

ROUTE_FILE = Path(__file__).resolve().parent / "routes" / "task_amend.py"

_stub = types.ModuleType("routes.task")
_stub.requeued = []
_stub.registry = {}


def _fake_requeue(state, task_id):
    _stub.requeued.append((state, task_id, request.args.get("project")))
    return jsonify({"ok": True, "requeued": task_id}), 200


def _fake_qdir(body=None, queue_only=False):
    project = request.args.get("project") or (body.get("project") if isinstance(body, dict) else None)
    if not project:
        return Path(os.environ["AGENT_MANAGER_PIPELINE_DIR"]) / "queue", None
    if project in _stub.registry:
        return _stub.registry[project], {"repoPath": project}
    abort(404, description="project not registered")


_stub.api_task_requeue = _fake_requeue
_stub._qdir_for_request = _fake_qdir

spec = importlib.util.spec_from_file_location("task_amend_project_under_test", ROUTE_FILE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class ProjectScopedAmendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.active = root / "active-pipeline" / "queue"
        self.other = root / "other-pipeline" / "queue"
        for q in (self.active, self.other):
            (q / "blocked").mkdir(parents=True)
        self.env = mock.patch.dict(os.environ, {"AGENT_MANAGER_PIPELINE_DIR": str(root / "active-pipeline")})
        self.env.start()
        # The route imports routes.task lazily, so another test file's stub could be the one in sys.modules when a request runs: install ours per test.
        self._prev_stub = sys.modules.get("routes.task")
        sys.modules["routes.task"] = _stub
        _stub.registry.clear()
        _stub.registry["/repos/other"] = self.other
        _stub.requeued.clear()
        app = Flask(__name__)
        app.register_blueprint(mod.task_amend_bp)
        self.client = app.test_client()

    def tearDown(self):
        if self._prev_stub is None:
            sys.modules.pop("routes.task", None)
        else:
            sys.modules["routes.task"] = self._prev_stub
        self.env.stop()
        self.tmp.cleanup()

    def _write(self, queue, task_id, text="Old text.\nFiles: a.py"):
        f = queue / "blocked" / f"{task_id}.json"
        f.write_text(json.dumps({"id": task_id, "promptContext": {"rawText": text}, "blockedReason": "same blocker", "localRejectCount": 3}), encoding="utf-8")
        return f

    def test_no_project_amends_the_active_queue_as_before(self):
        f = self._write(self.active, "A1")
        r = self.client.post("/api/task/blocked/A1/amend", json={"reason": "fix", "rawText": "New text."})
        self.assertEqual(r.status_code, 200)
        rec = json.loads(f.read_text(encoding="utf-8"))
        self.assertEqual(rec["promptContext"]["rawText"], "New text.")
        self.assertIsNone(rec["blockedReason"])
        self.assertEqual(_stub.requeued, [("blocked", "A1", None)])

    def test_project_param_reaches_the_other_projects_queue_only(self):
        other = self._write(self.other, "O1")
        active = self._write(self.active, "A2")
        before = active.read_text(encoding="utf-8")
        r = self.client.post("/api/task/blocked/O1/amend?project=/repos/other", json={"reason": "fix", "rawText": "Other new text."})
        self.assertEqual(r.status_code, 200)
        rec = json.loads(other.read_text(encoding="utf-8"))
        self.assertEqual(rec["promptContext"]["rawText"], "Other new text.")
        self.assertIsNone(rec["blockedReason"])
        self.assertEqual(rec["localRejectCount"], 0)
        self.assertEqual(active.read_text(encoding="utf-8"), before)
        self.assertEqual(_stub.requeued, [("blocked", "O1", "/repos/other")])

    def test_unregistered_project_is_404_and_never_touches_the_active_queue(self):
        active = self._write(self.active, "A3")
        before = active.read_text(encoding="utf-8")
        r = self.client.post("/api/task/blocked/A3/amend?project=/repos/nope", json={"reason": "fix", "rawText": "X"})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(active.read_text(encoding="utf-8"), before)
        self.assertEqual(_stub.requeued, [])

    def test_task_only_in_the_active_queue_is_404_when_another_project_is_named(self):
        self._write(self.active, "A4")
        r = self.client.post("/api/task/blocked/A4/amend?project=/repos/other", json={"reason": "fix", "rawText": "X"})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(_stub.requeued, [])

    def test_files_replaces_the_files_line_in_a_project_scoped_amend(self):
        other = self._write(self.other, "O2", text="Do it.\nFiles: old.py")
        r = self.client.post("/api/task/blocked/O2/amend?project=/repos/other", json={"reason": "fix", "files": ["new.py", "new2.py"]})
        self.assertEqual(r.status_code, 200)
        text = json.loads(other.read_text(encoding="utf-8"))["promptContext"]["rawText"]
        self.assertIn("Files: new.py, new2.py", text)
        self.assertNotIn("old.py", text)

    def test_missing_reason_is_400_for_a_project_scoped_call(self):
        self._write(self.other, "O3")
        r = self.client.post("/api/task/blocked/O3/amend?project=/repos/other", json={"rawText": "X"})
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main()
