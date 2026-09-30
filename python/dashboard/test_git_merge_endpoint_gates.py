"""Pins the gate behavior of POST /api/git/branches/<branch>/merge (api_git_merge_branch in
routes/pipeline_1_more.py) so splitting that endpoint into helpers cannot silently drop one.

Why this exists (2026-09-30, AC-26 / HUB0067): the first attempt at splitting the endpoint
(rescued branch commit bc4262f4) dropped the hub sibling-conflict 409, turned the apply-lock
contention 409 into a 500, changed the no-repo-root 404 text and dropped the task-logs/<id>.json
stamp. Only the two real-git tests (test_hub_sibling_conflict, test_git_merge_closes_task_log)
noticed, and only by accident of what they happened to cover. Every gate here returns BEFORE any
git work, so these tests patch names on `app` instead of building a git fixture.

Also pins the length limit the split was filed against: the function-length scanner's default
is 100 lines (function-length-scan.js DEFAULT_MAX_FUNCTION_LINES).

Run: .venv/bin/python -m unittest python.dashboard.test_git_merge_endpoint_gates -v
"""
import ast
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

BRANCH = "agent/adhoc-gate-probe-1790000000000"
SIBLING = "agent/adhoc-gate-sibling-1790000000001"
MAX_FUNCTION_LINES = 100
MERGE_FUNCTIONS = (
    "api_git_merge_branch",
    "_validate_and_authorize_merge",
    "_execute_git_merge",
    "_apply_post_merge_side_effects",
    "_record_merge_in_task_file",
    "_record_merge_in_task_log",
)


def _branch(**extra):
    return {"branch": BRANCH, "title": "Gate probe", "mainBranch": "main", "taskId": BRANCH.removeprefix("agent/"), **extra}


def _unfinished_hub():
    return {"id": "hub-x", "readyToMerge": False, "progress": {"done": 1, "total": 3}, "integrationGate": {"status": "failed"}}


class TestMergeEndpointGates(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        self._patches = []

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def _patch(self, name, **kw):
        p = mock.patch.object(app, name, **kw)
        self._patches.append(p)
        return p.start()

    def _setup(self, branches, repo_root="/tmp/gate-probe-repo", lock=None):
        self._patch("get_active_repo_root", return_value=repo_root)
        self._patch("list_unmerged_branches", return_value=branches)
        if lock is not None:
            self._patch("_acquire_apply_lock", **lock)

    def _post(self, **kw):
        return self.client.post(f"/api/git/branches/{BRANCH.replace('/', '%2F')}/merge", **kw)

    def test_no_repo_root_is_a_404_with_the_original_message(self):
        self._setup([], repo_root=None)
        res = self._post()
        self.assertEqual(res.status_code, 404)
        self.assertIn("no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable", res.get_data(as_text=True))

    def test_unlisted_branch_is_a_404(self):
        self._setup([])
        res = self._post()
        self.assertEqual(res.status_code, 404)
        self.assertIn("is not a currently-listed, pushed-but-unmerged agent/* branch", res.get_data(as_text=True))

    def test_unmerged_sibling_conflict_is_a_409_naming_the_sibling(self):
        self._setup([_branch(hubSiblingConflicts=[SIBLING]), {"branch": SIBLING}])
        res = self._post()
        self.assertEqual(res.status_code, 409)
        body = res.get_json()
        self.assertFalse(body["succeeded"])
        self.assertIn("would conflict with still-unmerged sibling branch(es)", body["reason"])
        self.assertIn(SIBLING, body["reason"])
        self.assertIn("dependency order", body["reason"])

    def test_a_sibling_no_longer_listed_does_not_block(self):
        self._setup([_branch(hubSiblingConflicts=[SIBLING])], lock={"side_effect": RuntimeError("busy")})
        res = self._post()
        self.assertEqual(res.status_code, 409)
        self.assertIn("mid-apply", res.get_data(as_text=True), "a sibling that is gone must not block; the request proceeds to the lock")

    def test_sibling_conflict_is_reported_before_the_unfinished_hub_gate(self):
        self._setup([_branch(hubSiblingConflicts=[SIBLING], hub=_unfinished_hub()), {"branch": SIBLING}])
        res = self._post()
        self.assertEqual(res.status_code, 409)
        self.assertIn("would conflict with still-unmerged sibling", res.get_json()["reason"])
        self.assertNotIn("which is not finished", res.get_json()["reason"])

    def test_unfinished_hub_is_a_409_with_progress_and_gate(self):
        self._setup([_branch(hub=_unfinished_hub())])
        res = self._post()
        self.assertEqual(res.status_code, 409)
        body = res.get_json()
        self.assertFalse(body["succeeded"])
        self.assertIn("belongs to coordinator hub hub-x which is not finished (1/3 task(s) done, integration gate failed)", body["reason"])

    def test_force_bypasses_both_gates_and_reaches_the_lock(self):
        self._setup([_branch(hubSiblingConflicts=[SIBLING], hub=_unfinished_hub()), {"branch": SIBLING}],
                    lock={"side_effect": RuntimeError("busy")})
        res = self._post(json={"force": True})
        self.assertEqual(res.status_code, 409)
        self.assertIn("the pipeline is mid-apply right now -- try again in a few seconds", res.get_data(as_text=True))

    def test_apply_lock_contention_is_a_409_not_a_500(self):
        self._setup([_branch()], lock={"side_effect": RuntimeError("held by another process")})
        res = self._post()
        self.assertEqual(res.status_code, 409)
        self.assertIn("the pipeline is mid-apply right now -- try again in a few seconds", res.get_data(as_text=True))

    def test_merge_functions_stay_within_the_function_length_limit(self):
        tree = ast.parse((Path(__file__).parent / "routes" / "pipeline_1_more.py").read_text(encoding="utf-8"))
        lengths = {n.name: n.end_lineno - n.lineno + 1 for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
        missing = [name for name in MERGE_FUNCTIONS if name not in lengths]
        self.assertEqual(missing, [], f"expected these merge helpers to exist: {missing}")
        too_long = {name: lengths[name] for name in MERGE_FUNCTIONS if lengths[name] > MAX_FUNCTION_LINES}
        self.assertEqual(too_long, {}, f"each must be {MAX_FUNCTION_LINES} lines or fewer")


if __name__ == "__main__":
    unittest.main()
