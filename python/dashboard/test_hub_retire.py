"""POST /api/hub/<id>/retire retires a whole coordinating hub as abandoned (2026-09-20, PF HUB0006).

/api/task/<state>/<id>/archive can't touch a coordinating hub or a child still in queue/adhoc/, and archiving only one child would unblock its
siblings (an 'abandoned' record counts as a satisfied dependency). The hub goes as a unit, all-or-nothing: an in-flight child, a nested hub or an
existing archived copy refuses with nothing changed.

Run: .venv/bin/python -m unittest python.dashboard.test_hub_retire -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TestHubRetire(unittest.TestCase):
    def setUp(self):
        self.q = Path(tempfile.mkdtemp()) / "queue"
        self.client = app.app.test_client()
        p = mock.patch.object(app, "queue_dir", return_value=self.q)
        p.start()
        self.addCleanup(p.stop)

    def put(self, state, task_id, sub=None, **extra):
        d = self.q / state / sub if sub else self.q / state
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{task_id}.json").write_text(json.dumps({"id": task_id, "history": [{"stage": "created", "at": "x"}], **extra}))

    def hub(self, children, hub_id="hub-1"):
        self.put("coordinating", hub_id, subTasks=[{"id": c} for c in children])
        return hub_id

    def archived(self, task_id):
        return json.loads((self.q / "done" / "_archived_no_action" / f"{task_id}.json").read_text())

    def test_retires_hub_and_every_unfinished_child_wherever_it_sits_including_adhoc(self):
        self.put("needs-clarification", "c1", dependsOn=[])
        self.put("adhoc", "c2", dependsOn=["c1"])
        self.put("adhoc", "c3", dependsOn=["c2"])
        hub = self.hub(["c1", "c2", "c3"])
        r = self.client.post(f"/api/hub/{hub}/retire", json={"reason": "phantom duplicate of the chain"})
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["hub"], hub)
        self.assertEqual(sorted(body["archived"]), ["c1", "c2", "c3"])
        for cid, origin in (("c1", "needs-clarification"), ("c2", "adhoc"), ("c3", "adhoc"), (hub, "coordinating")):
            rec = self.archived(cid)
            self.assertEqual(rec["terminalDisposition"], "abandoned", cid)
            self.assertEqual(rec["manualArchive"]["from"], origin, cid)
            self.assertEqual(rec["manualArchive"]["reason"], "phantom duplicate of the chain")
            self.assertEqual(rec["history"][-1]["stage"], "abandoned")
        self.assertEqual(self.archived("c2")["manualArchive"]["retiredWithHub"], hub)
        self.assertFalse((self.q / "adhoc" / "c2.json").exists())
        self.assertFalse((self.q / "coordinating" / f"{hub}.json").exists())

    def test_finished_children_and_missing_records_are_left_alone_and_reported(self):
        self.put("done", "d1", terminalDisposition="pending-merge")
        self.put("adhoc", "c2")
        hub = self.hub(["d1", "c2", "ghost"])
        body = self.client.post(f"/api/hub/{hub}/retire").get_json()
        self.assertEqual(body["archived"], ["c2"])
        self.assertEqual(body["left"], {"d1": "already finished or archived", "ghost": "record not found"})
        self.assertTrue((self.q / "done" / "d1.json").exists(), "a finished child (its branch may hold real work) is not touched")

    def test_refuses_all_or_nothing_when_a_child_is_in_flight(self):
        self.put("adhoc", "c1")
        self.put("drafting", "c2", sub="worker-3090")
        hub = self.hub(["c1", "c2"])
        r = self.client.post(f"/api/hub/{hub}/retire")
        self.assertEqual(r.status_code, 409)
        self.assertIn("c2 is in flight (drafting/)", r.get_data(as_text=True))
        self.assertTrue((self.q / "adhoc" / "c1.json").exists(), "nothing was moved")
        self.assertTrue((self.q / "coordinating" / f"{hub}.json").exists())
        self.assertFalse((self.q / "done" / "_archived_no_action").exists())

    def test_review_and_approved_children_are_in_flight_too(self):
        for state in ("review", "approved"):
            self.put(state, f"c-{state}")
            hub = self.hub([f"c-{state}"], hub_id=f"hub-{state}")
            self.assertEqual(self.client.post(f"/api/hub/{hub}/retire").status_code, 409, state)

    def test_refuses_a_nested_hub_child_and_an_existing_archived_copy(self):
        self.put("coordinating", "inner", subTasks=[])
        hub = self.hub(["inner"])
        r = self.client.post(f"/api/hub/{hub}/retire")
        self.assertEqual(r.status_code, 409)
        self.assertIn("inner is itself a coordinating hub", r.get_data(as_text=True))

        self.put("adhoc", "c9")
        hub2 = self.hub(["c9"], hub_id="hub-2")
        (self.q / "done" / "_archived_no_action").mkdir(parents=True, exist_ok=True)
        (self.q / "done" / "_archived_no_action" / "c9.json").write_text("{}")
        r = self.client.post(f"/api/hub/{hub2}/retire")
        self.assertEqual(r.status_code, 409)
        self.assertTrue((self.q / "adhoc" / "c9.json").exists())

    def test_unknown_hub_is_404_and_a_hub_with_no_unfinished_children_still_retires(self):
        self.assertEqual(self.client.post("/api/hub/nope/retire").status_code, 404)
        hub = self.hub([])
        body = self.client.post(f"/api/hub/{hub}/retire").get_json()
        self.assertEqual(body["archived"], [])
        self.assertEqual(self.archived(hub)["terminalDisposition"], "abandoned")


if __name__ == "__main__":
    unittest.main()
