"""Tests for the Hub Tasks tab's family-tree ordering (2026-09-08, Grimmethy: "child hubs
that are children of a parent hub task should be sorted beneath their parent in the order
that they occur in the hierarchy, child hubs should have a very small indent" + "a top hub
level label ... to show the name of the entire family of hubs").

Covers GET /api/queue/coordinating: given hub records carrying `parentHub` (stamped by
src/decompose-loop-autoroute.js / src/apply-task.js's recordApplyOutcome when one hub
spawns another) OR a hub id sitting in another hub's `subTasks[]` (rewireCoordinatorParent,
predates `parentHub` -- real families already live in the data this way), each child must
appear immediately after its parent in the response, with a correct `hubDepth` and
`hubFamily` (the topmost hub's own title, carried onto every descendant), and pagination
(limit/offset) must still slice the flattened, ordered list correctly. Does not cover the
JS writers that populate `parentHub` itself -- see src/decompose-loop-autoroute.test.js and
src/file-decompose-to-hub.test.js.

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

    def _write_hub(self, hub_id, created_at, parent_hub=None, source="manual", sub_tasks=None, title=None):
        hub = {
            "id": hub_id, "domain": "adhoc", "source": source, "status": "coordinating",
            "title": title or hub_id, "createdAt": created_at,
            "subTasks": sub_tasks if sub_tasks is not None else [], "progress": {"done": 0, "total": 0},
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


class TestDerivedParentFromSubTasks(HubTasksHierarchyTestBase):
    """rewireCoordinatorParent() (src/decompose-loop-autoroute.js) has been rewriting a
    parent hub's subTasks[] entry to point at a rescuing hub since before `parentHub`
    existed -- real, already-live families must be recognized with zero backfill."""

    def test_a_hub_id_in_another_hubs_subTasks_is_treated_as_a_real_parent_link(self):
        self._write_hub("hub-root", "2026-09-08T00:00:00Z",
                         sub_tasks=[{"id": "hub-child", "title": "re-decomposed", "status": "in-progress"}])
        self._write_hub("hub-child", "2026-09-08T01:00:00Z")  # no parentHub field at all

        body = self.client.get("/api/queue/coordinating").get_json()
        self.assertEqual(self._ids(body["items"]), ["hub-root", "hub-child"])
        self.assertEqual(body["items"][1]["hubDepth"], 1)

    def test_a_three_generation_chain_via_subTasks_nests_correctly(self):
        # Mirrors a real chain found live 2026-09-08: root -> child hub -> grandchild hub,
        # each link expressed only via subTasks[], no parentHub field anywhere.
        self._write_hub("hub-root", "2026-09-08T00:00:00Z",
                         sub_tasks=[{"id": "hub-child", "title": "x", "status": "in-progress"}])
        self._write_hub("hub-child", "2026-09-08T01:00:00Z",
                         sub_tasks=[{"id": "hub-grandchild", "title": "y", "status": "in-progress"}])
        self._write_hub("hub-grandchild", "2026-09-08T02:00:00Z")

        body = self.client.get("/api/queue/coordinating").get_json()
        self.assertEqual(self._ids(body["items"]), ["hub-root", "hub-child", "hub-grandchild"])
        self.assertEqual([i["hubDepth"] for i in body["items"]], [0, 1, 2])

    def test_explicit_parentHub_wins_over_a_conflicting_subTasks_reference(self):
        self._write_hub("hub-a", "2026-09-08T00:00:00Z",
                         sub_tasks=[{"id": "hub-child", "title": "x", "status": "in-progress"}])
        self._write_hub("hub-b", "2026-09-08T00:00:01Z")
        self._write_hub("hub-child", "2026-09-08T01:00:00Z", parent_hub="hub-b")

        body = self.client.get("/api/queue/coordinating").get_json()
        ids = self._ids(body["items"])
        self.assertEqual(ids.index("hub-child"), ids.index("hub-b") + 1)

    def test_a_plain_non_hub_id_in_subTasks_is_not_mistaken_for_a_parent_link(self):
        self._write_hub("hub-root", "2026-09-08T00:00:00Z",
                         sub_tasks=[{"id": "adhoc-move-file-1", "title": "move a file", "status": "pending"}])
        body = self.client.get("/api/queue/coordinating").get_json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["items"][0]["hubDepth"], 0)


class TestHubFamilyLabel(HubTasksHierarchyTestBase):
    def test_root_and_its_children_all_carry_the_roots_own_title_as_hubFamily(self):
        self._write_hub("hub-root", "2026-09-08T00:00:00Z", title="Decompose app.py")
        self._write_hub("hub-child", "2026-09-08T01:00:00Z", parent_hub="hub-root", title="Rescue oversized index.html")
        self._write_hub("hub-grandchild", "2026-09-08T02:00:00Z", parent_hub="hub-child", title="Rescue oversized core-ui.js")

        body = self.client.get("/api/queue/coordinating").get_json()
        self.assertEqual([i["hubFamily"] for i in body["items"]], ["Decompose app.py"] * 3)

    def test_two_families_carry_distinct_hubFamily_labels(self):
        self._write_hub("hub-a", "2026-09-08T00:00:00Z", title="Family A")
        self._write_hub("hub-a-child", "2026-09-08T01:00:00Z", parent_hub="hub-a", title="A's child")
        self._write_hub("hub-b", "2026-09-08T00:00:01Z", title="Family B")

        body = self.client.get("/api/queue/coordinating").get_json()
        by_id = {i["id"]: i["hubFamily"] for i in body["items"]}
        self.assertEqual(by_id["hub-a"], "Family A")
        self.assertEqual(by_id["hub-a-child"], "Family A")
        self.assertEqual(by_id["hub-b"], "Family B")

    def test_hubFamily_still_present_on_a_page_that_starts_mid_family(self):
        # A paginated request landing on just the child must still know which family it
        # belongs to, even though the root itself isn't on this page.
        self._write_hub("hub-root", "2026-09-08T00:00:00Z", title="The Family")
        self._write_hub("hub-child", "2026-09-08T01:00:00Z", parent_hub="hub-root", title="child")

        page2 = self.client.get("/api/queue/coordinating?limit=1&offset=1").get_json()
        self.assertEqual(self._ids(page2["items"]), ["hub-child"])
        self.assertEqual(page2["items"][0]["hubFamily"], "The Family")


if __name__ == "__main__":
    unittest.main()
