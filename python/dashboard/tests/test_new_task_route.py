"""Run: python3 -m unittest discover -s python/dashboard/tests -p test_new_task_route.py"""
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent))

from flask import Flask  # noqa: E402

from routes.new_task import new_task_bp  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]


class NewTaskRoute(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.active_repo = base / "active-repo"
        self.other_repo = base / "other-repo"
        self.active_pipe = base / "active-pipeline"
        self.other_pipe = base / "other-pipeline"
        for d in (self.active_repo, self.other_repo, self.active_pipe, self.other_pipe):
            d.mkdir()
        for pipe in (self.active_pipe, self.other_pipe):
            (pipe / "task-domains.json").write_text(json.dumps({"adhoc": {}}), encoding="utf-8")
        registry = [
            {"repoRoot": str(self.active_repo), "pipelineDir": str(self.active_pipe),
             "domainsPath": str(self.active_pipe / "task-domains.json"), "label": "active-repo"},
            {"repoRoot": str(self.other_repo), "pipelineDir": str(self.other_pipe),
             "domainsPath": str(self.other_pipe / "task-domains.json"), "label": "other-repo"},
        ]
        fake_app = types.ModuleType("app")
        fake_app.PACKAGE_ROOT = REPO_ROOT
        fake_app.read_project_registry = lambda: registry
        fake_app.get_active_repo_root = lambda: str(self.active_repo)
        self._patch = mock.patch.dict(sys.modules, {"app": fake_app})
        self._patch.start()
        app = Flask(__name__)
        app.register_blueprint(new_task_bp)
        self.client = app.test_client()

    def tearDown(self):
        self._patch.stop()
        self.tmp.cleanup()

    def _queued(self, pipe):
        adhoc = pipe / "queue" / "adhoc"
        return sorted(adhoc.glob("*.json")) if adhoc.is_dir() else []

    def _post(self, **fields):
        return self.client.post("/api/new-task", json=fields)

    def test_valid_post_files_into_non_active_project(self):
        resp = self._post(title="  Fix the thing  ", text="  details here ", repo="other-repo",
                          premium=True, raisedFrom="brain-dump-7")
        self.assertEqual(resp.status_code, 200)
        files = self._queued(self.other_pipe)
        self.assertEqual(len(files), 1)
        record = json.loads(files[0].read_text(encoding="utf-8"))
        self.assertEqual(record["title"], "Fix the thing")
        self.assertIs(record["premiumPriority"], True)
        self.assertEqual(record["raisedFrom"], "brain-dump-7")
        self.assertEqual(record["promptContext"]["text"], "details here")
        self.assertEqual(resp.get_json()["id"], record["id"])

    def test_empty_title_is_400_and_creates_nothing(self):
        resp = self._post(title="   ", text="x", repo="other-repo")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(self._queued(self.other_pipe), [])

    def test_empty_text_is_400_and_creates_nothing(self):
        resp = self._post(title="t", text="", repo="other-repo")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(self._queued(self.other_pipe), [])

    def test_unknown_repo_is_400_and_creates_nothing(self):
        resp = self._post(title="t", text="x", repo="no-such-project")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(self._queued(self.other_pipe), [])
        self.assertEqual(self._queued(self.active_pipe), [])

    def test_active_project_is_refused_and_untouched(self):
        resp = self._post(title="t", text="x", repo="active-repo")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(self._queued(self.active_pipe), [])
        ok = self._post(title="t", text="x", repo="other-repo")
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(self._queued(self.active_pipe), [])

    def test_title_is_echoed_escaped(self):
        resp = self._post(title="<script>alert(1)</script>", text="x", repo="other-repo")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["title"], "&lt;script&gt;alert(1)&lt;/script&gt;")
        self.assertNotIn("<script>", resp.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
