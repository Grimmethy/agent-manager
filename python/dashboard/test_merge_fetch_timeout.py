"""The Merge button on a loaded host (2026-11-03): `git fetch origin` took 47 s against a 30 s limit and the uncaught TimeoutExpired became a bare 500, four times in nine minutes.

Pins: an action's fetch gets its own longer limit; the second fetch of a merge is skipped when the check just before it fetched; a timeout is a retryable 503 that says whether
anything changed. Every git call is patched, so no test touches a repo or the network.

Run: .venv/bin/python -m unittest python.dashboard.test_merge_fetch_timeout -v
"""
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import app_catalog_helpers as helpers  # noqa: E402
import branch_projects  # noqa: E402
from routes import pipeline_1_more as route  # noqa: E402

BRANCH = "agent/adhoc-fetch-timeout-probe-1790000000000"


def _timeout(cmd=("git", "fetch", "origin"), seconds=180):
    return subprocess.TimeoutExpired(list(cmd), seconds)


def _context(fetched_at):
    return {"match": {"branch": BRANCH, "title": "Probe", "mainBranch": "main"}, "main_branch": "main", "repo_root": "/tmp/x", "scope": None, "fetchedAt": fetched_at}


class TestActionFetchTimeoutSetting(unittest.TestCase):
    def test_default_is_180(self):
        self.assertEqual(helpers._action_fetch_timeout_seconds({}), 180.0)

    def test_env_overrides(self):
        self.assertEqual(helpers._action_fetch_timeout_seconds({"AGENT_MANAGER_ACTION_FETCH_TIMEOUT_SECONDS": "240"}), 240.0)

    def test_floor_is_30(self):
        self.assertEqual(helpers._action_fetch_timeout_seconds({"AGENT_MANAGER_ACTION_FETCH_TIMEOUT_SECONDS": "5"}), 30.0)

    def test_garbage_falls_back_to_180(self):
        self.assertEqual(helpers._action_fetch_timeout_seconds({"AGENT_MANAGER_ACTION_FETCH_TIMEOUT_SECONDS": "soon"}), 180.0)

    def test_module_constant_uses_it_and_is_longer_than_the_list_limit(self):
        self.assertEqual(app._ACTION_FETCH_TIMEOUT_SECONDS, helpers._ACTION_FETCH_TIMEOUT_SECONDS)
        self.assertGreater(app._ACTION_FETCH_TIMEOUT_SECONDS, 30)
        self.assertEqual(app._ACTION_FETCH_REUSE_SECONDS, 120.0)


