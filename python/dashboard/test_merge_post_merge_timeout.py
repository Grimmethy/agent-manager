"""The Merge button AFTER the merge landed on origin (2026-11-03): the post-merge steps (fast-forward the dashboard's own checkout, stamp the task record, close the task log)
ran with no timeout handling. A git fetch that took longer than its limit raised an uncaught TimeoutExpired, the owner saw a failure or nothing for a merge that had happened,
and the later steps never ran.

Pins: each post-merge step is guarded on its own, a failure is a warning in the 200 response (never a 500), the later steps still run, and _sync_live_checkout reports
"not synced" instead of raising and fetches once with the action limit. Every git call is patched, so no test touches a repo or the network.

Run: .venv/bin/python -m unittest python.dashboard.test_merge_post_merge_timeout -v
"""
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes import pipeline_1_more as route  # noqa: E402

BRANCH = "agent/adhoc-post-merge-timeout-probe-1790000000001"


def _timeout(cmd=("git", "fetch", "origin"), seconds=180):
    return subprocess.TimeoutExpired(list(cmd), seconds)


def _context():
    return {"match": {"branch": BRANCH, "title": "Probe", "mainBranch": "main"}, "main_branch": "main", "repo_root": "/tmp/x", "scope": None}


class TestPostMergeStepsAreGuarded(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        self.calls = []
        mock.patch.object(app, "get_active_repo_root", return_value="/tmp/x").start()
        mock.patch.object(route, "_validate_and_authorize_merge", return_value=_context()).start()
        mock.patch.object(route, "_execute_git_merge").start()
        self.side = mock.patch.object(route, "_apply_post_merge_side_effects", side_effect=self._side).start()
        self.stamp = mock.patch.object(route, "_record_merge_in_task_file", side_effect=self._stamp).start()
        self.tlog = mock.patch.object(route, "_record_merge_in_task_log", side_effect=self._tlog).start()
        self.side_error = self.stamp_error = self.tlog_error = None

    def tearDown(self):
        mock.patch.stopall()

    def _side(self, context):
        self.calls.append("sync")
        if self.side_error:
            raise self.side_error
        return {"synced": True, "changed": False, "restartTriggered": False}

    def _stamp(self, *a, **k):
        self.calls.append("stamp")
        if self.stamp_error:
            raise self.stamp_error

    def _tlog(self, *a, **k):
        self.calls.append("log")
        if self.tlog_error:
            raise self.tlog_error

    def _post(self):
        return self.client.post(f"/api/git/branches/{BRANCH.replace('/', '%2F')}/merge")

    def test_a_normal_merge_is_unchanged_and_has_no_warnings(self):
        resp = self._post()
        body = resp.get_json()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(body["succeeded"])
        self.assertEqual(body["liveSync"], {"synced": True, "changed": False, "restartTriggered": False})
        self.assertEqual(body["warnings"], [])
        self.assertEqual(self.calls, ["sync", "stamp", "log"])

    def test_a_sync_timeout_is_a_200_that_says_merged_and_not_synced(self):
        self.side_error = _timeout(("git", "fetch", "origin"), 180)
        resp = self._post()
        body = resp.get_json()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(body["succeeded"])
        self.assertIs(body["liveSync"]["synced"], False)
        self.assertIn("did not answer in time", body["liveSync"]["reason"])
        self.assertIn("merge itself is on origin", body["liveSync"]["reason"])
        self.assertEqual(len(body["warnings"]), 1)
        self.assertIn("syncing the dashboard checkout", body["warnings"][0])
        self.assertIn("180", body["warnings"][0])

    def test_the_task_record_and_log_are_still_written_after_a_sync_timeout(self):
        self.side_error = _timeout()
        self._post()
        self.assertEqual(self.calls, ["sync", "stamp", "log"])

    def test_a_failed_record_stamp_is_a_warning_and_the_log_step_still_runs(self):
        self.stamp_error = OSError("disk full")
        resp = self._post()
        body = resp.get_json()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self.calls, ["sync", "stamp", "log"])
        self.assertEqual(len(body["warnings"]), 1)
        self.assertIn("stamping the task record", body["warnings"][0])
        self.assertIn("disk full", body["warnings"][0])
        self.assertTrue(body["liveSync"]["synced"])

    def test_a_failed_task_log_is_a_warning(self):
        self.tlog_error = RuntimeError("log write failed")
        resp = self._post()
        body = resp.get_json()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(body["warnings"]), 1)
        self.assertIn("closing the task log", body["warnings"][0])

    def test_a_git_failure_while_syncing_is_also_a_warning_not_a_500(self):
        self.side_error = RuntimeError("git fetch origin failed: network down")
        resp = self._post()
        body = resp.get_json()
        self.assertEqual(resp.status_code, 200)
        self.assertIs(body["liveSync"]["synced"], False)
        self.assertIn("network down", body["liveSync"]["reason"])

    def test_all_three_failing_gives_three_warnings_and_still_a_200(self):
        self.side_error = _timeout()
        self.stamp_error = OSError("a")
        self.tlog_error = _timeout(("git", "log"), 30)
        resp = self._post()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.get_json()["warnings"]), 3)

    def test_a_programming_error_is_not_hidden_as_a_warning(self):
        self.stamp_error = KeyError("bug")
        # Other test modules may leave Flask propagating exceptions; pin the production behaviour (an unhandled error is a 500).
        with mock.patch.dict(app.app.config, {"PROPAGATE_EXCEPTIONS": False, "TESTING": False}):
            resp = self._post()
        self.assertEqual(resp.status_code, 500)

    def test_a_merge_that_did_not_land_is_still_a_failure(self):
        route._execute_git_merge.side_effect = RuntimeError("push rejected")
        resp = self._post()
        self.assertEqual(resp.status_code, 500)
        self.assertEqual(self.calls, [])


