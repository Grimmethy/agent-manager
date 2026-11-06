"""Unfinished hubs are held whatever their domain, an abandoned piece blocks readiness, and other projects' held hubs are reported.

2026-10-31 Needs-Work analysis: the quest-server hub (source manual, domain default, 2/5 built) and a change_review_fix hub (2/3 built) were listed as
mergeable because the hold only covered domain 'adhoc'; pf-admin-ui HUB0001 read ready with its wiring piece abandoned.

Run: .venv/bin/python -m unittest python.dashboard.test_hold_all_hubs -v
"""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from test_hub_sibling_conflict import make_repo_with_conflicting_siblings  # noqa: E402


def hub(source, domain, second_phase="open", second_status=None, **extra):
    subs = [
        {"id": "p-1", "status": "pending-merge", "phase": "built"},
        {"id": "p-2", "status": second_status or ("in-progress" if second_phase == "open" else "pending-merge"), "phase": second_phase},
    ]
    return app._summarize_hub({"id": "hub-x", "title": "HUB0901", "source": source, "domain": domain, "subTasks": subs, **extra}, "coordinating")


def partition(h):
    return app.partition_held_hub_branches([{"branch": "agent/p-1", "hub": h}])


class TestHoldWhateverTheDomain(unittest.TestCase):
    def test_held_while_not_ready(self):
        for source, domain in [("manual", "default"), ("manual", "adhoc"), ("derived_task", "default"), ("change_review_fix", "default")]:
            with self.subTest(source=source, domain=domain):
                listed, held = partition(hub(source, domain))
                self.assertEqual(listed, [])
                self.assertEqual(len(held), 1)
                self.assertEqual(held[0]["waitingOn"], ["p-2"])

    def test_listed_once_the_hub_is_ready(self):
        for source, domain in [("manual", "default"), ("change_review_fix", "default")]:
            with self.subTest(source=source):
                listed, held = partition(hub(source, domain, second_phase="built"))
                self.assertEqual(len(listed), 1)
                self.assertEqual(held, [])

    def test_independent_piece_hubs_stay_listed(self):
        for source in ("function_length_fix", "performance_fix", "arch_review"):
            with self.subTest(source=source):
                listed, held = partition(hub(source, "default"))
                self.assertEqual(len(listed), 1)
                self.assertEqual(held, [])

    def test_hub_owning_its_own_branch_is_listed(self):
        listed, _ = partition(hub("manual", "default", branch="agent/decompose-x"))
        self.assertEqual(len(listed), 1)

    def test_kill_switch_lists_everything(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_HOLD_UNFINISHED_HUB_CHILDREN": "false"}):
            listed, held = partition(hub("manual", "default"))
        self.assertEqual(len(listed), 1)
        self.assertEqual(held, [])


class TestAbandonedPieceBlocksReadiness(unittest.TestCase):
    def test_hub_with_an_abandoned_piece_is_not_ready(self):
        h = hub("manual", "adhoc", second_phase="merged", second_status="abandoned")
        self.assertFalse(h["readyToMerge"])
        self.assertEqual(h["abandonedPieces"], ["p-2"])

    def test_the_waiver_makes_it_ready(self):
        h = hub("manual", "adhoc", second_phase="merged", second_status="abandoned", abandonedPiecesWaived=True)
        self.assertTrue(h["readyToMerge"])

    def test_a_truthy_non_boolean_is_not_a_waiver(self):
        h = hub("manual", "adhoc", second_phase="merged", second_status="abandoned", abandonedPiecesWaived="yes")
        self.assertFalse(h["readyToMerge"])

    def test_without_abandoned_pieces_readiness_is_unchanged(self):
        h = hub("manual", "adhoc", second_phase="built")
        self.assertTrue(h["readyToMerge"])
        self.assertEqual(h["abandonedPieces"], [])

    def test_a_hub_that_shipped_is_still_ready(self):
        h = app._summarize_hub({"id": "h", "source": "manual", "domain": "adhoc",
                                "subTasks": [{"id": "a", "status": "abandoned", "phase": "merged"}]}, "done")
        self.assertTrue(h["readyToMerge"])

    def test_an_abandoned_piece_holds_the_built_sibling_out_of_the_listing(self):
        listed, held = partition(hub("manual", "adhoc", second_phase="merged", second_status="abandoned"))
        self.assertEqual(listed, [])
        self.assertEqual(len(held), 1)


class TestOtherProjectsHeldHubs(unittest.TestCase):
    OTHER = "/media/other/repo"

    def _projects(self, active_root):
        return [{"label": "act", "repoRoot": "/media/act", "active": True, "pipelineDir": "/p"},
                {"label": "other", "repoRoot": self.OTHER, "active": False, "pipelineDir": "/q"}]

    def test_listing_keeps_the_held_groups_of_a_foreign_project(self):
        group = {"hubId": "h", "waitingOn": ["h-2"], "branches": ["agent/h-1"], "title": "T", "progress": {}}
        with mock.patch.object(app, "list_unmerged_branches", return_value=[]), \
                mock.patch.dict(app._branch_cache, {"held": [], "held_other": {self.OTHER: [group]}}), \
                mock.patch("branch_projects.registered_projects", self._projects), \
                mock.patch.object(app, "get_active_repo_root", return_value="/media/act"):
            only_active = app.list_held_hub_groups()
            everything = app.list_held_hub_groups(include_other_projects=True)
        self.assertEqual(only_active, [])
        self.assertEqual(len(everything), 1)
        self.assertEqual(everything[0]["project"]["label"], "other")
        self.assertEqual(everything[0]["branches"], ["agent/h-1"])

    def test_route_passes_projects_all_through(self):
        with mock.patch.object(app, "list_held_hub_groups", return_value=[]) as lister:
            app.app.test_client().get("/api/git/held-hub-branches?projects=all")
            app.app.test_client().get("/api/git/held-hub-branches")
        self.assertEqual([c.kwargs for c in lister.call_args_list], [{"include_other_projects": True}, {"include_other_projects": False}])


class TestForeignProjectListingEndToEnd(unittest.TestCase):
    """A real repo scanned AS ANOTHER project (repo_root given): a domain-'default' manual hub with an open piece is held and its group is kept."""

    def setUp(self):
        app._invalidate_branch_cache()
        self._sync = mock.patch.object(app, "_sync_live_checkout", return_value={"synced": False})
        self._sync.start()

    def tearDown(self):
        self._sync.stop()
        app._branch_cache.get("held_other", {}).clear()

    def test_foreign_default_domain_hub_is_held_and_its_group_is_kept(self):
        repo, _bare, task_a, task_b = make_repo_with_conflicting_siblings()
        hub_path = next((repo / "queue" / "coordinating").glob("*.json"))
        hub = json.loads(hub_path.read_text())
        hub.update({"source": "manual", "domain": "default", "subTasks": [
            {"id": task_a, "title": "A", "status": "pending-merge", "phase": "built"},
            {"id": task_b, "title": "B", "status": "in-progress", "phase": "open"}]})
        hub_path.write_text(json.dumps(hub))
        with mock.patch.object(app, "get_active_repo_root", return_value="/media/not-this-repo"), \
                mock.patch.object(app, "queue_dir", return_value=repo / "queue"):
            rows = app._list_unmerged_branches_uncached(force_fetch=True, repo_root=str(repo), pipeline_dir=str(repo))
        self.assertEqual(rows, [])
        groups = app._branch_cache["held_other"][str(repo)]
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["waitingOn"], [task_b])


if __name__ == "__main__":
    unittest.main()
