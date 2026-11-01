"""POST /api/hub/<hubRecordId>/pieces: adding a follow-up piece to a coordinating hub (2026-10-31, HUB0295-05).

Real Flask app, real queue files in a temp dir, and the real src/hub-add-piece.js run as the route's subprocess. The behaviour that matters: after a
piece is added the hub is NOT ready to merge until that piece is built (`_summarize_hub` reads the same `subTasks` list).

Run: .venv/bin/python -m unittest python.dashboard.test_hub_add_piece_route -v
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

BRANCH = "agent/decompose-adhoc-big-task-111"


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


class HubAddPieceRoute(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.pipeline = Path(self.tmp.name)
        self.q = self.pipeline / "queue"
        subs = []
        for i in (1, 2, 3):
            cid = f"HUB0900-0{i}-piece-{i}"
            rec = {"id": cid, "domain": "adhoc", "source": "manual", "title": f"HUB0900 · {i}/3 · piece {i}",
                   "promptContext": {"rawText": f"piece {i}", "decomposedFrom": "adhoc-big-task-111"},
                   "stacked": {"branch": BRANCH, "seq": i, "total": 3}}
            write(self.q / "done" / f"{cid}.json", rec)
            subs.append({"id": cid, "title": rec["title"], "status": "pending-merge", "phase": "built"})
        self.hub = {"id": "adhoc-big-task-111", "title": "Big task", "hubLabel": "HUB0900", "source": "manual", "domain": "adhoc",
                    "subTasks": subs, "history": [], "premiumPriority": True}
        write(self.q / "coordinating" / "adhoc-big-task-111.json", self.hub)
        self.client = app.app.test_client()
        for p in (mock.patch.object(app, "queue_dir", return_value=self.q),
                  mock.patch.object(app, "get_active_repo_root", return_value="/repo")):
            p.start()
            self.addCleanup(p.stop)

    def post(self, body, hub="adhoc-big-task-111"):
        return self.client.post(f"/api/hub/{hub}/pieces", json=body)

    def hub_now(self):
        return json.loads((self.q / "coordinating" / "adhoc-big-task-111.json").read_text())

    def test_a_hub_with_every_piece_built_is_ready_until_a_piece_is_added(self):
        before = app._summarize_hub(self.hub_now(), "coordinating")
        self.assertTrue(before["readyToMerge"])
        r = self.post({"title": "Gate the pool sweep", "rawText": "Do the gate.", "reason": "corrective"})
        self.assertEqual(r.status_code, 200, r.get_json())
        body = r.get_json()
        self.assertEqual((body["ok"], body["total"]), (True, 4))
        after = app._summarize_hub(self.hub_now(), "coordinating")
        self.assertFalse(after["readyToMerge"], "the hub must wait for the added piece")
        self.assertEqual(after["progress"]["total"], 4)
        self.assertEqual(after["subTasks"][-1]["phase"], "open")

    def test_the_piece_is_a_real_stacked_child_on_the_hubs_chain(self):
        r = self.post({"title": "Gate the pool sweep", "rawText": "Do the gate.", "files": ["src/a.js"]})
        child = json.loads((self.q / "adhoc" / f"{r.get_json()['id']}.json").read_text())
        self.assertEqual(child["stacked"], {"branch": BRANCH, "seq": 4, "total": 4})
        self.assertEqual(child["dependsOn"], ["HUB0900-03-piece-3"])
        self.assertTrue(child["premiumPriority"])
        self.assertIn("Files: src/a.js", child["promptContext"]["rawText"])
        self.assertEqual(child["promptContext"]["decomposedFrom"], "adhoc-big-task-111")

    def test_adopt_attaches_an_existing_child(self):
        write(self.q / "adhoc" / "HUB0900-04-hand-filed.json", {
            "id": "HUB0900-04-hand-filed", "title": "hand filed", "promptContext": {"rawText": "x", "decomposedFrom": "adhoc-big-task-111"},
            "stacked": {"branch": BRANCH, "seq": 4, "total": 4}})
        r = self.post({"adopt": "HUB0900-04-hand-filed", "reason": "was filed before this route existed"})
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertTrue(r.get_json()["adopted"])
        self.assertEqual(self.hub_now()["subTasks"][-1]["id"], "HUB0900-04-hand-filed")
        self.assertFalse(app._summarize_hub(self.hub_now(), "coordinating")["readyToMerge"])

    def test_an_unknown_hub_is_404(self):
        r = self.post({"title": "t", "rawText": "r"}, hub="no-such-hub")
        self.assertEqual(r.status_code, 404)
        self.assertFalse(r.get_json()["ok"])

    def test_bad_bodies_are_400_and_change_nothing(self):
        self.assertEqual(self.client.post("/api/hub/adhoc-big-task-111/pieces", data="nope", content_type="application/json").status_code, 400)
        self.assertEqual(self.post({"title": "only a title"}).status_code, 400)
        self.assertEqual(self.post({"adopt": "  "}).status_code, 400)
        self.assertEqual(len(self.hub_now()["subTasks"]), 3)

    def test_a_refusal_is_409(self):
        hub = self.hub_now()
        hub["mode"] = "file-decompose"
        write(self.q / "coordinating" / "adhoc-big-task-111.json", hub)
        r = self.post({"title": "t", "rawText": "r"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("file-decompose", r.get_json()["error"])

    def test_the_kill_switch_is_409(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_HUB_ADD_PIECE": "false"}):
            r = self.post({"title": "t", "rawText": "r"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("switched off", r.get_json()["error"])
        self.assertEqual(len(self.hub_now()["subTasks"]), 3)


if __name__ == "__main__":
    unittest.main()
