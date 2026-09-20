"""The Workers tab shows which HUB#### a task belongs to (2026-09-20: "I don't see the HUB name when looking at the workers queue").

_hub_info_for_task resolves a task to {label, seq, total, isHub} through the hub it was decomposed from -- by the hub's id or any of its
formerIds (a renamed hub) -- or from a HUB#### already leading the task's id/title.

Run: .venv/bin/python -m unittest python.dashboard.test_hub_info -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


def write(qdir, sub, rec):
    d = qdir / sub
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{rec['id']}.json").write_text(json.dumps(rec))


class TestHubInfo(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.q = Path(self.tmp.name) / "queue"
        write(self.q, "coordinating", {
            "id": "HUB0002", "hubLabel": "HUB0002", "formerIds": ["old-hub-id"],
            "subTasks": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
        })
        write(self.q, "coordinating", {"id": "plain-hub-without-label", "subTasks": [{"id": "z"}]})
        self.idx = app._hub_label_index(self.q)

    def tearDown(self):
        self.tmp.cleanup()

    def info(self, task_id, task):
        return app._hub_info_for_task(task_id, task=task, index=self.idx, qdir=self.q)

    def test_index_covers_current_and_former_ids_and_skips_unlabelled_hubs(self):
        self.assertEqual(set(self.idx), {"HUB0002", "old-hub-id"})

    def test_member_reports_its_slot_whichever_id_its_decomposedFrom_still_holds(self):
        for ref in ("HUB0002", "old-hub-id"):  # renamed hub, member not yet healed
            got = self.info("b", {"promptContext": {"decomposedFrom": ref}})
            self.assertEqual(got, {"label": "HUB0002", "seq": 2, "total": 3, "isHub": False}, ref)

    def test_the_hub_itself_and_an_unlisted_member(self):
        self.assertEqual(self.info("HUB0002", {}), {"label": "HUB0002", "seq": None, "total": None, "isHub": True})
        got = self.info("not-listed", {"promptContext": {"decomposedFrom": "HUB0002"}})
        self.assertEqual((got["label"], got["seq"], got["total"]), ("HUB0002", None, 3))

    def test_a_task_already_named_for_its_hub_reports_the_label_even_with_no_live_hub(self):
        self.assertEqual(self.info("HUB0009-01-x", {})["label"], "HUB0009")
        self.assertEqual(self.info("plain", {"title": "HUB0009 · 2/4 · x"})["label"], "HUB0009")

    def test_an_ordinary_task_or_an_unlabelled_hub_has_no_hub(self):
        self.assertIsNone(self.info("plain", {"title": "just a task", "promptContext": {}}))
        self.assertIsNone(self.info("z", {"promptContext": {"decomposedFrom": "plain-hub-without-label"}}))

    def test_resolves_the_task_record_itself_when_only_an_id_is_given(self):
        write(self.q, "drafting/worker-3090", {"id": "c", "promptContext": {"decomposedFrom": "old-hub-id"}})
        got = app._hub_info_for_task("c", index=self.idx, qdir=self.q)
        self.assertEqual((got["label"], got["seq"]), ("HUB0002", 3))


if __name__ == "__main__":
    unittest.main()
