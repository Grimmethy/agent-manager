"""POST /api/hub/<id>/waive-abandoned sets abandonedPiecesWaived on a coordinating hub (2026-11-05).

_summarize_hub (app_branch_helpers.py) reads `abandonedPiecesWaived is True` as the owner's "merge it anyway" for a hub with an abandoned piece; no route
set it. This route does, with a required reason, and refuses a hub that has nothing to waive.

Run: .venv/bin/python -m unittest python.dashboard.test_hub_waive_abandoned -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import app_branch_helpers  # noqa: E402


class TestHubWaiveAbandoned(unittest.TestCase):
    def setUp(self):
        self.q = Path(tempfile.mkdtemp()) / "queue"
        self.client = app.app.test_client()
        p = mock.patch.object(app, "queue_dir", return_value=self.q)
        p.start()
        self.addCleanup(p.stop)

    def hub(self, statuses, hub_id="hub-1", **extra):
        d = self.q / "coordinating"
        d.mkdir(parents=True, exist_ok=True)
        subs = [{"id": f"p{i}", "status": s} for i, s in enumerate(statuses, 1)]
        (d / f"{hub_id}.json").write_text(json.dumps({"id": hub_id, "subTasks": subs, "history": [], **extra}))
        return hub_id

    def record(self, hub_id="hub-1"):
        return json.loads((self.q / "coordinating" / f"{hub_id}.json").read_text())

    def test_sets_the_flag_records_the_reason_and_lists_the_abandoned_pieces(self):
        hub = self.hub(["pending-merge", "abandoned", "abandoned"])
        r = self.client.post(f"/api/hub/{hub}/waive-abandoned", json={"reason": "p2 replaced by a new piece"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json(), {"hub": hub, "waived": True, "abandoned": ["p2", "p3"]})
        rec = self.record(hub)
        self.assertIs(rec["abandonedPiecesWaived"], True)
        self.assertEqual(rec["history"][-1]["stage"], "abandoned-pieces-waived")
        self.assertIn("p2 replaced by a new piece", rec["history"][-1]["detail"])

    def test_the_summary_reads_the_flag_so_a_waived_hub_with_every_piece_built_is_ready_to_merge(self):
        hub = self.hub(["pending-merge", "abandoned"])
        before = app_branch_helpers._summarize_hub(self.record(hub), "coordinating")
        self.client.post(f"/api/hub/{hub}/waive-abandoned", json={"reason": "covered"})
        after = app_branch_helpers._summarize_hub(self.record(hub), "coordinating")
        self.assertEqual([before["readyToMerge"], after["readyToMerge"]], [False, True])

    def test_waiving_twice_is_idempotent_and_adds_no_second_history_entry(self):
        hub = self.hub(["abandoned"])
        self.client.post(f"/api/hub/{hub}/waive-abandoned", json={"reason": "x"})
        r = self.client.post(f"/api/hub/{hub}/waive-abandoned", json={"reason": "y"})
        self.assertEqual(r.status_code, 200)
        self.assertIs(r.get_json()["alreadyWaived"], True)
        self.assertEqual(len(self.record(hub)["history"]), 1)

    def test_refuses_without_a_reason_without_an_abandoned_piece_and_for_a_missing_hub(self):
        hub = self.hub(["pending-merge", "pending-merge"], hub_id="clean")
        self.assertEqual(self.client.post(f"/api/hub/{hub}/waive-abandoned", json={"reason": "x"}).status_code, 409)
        self.assertNotIn("abandonedPiecesWaived", self.record(hub))
        other = self.hub(["abandoned"], hub_id="other")
        self.assertEqual(self.client.post(f"/api/hub/{other}/waive-abandoned", json={"reason": "  "}).status_code, 400)
        self.assertEqual(self.client.post(f"/api/hub/{other}/waive-abandoned", json={}).status_code, 400)
        self.assertNotIn("abandonedPiecesWaived", self.record(other))
        self.assertEqual(self.client.post("/api/hub/ghost/waive-abandoned", json={"reason": "x"}).status_code, 404)

    def test_the_400_409_and_404_refusals_leave_the_hub_file_byte_identical(self):
        clean = self.hub(["pending-merge"], hub_id="clean")
        other = self.hub(["abandoned"], hub_id="other")
        cases = [
            (f"/api/hub/{clean}/waive-abandoned", {"reason": "x"}, 409, clean),
            (f"/api/hub/{other}/waive-abandoned", {"reason": "  "}, 400, other),
            (f"/api/hub/{other}/waive-abandoned", {}, 400, other),
            ("/api/hub/ghost/waive-abandoned", {"reason": "x"}, 404, other),
        ]
        for url, body, status, hub in cases:
            path = self.q / "coordinating" / f"{hub}.json"
            before = path.read_bytes()
            r = self.client.post(url, json=body)
            self.assertEqual(r.status_code, status, url)
            self.assertEqual(path.read_bytes(), before, url)

    def test_a_write_error_is_a_500_and_the_hub_file_is_unchanged(self):
        hub = self.hub(["abandoned"], hub_id="broken")
        path = self.q / "coordinating" / f"{hub}.json"
        before = path.read_bytes()
        with mock.patch.object(Path, "write_text", side_effect=OSError("disk full")):
            r = self.client.post(f"/api/hub/{hub}/waive-abandoned", json={"reason": "x"})
        self.assertEqual(r.status_code, 500)
        self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
