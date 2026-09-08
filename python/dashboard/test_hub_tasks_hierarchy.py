"""Tests for the Hub Tasks tab's family-tree ordering (2026-09-08, Grimmethy: "child hubs
that are children of a parent hub task should be sorted beneath their parent in the order
that they occur in the hierarchy, child hubs should have a very small indent").

Covers GET /api/queue/coordinating: given hub records carrying `parentHub` (stamped by
src/decompose-loop-autoroute.js / src/apply-task.js's recordApplyOutcome when one hub
spawns another), each child must appear immediately after its parent in the response, with
a correct `hubDepth`, and pagination (limit/offset) must still slice the flattened,
ordered list correctly. Does not cover the JS writers that populate `parentHub` itself --
see src/decompose-loop-autoroute.test.js and src/file-decompose-to-hub.test.js.

Run: .venv/bin/python -m unittest python.dashboard.test_hub_tasks_hierarchy -v
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class HubTasksHierarchyTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self.queue = root / "queue"
        (self.queue / "coordinating").mkdir(parents=True)
        self._patches = [mock.patch.object(app, "queue_dir", return_value=self.queue)]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _write_hub(self, hub_id, created_at, parent_hub=None, source="manual"):
        hub = {
            "id": hub_id, "domain": "adhoc", "source": source, "status": "coordinating",
            "title": hub_id, "createdAt": created_at, "subTasks": [], "progress": {"done": 0, "total": 0},
            "history": [],
        }
        if parent_hub:
            hub["parentHub"] = parent_hub
        (self.queue / "coordinating" / f"{hub_id}.json").write_text(json.dumps(hub, indent=2), encoding="utf-8")

    def _ids(self, items):
        return [i["id"] for i in items]


class TestHubFamilyOrder(HubTasksHierarchyTestBase):
    def test_child_immediately_follows_its_parent_with_correct_depth(self):
        self._write_hub("hub-root", "2026-09-08T00:00:00Z")
        self._write_hub("hub-child", "2026-09-08T01:00:00Z", parent_hub="hub-root")

        res = self.client.get("/api/queue/coordinating")
        body = res.get_json()
        self.assertEqual(body["total"], 2)
        self.assertEqual(self._ids(body["items"]), ["hub-root", "hub-child"])
        self.assertEqual(body["items"][0]["hubDepth"], 0)
        self.assertEqual(body["items"][1]["hubDepth"], 1)

    def test_grandchild_nests_two_deep_beneath_root_and_child(self):
        self._write_hub("hub-root", "2026-09-08T00:00:00Z")
        self._write_hub("hub-child", "2026-09-08T01:00:00Z", parent_hub="hub-root")
        self._write_hub("hub-grandchild", "2026-09-08T02:00:00Z", parent_hub="hub-child")

        res = self.client.get("/api/queue/coordinating")
        body = res.get_json()
        self.assertEqual(self._ids(body["items"]), ["hub-root", "hub-child", "hub-grandchild"])
        self.assertEqual([i["hubDepth"] for i in body["items"]], [0, 1, 2])

    def test_multiple_families_stay_separate_and_do_not_interleave(self):
        self._write_hub("hub-a", "2026-09-08T03:00:00Z")
        self._write_hub("hub-a-child", "2026-09-08T04:00:00Z", parent_hub="hub-a")
        self._write_hub("hub-b", "2026-09-08T02:00:00Z")
        self._write_hub("hub-b-child", "2026-09-08T05:00:00Z", parent_hub="hub-b")

        res = self.client.get("/api/queue/coordinating")
        ids = self._ids(res.get_json()["items"])
        self.assertLess(ids.index("hub-a-child") - ids.index("hub-a"), 2)
        self.assertLess(ids.index("hub-b-child") - ids.index("hub-b"), 2)
        self.assertEqual(ids.index("hub-a-child"), ids.index("hub-a") + 1)
        self.assertEqual(ids.index("hub-b-child"), ids.index("hub-b") + 1)

    def test_a_hub_with_no_parentHub_field_is_a_root_with_depth_zero(self):
        self._write_hub("hub-solo", "2026-09-08T00:00:00Z")
        body = self.client.get("/api/queue/coordinating").get_json()
        self.assertEqual(body["items"][0]["hubDepth"], 0)

    def test_a_dangling_parentHub_pointing_at_a_hub_not_currently_in_coordinating_falls_back_to_root(self):
        # The referenced parent already resolved and moved on (merged/done) -- must not
        # disappear from the tab, just render as a root instead.
        self._write_hub("hub-orphan", "2026-09-08T00:00:00Z", parent_hub="hub-long-gone")
        body = self.client.get("/api/queue/coordinating").get_json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["items"][0]["hubDepth"], 0)

    def test_pagination_slices_the_flattened_hierarchy_order(self):
        self._write_hub("hub-root", "2026-09-08T00:00:00Z")
        self._write_hub("hub-child", "2026-09-08T01:00:00Z", parent_hub="hub-root")
        self._write_hub("hub-other", "2026-09-08T02:00:00Z")

        page1 = self.client.get("/api/queue/coordinating?limit=1&offset=0").get_json()
        page2 = self.client.get("/api/queue/coordinating?limit=1&offset=1").get_json()
        self.assertEqual(page1["total"], 3)
        self.assertEqual(self._ids(page1["items"]), ["hub-other"])
        self.assertEqual(self._ids(page2["items"]), ["hub-root"])

    def test_source_filter_still_applies_before_hierarchy_ordering(self):
        self._write_hub("hub-root", "2026-09-08T00:00:00Z", source="manual")
        self._write_hub("hub-child", "2026-09-08T01:00:00Z", parent_hub="hub-root", source="observability_review")

        body = self.client.get("/api/queue/coordinating?source=manual").get_json()
        self.assertEqual(self._ids(body["items"]), ["hub-root"])


if __name__ == "__main__":
    unittest.main()
