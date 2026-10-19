"""Hub children are held out of the Unmerged Branches pool until their hub is ready (yellow hardening 8/8).

A first half whose wiring sibling is not built can only be verified as "hold", so its branch stays pushed but unlisted until
every sibling is built; model-decomposed hubs only, deterministic-source hubs and hubs that own a branch are listed as before.

Run: .venv/bin/python -m unittest python.dashboard.test_held_hub_branches -v
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


def hub_data(subs, **extra):
    return {"id": "hub-1", "title": "HUB0900", "source": "manual", "domain": "adhoc", "subTasks": subs, **extra}


def branch(name, hub):
    return {"branch": name, "hub": hub}


def two_child_hub(second_phase, **extra):
    return app._summarize_hub(hub_data([
        {"id": "h-1", "status": "pending-merge", "phase": "built"},
        {"id": "h-2", "status": "in-progress" if second_phase == "open" else "pending-merge", "phase": second_phase},
    ], **extra), "coordinating")


class TestHeldHubBranches(unittest.TestCase):
    def test_two_child_hub_with_wiring_child_pending_lists_nothing(self):
        hub = two_child_hub("open")
        listed, held = app.partition_held_hub_branches([branch("agent/h-1", hub)])
        self.assertEqual(listed, [])
        self.assertEqual(len(held), 1)
        self.assertEqual(held[0]["branches"], ["agent/h-1"])
        self.assertEqual(held[0]["waitingOn"], ["h-2"])
        self.assertEqual(held[0]["progress"], {"done": 0, "built": 1, "total": 2})

    def test_once_both_are_built_both_appear_together(self):
        hub = two_child_hub("built")
        listed, held = app.partition_held_hub_branches([branch("agent/h-1", hub), branch("agent/h-2", hub)])
        self.assertEqual([b["branch"] for b in listed], ["agent/h-1", "agent/h-2"])
        self.assertEqual(held, [])

    def test_deterministic_source_hub_is_unaffected(self):
        hub = app._summarize_hub(hub_data([
            {"id": "m-1", "phase": "built"}, {"id": "m-2", "phase": "open"},
        ], source="function_length_fix", domain="default"), "coordinating")
        listed, held = app.partition_held_hub_branches([branch("agent/m-1", hub)])
        self.assertEqual(len(listed), 1)
        self.assertEqual(held, [])

    def test_hub_that_owns_a_branch_is_unaffected(self):
        hub = two_child_hub("open", branch="agent/decompose-x")
        listed, _ = app.partition_held_hub_branches([branch("agent/decompose-x", hub)])
        self.assertEqual(len(listed), 1)

    def test_branch_without_a_hub_is_listed(self):
        listed, held = app.partition_held_hub_branches([branch("agent/plain", None)])
        self.assertEqual(len(listed), 1)
        self.assertEqual(held, [])

    def test_hub_already_done_is_listed(self):
        hub = app._summarize_hub(hub_data([{"id": "d-1", "phase": "merged"}]), "done")
        listed, _ = app.partition_held_hub_branches([branch("agent/d-1", hub)])
        self.assertEqual(len(listed), 1)

    def test_env_switch_turns_the_hold_off(self):
        hub = two_child_hub("open")
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_HOLD_UNFINISHED_HUB_CHILDREN": "false"}):
            listed, held = app.partition_held_hub_branches([branch("agent/h-1", hub)])
        self.assertEqual(len(listed), 1)
        self.assertEqual(held, [])

    def test_two_held_branches_of_one_hub_make_one_group(self):
        hub = app._summarize_hub(hub_data([
            {"id": "h-1", "phase": "built"}, {"id": "h-2", "phase": "built"}, {"id": "h-3", "phase": "open"},
        ]), "coordinating")
        listed, held = app.partition_held_hub_branches([branch("agent/h-1", hub), branch("agent/h-2", hub)])
        self.assertEqual(listed, [])
        self.assertEqual(held[0]["branches"], ["agent/h-1", "agent/h-2"])


class TestBranchTaskIds(unittest.TestCase):
    def test_trailer_ids_follow_the_branch_name_id_without_duplicates(self):
        run_git = mock.Mock(return_value="body\nTask: HUB1-01-a\n\nTask: HUB1-02-b\nTask: HUB1-01-a\n")
        ids = app.branch_task_ids(run_git, "/repo", "master", "origin/agent/x", "x")
        self.assertEqual(ids, ["x", "HUB1-01-a", "HUB1-02-b"])
        self.assertEqual(run_git.call_args[0][0], ["log", "origin/master..origin/agent/x", "--format=%b"])

    def test_a_git_failure_leaves_just_the_branch_name_id(self):
        run_git = mock.Mock(side_effect=RuntimeError("boom"))
        self.assertEqual(app.branch_task_ids(run_git, "/repo", "master", "origin/agent/x", "x"), ["x"])


class TestHeldHubRoute(unittest.TestCase):
    def test_route_returns_the_groups_the_listing_cached(self):
        group = {"hubId": "h", "title": "T", "progress": {"built": 1, "total": 2}, "waitingOn": ["h-2"], "branches": ["agent/h-1"]}
        with mock.patch.object(app, "list_unmerged_branches", return_value=[]), \
                mock.patch.dict(app._branch_cache, {"held": [group]}):
            res = app.app.test_client().get("/api/git/held-hub-branches")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json(), [group])


class TestHeldHubEndToEnd(unittest.TestCase):
    """Real bare origin + clone, real routes: the hub's second piece decides whether the first piece's pushed branch is listed."""

    def setUp(self):
        app._invalidate_branch_cache()
        self._sync = mock.patch.object(app, "_sync_live_checkout", return_value={"synced": False})
        self._sync.start()

    def tearDown(self):
        app._invalidate_branch_cache()
        self._sync.stop()

    def _set_hub(self, repo, task_a, task_b, b_status, b_phase):
        hub_path = next((repo / "queue" / "coordinating").glob("*.json"))
        hub = json.loads(hub_path.read_text())
        hub.update({"source": "manual", "domain": "adhoc"})
        hub["subTasks"] = [
            {"id": task_a, "title": "A", "status": "pending-merge", "phase": "built"},
            {"id": task_b, "title": "B", "status": b_status, "phase": b_phase},
        ]
        hub_path.write_text(json.dumps(hub))
        app._invalidate_branch_cache()

    def test_branches_are_held_until_the_second_piece_is_built_then_listed_together(self):
        repo, _bare, task_a, task_b = make_repo_with_conflicting_siblings()
        patches = [
            mock.patch.object(app, "get_active_repo_root", return_value=str(repo)),
            mock.patch.object(app, "get_pipeline_dir", return_value=repo),
            mock.patch.object(app, "queue_dir", return_value=repo / "queue"),
        ]
        for p in patches:
            p.start()
        try:
            client = app.app.test_client()
            self._set_hub(repo, task_a, task_b, "in-progress", "open")
            self.assertEqual(client.get("/api/git/unmerged-branches").get_json(), [], "nothing is listed while a piece is still open")
            held = client.get("/api/git/held-hub-branches").get_json()
            self.assertEqual(len(held), 1)
            self.assertEqual(sorted(held[0]["branches"]), sorted([f"agent/{task_a}", f"agent/{task_b}"]))
            self.assertEqual(held[0]["waitingOn"], [task_b])
            self._set_hub(repo, task_a, task_b, "pending-merge", "built")
            listed = sorted(b["branch"] for b in client.get("/api/git/unmerged-branches").get_json())
            self.assertEqual(listed, sorted([f"agent/{task_a}", f"agent/{task_b}"]))
            self.assertEqual(client.get("/api/git/held-hub-branches").get_json(), [])
        finally:
            for p in patches:
                p.stop()


if __name__ == "__main__":
    unittest.main()