class TestSyncLiveCheckoutNeverRaisesAGitTimeout(unittest.TestCase):
    """app._sync_live_checkout with every git call faked."""

    def _status_ok(self):
        return mock.patch.object(app.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="", stderr=""))

    def test_a_fetch_timeout_returns_not_synced_with_the_command_and_the_limit(self):
        def fake_git(args, cwd, timeout=30):
            if args[0] == "fetch":
                raise _timeout(("git", "fetch", "origin"), timeout)
            return "abc\n"
        with self._status_ok(), mock.patch.object(app, "_run_git", fake_git):
            result = app._sync_live_checkout("main")
        self.assertIs(result["synced"], False)
        self.assertIn("git fetch origin", result["reason"])
        self.assertIn(f"{app._ACTION_FETCH_TIMEOUT_SECONDS:g} s", result["reason"])
        self.assertIn("git pull --ff-only", result["reason"])

    def test_a_timeout_in_the_status_check_returns_not_synced(self):
        with mock.patch.object(app.subprocess, "run", side_effect=_timeout(("git", "status", "--porcelain"), 15)):
            result = app._sync_live_checkout("main")
        self.assertIs(result["synced"], False)
        self.assertIn("git status --porcelain", result["reason"])

    def test_it_fetches_once_with_the_action_limit_and_fast_forwards_with_the_same_limit(self):
        calls = []
        heads = iter(["aaa\n", "aaa\n", "bbb\n"])

        def fake_git(args, cwd, timeout=30):
            calls.append((args[0], timeout))
            if args[0] == "rev-parse":
                return next(heads)
            return ""
        with self._status_ok(), mock.patch.object(app, "_run_git", fake_git):
            result = app._sync_live_checkout("main")
        self.assertTrue(result["synced"])
        self.assertEqual([c for c in calls if c[0] == "fetch"], [("fetch", app._ACTION_FETCH_TIMEOUT_SECONDS)])
        self.assertEqual([c for c in calls if c[0] == "merge"], [("merge", app._ACTION_FETCH_TIMEOUT_SECONDS)])
        self.assertNotIn("pull", [c[0] for c in calls])

    def test_a_timeout_while_fast_forwarding_returns_not_synced(self):
        heads = iter(["aaa\n", "aaa\n"])

        def fake_git(args, cwd, timeout=30):
            if args[0] == "rev-parse":
                return next(heads)
            if args[0] == "merge":
                raise _timeout(("git", "merge", "--ff-only", "origin/main"), timeout)
            return ""
        with self._status_ok(), mock.patch.object(app, "_run_git", fake_git):
            result = app._sync_live_checkout("main")
        self.assertIs(result["synced"], False)
        self.assertIn("git merge --ff-only origin/main", result["reason"])


if __name__ == "__main__":
    unittest.main()
