"""Tests for the persistent "premium priority" pin (2026-09-07, Grimmethy: "I'll need a
way in app to be able to set that premium priority slot for any specific task. I am
getting tired of manually selecting it for the worker queue every pass.").

Covers POST /api/task-anywhere/<id>/premium-priority: finding a task wherever it
currently sits (pending/blocked/needs-clarification/drafting/adhoc/...), stamping or
clearing task.premiumPriority in place, and appending a history event. The claim-ranking
side of this feature (next-claimable-task.js's effectivePriority()) is covered by
src/next-claimable-task.test.js, not here -- this file only covers the dashboard route.

Run: .venv/bin/python -m unittest python.dashboard.test_premium_priority -v
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class PremiumPriorityTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.queue = root / "queue"
        for d in ["pending", "blocked", "needs-clarification", "adhoc", "drafting/worker-1"]:
            (self.queue / d).mkdir(parents=True)
        self._patches = [mock.patch.object(app, "queue_dir", return_value=self.queue)]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _write(self, state_dir, task_id, extra=None):
        task = {"id": task_id, "domain": "adhoc", "source": "manual", "title": "t", "history": []}
        if extra:
            task.update(extra)
        p = self.queue / state_dir / f"{task_id}.json"
        p.write_text(json.dumps(task, indent=2), encoding="utf-8")
        return p

    def _read(self, path):
        return json.loads(path.read_text(encoding="utf-8"))


class TestSetPremiumPriority(PremiumPriorityTestBase):
    def test_sets_premiumPriority_true_by_default(self):
        p = self._write("pending", "t1")
        res = self.client.post("/api/task-anywhere/t1/premium-priority")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json(), {"id": "t1", "premiumPriority": True})
        self.assertEqual(self._read(p)["premiumPriority"], True)

    def test_explicit_enabled_false_clears_the_flag(self):
        p = self._write("pending", "t1", {"premiumPriority": True})
        res = self.client.post("/api/task-anywhere/t1/premium-priority", json={"enabled": False})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json(), {"id": "t1", "premiumPriority": False})
        self.assertNotIn("premiumPriority", self._read(p))

    def test_appends_a_history_event(self):
        p = self._write("pending", "t1")
        self.client.post("/api/task-anywhere/t1/premium-priority")
        history = self._read(p)["history"]
        self.assertEqual(len(history), 1)
        self.assertIn("premium priority set", history[0]["detail"])

    def test_finds_task_in_blocked(self):
        p = self._write("blocked", "t1")
        self.client.post("/api/task-anywhere/t1/premium-priority")
        self.assertEqual(self._read(p)["premiumPriority"], True)

    def test_finds_task_in_needs_clarification(self):
        p = self._write("needs-clarification", "t1")
        self.client.post("/api/task-anywhere/t1/premium-priority")
        self.assertEqual(self._read(p)["premiumPriority"], True)

    def test_finds_task_in_adhoc(self):
        p = self._write("adhoc", "t1")
        self.client.post("/api/task-anywhere/t1/premium-priority")
        self.assertEqual(self._read(p)["premiumPriority"], True)

    def test_finds_task_in_another_lanes_drafting_dir(self):
        p = self._write("drafting/worker-1", "t1")
        self.client.post("/api/task-anywhere/t1/premium-priority")
        self.assertEqual(self._read(p)["premiumPriority"], True)

    def test_unknown_task_404s(self):
        res = self.client.post("/api/task-anywhere/does-not-exist/premium-priority")
        self.assertEqual(res.status_code, 404)

    def test_drafting_is_preferred_over_pending_when_a_task_id_somehow_exists_in_both(self):
        # Mirrors api_task_anywhere's own precedence -- drafting first (the common case
        # for an actively 'working' instance) -- confirms this route doesn't silently
        # pick a different, stale copy.
        drafting_path = self._write("drafting/worker-1", "t1")
        self._write("pending", "t1")
        self.client.post("/api/task-anywhere/t1/premium-priority")
        self.assertEqual(self._read(drafting_path)["premiumPriority"], True)


class TestPremiumPriorityProject(PremiumPriorityTestBase):
    """?project= selects another registered project's queue (resolve_scope is patched; its own tests live with branch_projects)."""

    def setUp(self):
        super().setUp()
        self.other_queue = Path(self._tmp.name) / "other-queue"
        (self.other_queue / "adhoc").mkdir(parents=True)
        self._scope = {"label": "other", "repoRoot": "/r/other", "qdir": self.other_queue}

        def fake_scope(project_root, active_root):
            if not project_root:
                return None
            if project_root == "/r/other":
                return self._scope
            raise LookupError(f"'{project_root}' is not a registered project")

        p = mock.patch("branch_projects.resolve_scope", side_effect=fake_scope)
        p.start()
        self.addCleanup(p.stop)

    def _write_other(self, task_id):
        path = self.other_queue / "adhoc" / f"{task_id}.json"
        path.write_text(json.dumps({"id": task_id, "history": []}), encoding="utf-8")
        return path

    def test_project_param_flags_a_task_in_another_projects_queue(self):
        path = self._write_other("o1")
        res = self.client.post("/api/task-anywhere/o1/premium-priority?project=/r/other")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self._read(path)["premiumPriority"], True)

    def test_project_in_body_works_too(self):
        path = self._write_other("o1")
        res = self.client.post("/api/task-anywhere/o1/premium-priority", json={"project": "/r/other"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self._read(path)["premiumPriority"], True)

    def test_unknown_project_is_404(self):
        self._write("pending", "t1")
        res = self.client.post("/api/task-anywhere/t1/premium-priority?project=/r/nope")
        self.assertEqual(res.status_code, 404)

    def test_active_only_task_is_not_found_when_another_project_is_named(self):
        p = self._write("pending", "t1")
        res = self.client.post("/api/task-anywhere/t1/premium-priority?project=/r/other")
        self.assertEqual(res.status_code, 404)
        self.assertNotIn("premiumPriority", self._read(p))

    def test_other_projects_task_is_not_found_in_the_active_queue(self):
        self._write_other("o1")
        res = self.client.post("/api/task-anywhere/o1/premium-priority")
        self.assertEqual(res.status_code, 404)


if __name__ == "__main__":
    unittest.main()
