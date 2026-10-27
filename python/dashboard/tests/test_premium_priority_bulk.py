"""Tests for the bulk premium priority endpoint (POST /api/tasks/premium-priority).

Covers the bulk variant that accepts {ids: [str], enabled: bool} and returns
{results: [{ok, notFound, error}, ...], summary: {ok: N, notFound: N, error: N}}.
Verifies per-id results, summary counts, and best-effort behavior (partial
failures don't stop processing).

Run: .venv/bin/python -m unittest python.dashboard.tests.test_premium_priority_bulk -v
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent))

import app  # noqa: E402


class BulkPremiumPriorityTestBase(unittest.TestCase):
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


class TestBulkPremiumPriority(BulkPremiumPriorityTestBase):
    def test_mixed_valid_invalid_ids_returns_per_id_results(self):
        """Mixed valid/invalid IDs: each gets its own result dict with ok/notFound/error."""
        valid_path = self._write("pending", "t1")
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": ["t1", "does-not-exist"],
            "enabled": True
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertIn("results", data)
        self.assertIn("summary", data)
        self.assertEqual(len(data["results"]), 2)
        # Find the result for t1
        t1_result = next(r for r in data["results"] if r.get("id") == "t1")
        other_result = next(r for r in data["results"] if r.get("id") == "does-not-exist")
        self.assertTrue(t1_result["ok"])
        self.assertFalse(other_result["ok"])
        self.assertTrue(other_result.get("notFound"))
        # Verify the valid task was actually updated by checking the file directly
        self.assertEqual(self._read(valid_path)["premiumPriority"], True)

    def test_summary_counts_match_per_id_results(self):
        """Summary.ok/summary.notFound/summary.error should match the per-id results."""
        self._write("pending", "t1")
        self._write("blocked", "t2")
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": ["t1", "t2", "does-not-exist"],
            "enabled": True
        })
        data = res.get_json()
        self.assertEqual(data["summary"]["ok"], 2)
        self.assertEqual(data["summary"]["notFound"], 1)
        self.assertEqual(data["summary"]["error"], 0)

    def test_best_effort_all_ids_processed(self):
        """Best-effort: even if some IDs fail, all IDs are processed and returned."""
        self._write("pending", "t1")
        self._write("blocked", "t2")
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": ["t1", "does-not-exist", "t2", "also-does-not-exist"],
            "enabled": True
        })
        data = res.get_json()
        self.assertEqual(len(data["results"]), 4)
        # Both valid tasks should be processed
        t1_result = next(r for r in data["results"] if r.get("id") == "t1")
        t2_result = next(r for r in data["results"] if r.get("id") == "t2")
        self.assertTrue(t1_result["ok"])
        self.assertTrue(t2_result["ok"])
        self.assertEqual(self._read(self.queue / "pending" / "t1.json")["premiumPriority"], True)
        self.assertEqual(self._read(self.queue / "blocked" / "t2.json")["premiumPriority"], True)

    def test_all_valid_ids(self):
        """All valid IDs: summary.ok equals the number of IDs, no notFound or error."""
        self._write("pending", "t1")
        self._write("blocked", "t2")
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": ["t1", "t2"],
            "enabled": True
        })
        data = res.get_json()
        self.assertEqual(data["summary"]["ok"], 2)
        self.assertEqual(data["summary"]["notFound"], 0)
        self.assertEqual(data["summary"]["error"], 0)

    def test_all_invalid_ids(self):
        """All invalid IDs: summary.notFound equals the number of IDs, no ok or error."""
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": ["does-not-exist", "also-does-not-exist"],
            "enabled": True
        })
        data = res.get_json()
        self.assertEqual(data["summary"]["ok"], 0)
        self.assertEqual(data["summary"]["notFound"], 2)
        self.assertEqual(data["summary"]["error"], 0)

    def test_empty_ids_list(self):
        """Empty IDs list: results is empty, summary is all zeros."""
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": [],
            "enabled": True
        })
        data = res.get_json()
        self.assertEqual(data["results"], [])
        self.assertEqual(data["summary"]["ok"], 0)
        self.assertEqual(data["summary"]["notFound"], 0)
        self.assertEqual(data["summary"]["error"], 0)

    def test_enabled_false_clears_premium_priority(self):
        """enabled=False: valid tasks have premiumPriority removed, notFound tasks reported."""
        valid_path = self._write("pending", "t1", {"premiumPriority": True})
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": ["t1", "does-not-exist"],
            "enabled": False
        })
        data = res.get_json()
        self.assertEqual(data["summary"]["ok"], 1)
        self.assertEqual(data["summary"]["notFound"], 1)
        # Verify the valid task was actually cleared by checking the file directly
        self.assertNotIn("premiumPriority", self._read(valid_path))

    def test_enabled_true_sets_premium_priority(self):
        """enabled=True: valid tasks get premiumPriority=True, notFound tasks reported."""
        valid_path = self._write("pending", "t1")
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": ["t1", "does-not-exist"],
            "enabled": True
        })
        data = res.get_json()
        self.assertEqual(data["summary"]["ok"], 1)
        self.assertEqual(data["summary"]["notFound"], 1)
        # Verify the valid task was actually updated by checking the file directly
        self.assertEqual(self._read(valid_path)["premiumPriority"], True)

    def test_appends_history_events_for_valid_tasks(self):
        """History events are appended for each successfully processed task."""
        valid_path = self._write("pending", "t1")
        self.client.post("/api/tasks/premium-priority", json={
            "ids": ["t1"],
            "enabled": True
        })
        history = self._read(valid_path)["history"]
        self.assertEqual(len(history), 1)
        self.assertIn("premium priority set", history[0]["detail"])

    def test_finds_task_in_blocked(self):
        """Tasks in blocked state are found and processed."""
        valid_path = self._write("blocked", "t1")
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": ["t1"],
            "enabled": True
        })
        data = res.get_json()
        self.assertEqual(data["summary"]["ok"], 1)
        self.assertEqual(self._read(valid_path)["premiumPriority"], True)

    def test_finds_task_in_needs_clarification(self):
        """Tasks in needs-clarification state are found and processed."""
        valid_path = self._write("needs-clarification", "t1")
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": ["t1"],
            "enabled": True
        })
        data = res.get_json()
        self.assertEqual(data["summary"]["ok"], 1)
        self.assertEqual(self._read(valid_path)["premiumPriority"], True)

    def test_finds_task_in_adhoc(self):
        """Tasks in adhoc state are found and processed."""
        valid_path = self._write("adhoc", "t1")
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": ["t1"],
            "enabled": True
        })
        data = res.get_json()
        self.assertEqual(data["summary"]["ok"], 1)
        self.assertEqual(self._read(valid_path)["premiumPriority"], True)

    def test_finds_task_in_another_lanes_drafting_dir(self):
        """Tasks in other lanes' drafting directories are found and processed."""
        valid_path = self._write("drafting/worker-1", "t1")
        res = self.client.post("/api/tasks/premium-priority", json={
            "ids": ["t1"],
            "enabled": True
        })
        data = res.get_json()
        self.assertEqual(data["summary"]["ok"], 1)
        self.assertEqual(self._read(valid_path)["premiumPriority"], True)


if __name__ == "__main__":
    unittest.main()