class TestFetchLimitsReachGit(unittest.TestCase):
    def _fetch_timeouts(self, run_git):
        return [c.kwargs.get("timeout") for c in run_git.call_args_list if c.args[0][:1] == ["fetch"]]

    def test_uncached_list_passes_the_given_limit(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(app, "_run_git", return_value="") as rg, mock.patch.object(app, "_detect_main_branch", return_value="main"):
            app._list_unmerged_branches_uncached(force_fetch=True, repo_root=d, pipeline_dir=d, fetch_timeout=77)
        self.assertEqual(self._fetch_timeouts(rg), [77])

    def test_uncached_list_default_limit_stays_30(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(app, "_run_git", return_value="") as rg, mock.patch.object(app, "_detect_main_branch", return_value="main"):
            app._list_unmerged_branches_uncached(force_fetch=True, repo_root=d, pipeline_dir=d)
        self.assertEqual(self._fetch_timeouts(rg), [30])

    def test_forced_list_uses_the_action_limit_and_a_plain_refresh_does_not(self):
        with mock.patch.object(app, "_list_unmerged_branches_uncached", return_value=[]) as lu, mock.patch.object(app, "_store_branch_list"):
            app.list_unmerged_branches(force=True)
            self.assertEqual(lu.call_args.kwargs["fetch_timeout"], app._ACTION_FETCH_TIMEOUT_SECONDS)
            with app._branch_cache_lock:
                app._branch_cache["at"] = 0
            lu.reset_mock()
            app._branch_fetch_state["refreshing"] = True  # keep the stale-while-revalidate thread from starting
            try:
                app.list_unmerged_branches(force=False)
            finally:
                app._branch_fetch_state["refreshing"] = False
            self.assertEqual(lu.call_args.kwargs, {"force_fetch": False})

    def test_other_project_refresh_uses_the_action_limit(self):
        scope = {"repoRoot": "/tmp/other", "pipelineDir": "/tmp/other-pipe"}
        with mock.patch.object(app, "_list_unmerged_branches_uncached", return_value=[]) as lu:
            branch_projects.refresh_branches(scope)
        self.assertEqual(lu.call_args.kwargs["fetch_timeout"], app._ACTION_FETCH_TIMEOUT_SECONDS)


class TestSecondFetchIsSkippedWhenTheFirstWasRecent(unittest.TestCase):
    def _run(self, fetched_at):
        calls = []

        def fake_git(args, cwd, timeout=30):
            calls.append((list(args), timeout))
            return ""
        with tempfile.TemporaryDirectory() as q, mock.patch.object(app, "_run_git", fake_git), mock.patch.object(app, "_acquire_apply_lock", return_value=1), \
                mock.patch.object(app, "_release_apply_lock"), mock.patch.object(app, "queue_dir", return_value=Path(q)):
            route._execute_git_merge(_context(fetched_at))
        return [c for c in calls if c[0][:1] == ["fetch"]]

    def test_recent_fetch_is_not_repeated(self):
        self.assertEqual(self._run(time.time() - 5), [])

    def test_old_fetch_is_repeated_with_the_action_limit(self):
        self.assertEqual(self._run(time.time() - 400), [(["fetch", "origin"], app._ACTION_FETCH_TIMEOUT_SECONDS)])

    def test_missing_fetch_time_fetches(self):
        self.assertEqual(len(self._run(0)), 1)

    def test_just_inside_the_reuse_window_skips_and_just_outside_fetches(self):
        self.assertEqual(self._run(time.time() - 100), [])
        self.assertEqual(len(self._run(time.time() - 140)), 1)


class TestValidateRecordsAHonestFetchTime(unittest.TestCase):
    def test_active_project_uses_the_time_a_fetch_last_finished(self):
        with mock.patch.object(app, "list_unmerged_branches", return_value=[{"branch": BRANCH, "mainBranch": "main"}]):
            with app._branch_cache_lock:
                old = app._branch_fetch_state["at"]
                app._branch_fetch_state["at"] = 1234.5
            try:
                ctx = route._validate_and_authorize_merge("/tmp/x", BRANCH, False, None)
            finally:
                with app._branch_cache_lock:
                    app._branch_fetch_state["at"] = old
        self.assertEqual(ctx["fetchedAt"], 1234.5)

    def test_other_project_counts_as_fetched_now(self):
        with mock.patch.object(branch_projects, "refresh_branches", return_value=[{"branch": BRANCH, "mainBranch": "main"}]):
            before = time.time()
            ctx = route._validate_and_authorize_merge("/tmp/x", BRANCH, False, {"repoRoot": "/tmp/o"})
        self.assertGreaterEqual(ctx["fetchedAt"], before)


class TestTimeoutIsARetryable503(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        self._p = [mock.patch.object(app, "get_active_repo_root", return_value="/tmp/x")]
        for p in self._p:
            p.start()

    def tearDown(self):
        mock.patch.stopall()

    def _post(self):
        return self.client.post(f"/api/git/branches/{BRANCH.replace('/', '%2F')}/merge")

    def test_timeout_while_checking_says_nothing_changed(self):
        with mock.patch.object(route, "_validate_and_authorize_merge", side_effect=_timeout(("git", "fetch", "origin", "--prune"), 180.0)), \
                mock.patch.object(route, "_execute_git_merge") as ex:
            res = self._post()
        body = res.get_json()
        self.assertEqual(res.status_code, 503)
        self.assertIs(body["succeeded"], False)
        self.assertIs(body["retryable"], True)
        self.assertIn("while checking the branch", body["reason"])
        self.assertIn("`git fetch origin` took longer than 180 s", body["reason"])
        self.assertIn("Nothing was changed", body["reason"])
        ex.assert_not_called()

    def test_timeout_during_the_merge_says_look_before_retrying(self):
        with mock.patch.object(route, "_validate_and_authorize_merge", return_value=_context(time.time())), mock.patch.object(route, "_execute_git_merge", side_effect=_timeout(("git", "push", "origin", "main"), 30)), \
                mock.patch.object(route, "_apply_post_merge_side_effects") as post:
            res = self._post()
        body = res.get_json()
        self.assertEqual(res.status_code, 503)
        self.assertIs(body["retryable"], True)
        self.assertIn("while merging the branch", body["reason"])
        self.assertIn("may or may not have completed", body["reason"])
        self.assertNotIn("Nothing was changed", body["reason"])
        post.assert_not_called()

    def test_a_real_merge_failure_is_still_a_500(self):
        with mock.patch.object(route, "_validate_and_authorize_merge", return_value=_context(time.time())), mock.patch.object(route, "_execute_git_merge", side_effect=RuntimeError("push rejected")):
            res = self._post()
        self.assertEqual(res.status_code, 500)

    def test_timeout_releases_the_apply_lock(self):
        released = []
        with mock.patch.object(route, "_validate_and_authorize_merge", return_value=_context(0)), mock.patch.object(app, "_acquire_apply_lock", return_value=7), \
                mock.patch.object(app, "_release_apply_lock", side_effect=released.append), mock.patch.object(app, "_run_git", side_effect=_timeout()):
            res = self._post()
        self.assertEqual(res.status_code, 503)
        self.assertEqual(released, [7])


if __name__ == "__main__":
    unittest.main()
