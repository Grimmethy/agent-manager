"""Premium-priority fields must survive every stage transition helper.

Sets premium on a task through POST /api/task-anywhere/<id>/premium-priority, runs the
requeue / resolve / answer routes, and asserts premiumPriority, premiumSetBy and
premiumSetAt are unchanged in the file the task lands in. Includes a threaded test.

Run: python -m pytest python/tests/test_premium_survival.py -q
"""
import json
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent / "dashboard"))

import app  # noqa: E402

FIELDS = ("premiumPriority", "premiumSetBy", "premiumSetAt")


class PremiumSurvivalBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.queue = Path(self._tmp.name) / "queue"
        for d in ["pending", "blocked", "needs-clarification", "adhoc"]:
            (self.queue / d).mkdir(parents=True)
        self._patches = [
            mock.patch.object(app, "queue_dir", return_value=self.queue),
            mock.patch.object(app, "_record_manual_requeue"),
        ]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _write(self, state_dir, task_id, extra=None):
        task = {"id": task_id, "domain": "adhoc", "source": "manual", "title": "t",
                "promptContext": {"rawText": "do it"}, "history": []}
        task.update(extra or {})
        p = self.queue / state_dir / f"{task_id}.json"
        p.write_text(json.dumps(task, indent=2), encoding="utf-8")
        return p

    @staticmethod
    def _triple(path):
        data = json.loads(path.read_text(encoding="utf-8"))
        return tuple(data.get(f) for f in FIELDS)

    def _set_premium(self, client, task_id, path):
        res = client.post(f"/api/task-anywhere/{task_id}/premium-priority",
                          json={"enabled": True, "by": "operator-ui"})
        self.assertEqual(res.status_code, 200)
        triple = self._triple(path)
        self.assertIs(triple[0], True)
        self.assertEqual(triple[1], "operator-ui")
        self.assertTrue(triple[2])
        return triple

    def _transition(self, client, kind, task_id):
        """Set premium via the route, run one transition, return (before, after)."""
        if kind == "requeue":
            src = self._write("blocked", task_id, {"domain": "other", "source": "generated", "status": "blocked"})
            url, body, dest = f"/api/task/blocked/{task_id}/requeue", {"force": True}, "pending"
        elif kind == "resolve":
            src = self._write("needs-clarification", task_id)
            url, body, dest = f"/api/task/needs-clarification/{task_id}/resolve", {"paths": ["src/a.js"]}, "adhoc"
        else:
            src = self._write("needs-clarification", task_id)
            url, body, dest = f"/api/task/needs-clarification/{task_id}/answer", {"answer": "go with option A"}, "adhoc"
        before = self._set_premium(client, task_id, src)
        res = client.post(url, json=body)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        out = self.queue / dest / f"{task_id}.json"
        self.assertTrue(out.is_file())
        self.assertFalse(src.exists())
        return before, self._triple(out)


class TestPremiumSurvivesTransitions(PremiumSurvivalBase):
    def test_requeue_preserves_premium(self):
        before, after = self._transition(self.client, "requeue", "t-requeue")
        self.assertEqual(before, after)

    def test_resolve_preserves_premium(self):
        before, after = self._transition(self.client, "resolve", "t-resolve")
        self.assertEqual(before, after)

    def test_answer_preserves_premium(self):
        before, after = self._transition(self.client, "answer", "t-answer")
        self.assertEqual(before, after)


class TestPremiumSurvivesConcurrentTransitions(PremiumSurvivalBase):
    def test_threads_each_keep_their_own_premium(self):
        kinds = ["requeue", "resolve", "answer"] * 2
        barrier = threading.Barrier(len(kinds))
        errors = []
        results = {}

        def worker(i, kind):
            try:
                client = app.app.test_client()
                barrier.wait(timeout=10)
                results[i] = self._transition(client, kind, f"t-thread-{i}")
            except BaseException as e:  # noqa: BLE001 -- collected and asserted below
                errors.append(f"{kind}#{i}: {e!r}")

        threads = [threading.Thread(target=worker, args=(i, k)) for i, k in enumerate(kinds)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=20)
        self.assertFalse(any(t.is_alive() for t in threads))
        self.assertEqual(errors, [])
        self.assertEqual(len(results), len(kinds))
        for i, (before, after) in results.items():
            self.assertEqual(before, after, f"thread {i}")


if __name__ == "__main__":
    unittest.main()
