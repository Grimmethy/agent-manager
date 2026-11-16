"""POST /api/hub/<ref>/retire with the cascade flag (HUB0478 3/5).

Covers: cascade archives innermost first, the protected nested-clean case, the blocked nested case (refused event +
counter, nothing archived), the default and explicit-false 409, label resolution, ambiguity 409, not-found 404 and a
non-boolean cascade 400.

Run: .venv/bin/python -m unittest discover -s python/dashboard/tests -p test_retire_cascade_route.py -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

DASHBOARD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DASHBOARD))

import app  # noqa: E402
import hub_retire_cascade  # noqa: E402


class TestRetireCascadeRoute(unittest.TestCase):
    def setUp(self):
        self.q = Path(tempfile.mkdtemp()) / "queue"
        self.client = app.app.test_client()
        p = mock.patch.object(app, "queue_dir", return_value=self.q)
        p.start()
        self.addCleanup(p.stop)

    def put(self, state, rid, **extra):
        d = self.q / state
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{rid}.json").write_text(json.dumps({"id": rid, "history": [], **extra}))

    def exists(self, state, rid):
        return (self.q / state / f"{rid}.json").is_file()

    def archived(self, rid):
        return json.loads((self.q / "done" / "_archived_no_action" / f"{rid}.json").read_text())

    def refusals(self):
        return hub_retire_cascade.COUNTERS["hub_retire_refusals"]

    def clean_nested(self):
        # root (HUB0001) -> inner (HUB0002) -> c1 (adhoc)
        self.put("adhoc", "c1")
        self.put("coordinating", "inner", hubLabel="HUB0002", subTasks=[{"id": "c1"}])
        self.put("coordinating", "root", hubLabel="HUB0001", subTasks=[{"id": "inner"}])

    def test_cascade_clean_nested_archives_innermost_first(self):
        self.clean_nested()
        r = self.client.post("/api/hub/root/retire", json={"cascade": True})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        body = r.get_json()
        self.assertEqual(body["cascadeRoot"], "root")
        self.assertEqual([a["id"] for a in body["archived"]], ["c1", "inner", "root"])
        self.assertEqual(body["archived"][1]["label"], "HUB0002")
        self.assertEqual(body["archived"][2]["label"], "HUB0001")
        self.assertFalse(self.exists("adhoc", "c1"))
        self.assertFalse(self.exists("coordinating", "root"))

    def test_cascade_by_label_resolves_to_record_id(self):
        self.clean_nested()
        r = self.client.post("/api/hub/HUB0001/retire", json={"cascade": True})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(r.get_json()["cascadeRoot"], "root")

    def test_default_nested_hub_keeps_existing_409_and_archives_nothing(self):
        self.clean_nested()
        for body in (None, {}, {"cascade": False}):
            r = self.client.post("/api/hub/root/retire", json=body)
            self.assertEqual(r.status_code, 409, body)
            self.assertIn("not retired, nothing changed: ", r.get_data(as_text=True))
            self.assertIn("inner is itself a coordinating hub -- retire it first", r.get_data(as_text=True))
        self.assertTrue(self.exists("adhoc", "c1"))
        self.assertTrue(self.exists("coordinating", "inner"))
        self.assertTrue(self.exists("coordinating", "root"))

    def test_cascade_blocked_nested_child_refuses_and_archives_nothing(self):
        self.put("review", "c1")
        self.put("coordinating", "inner", hubLabel="HUB0002", subTasks=[{"id": "c1"}])
        self.put("coordinating", "root", hubLabel="HUB0001", subTasks=[{"id": "inner"}])
        before = self.refusals()
        r = self.client.post("/api/hub/root/retire", json={"cascade": True, "reason": "test"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("c1 is in flight (review)", r.get_data(as_text=True))
        self.assertTrue(self.exists("review", "c1"))
        self.assertTrue(self.exists("coordinating", "inner"))
        self.assertTrue(self.exists("coordinating", "root"))
        self.assertEqual(self.refusals(), before + 1)
        events = [e for e in self.rec_json("coordinating", "root")["history"] if e.get("type") == "refused"]
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["blockers"])
        self.assertEqual(events[0]["cascadeRoot"], "root")

    def rec_json(self, state, rid):
        return json.loads((self.q / state / f"{rid}.json").read_text())

    def test_non_boolean_cascade_is_400(self):
        self.clean_nested()
        r = self.client.post("/api/hub/root/retire", json={"cascade": "yes"})
        self.assertEqual(r.status_code, 400)
        self.assertTrue(self.exists("coordinating", "root"))

    def test_ambiguous_label_is_409_with_candidates(self):
        self.put("coordinating", "a1", hubLabel="HUB0009", subTasks=[])
        self.put("coordinating", "a2", hubLabel="HUB0009", subTasks=[])
        r = self.client.post("/api/hub/HUB0009/retire", json={"cascade": True})
        self.assertEqual(r.status_code, 409)
        body = r.get_json()
        self.assertEqual(sorted(c["id"] for c in body["candidates"]), ["a1", "a2"])
        self.assertNotIn("not retired", r.get_data(as_text=True))

    def test_unknown_reference_is_404(self):
        r = self.client.post("/api/hub/nope/retire", json={"cascade": True})
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
