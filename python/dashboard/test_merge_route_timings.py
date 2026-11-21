"""POST /api/git/branches/<branch>/merge reports per-step timings (routes/pipeline_1_more.py api_git_merge_branch).

The git work, the live-checkout sync, the task-record stamps and the plugin check are all replaced with fakes, so no real
repo, queue, lock or plugin is touched. Mirrors the setup of test_branch_cross_project_actions.py.

Run: python3 python/dashboard/test_merge_route_timings.py   (or: python3 -m unittest python.dashboard.test_merge_route_timings -v, from the repo root)
"""
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

try:
    import flask  # noqa: F401
    HAS_FLASK = True
except ImportError:
    HAS_FLASK = False

if HAS_FLASK:
    import app  # noqa: E402
    import branch_projects  # noqa: E402
    import gate_test_support  # noqa: E402
    import routes.pipeline_1_more as pm  # noqa: E402

TIMING_KEYS = {"validateS", "mergeS", "liveSyncS", "stampS", "taskLogS", "pluginsBehindS", "pluginsChecked", "totalS"}
TIME_KEYS = TIMING_KEYS - {"pluginsChecked"}
UNCHANGED_KEYS = {"succeeded", "branch", "mainBranch", "liveSync", "warnings", "restartNeeded"}
BRANCH = "agent/merge-timing-probe-1"


@unittest.skipUnless(HAS_FLASK, "flask is not importable: the merge route needs it")
class MergeRouteTimings(unittest.TestCase):
    def setUp(self):
        self.client = gate_test_support.client(self)
        self.context = {"main_branch": "main", "branch": BRANCH}
        patches = [
            mock.patch.object(app, "get_active_repo_root", return_value="/tmp/merge-timing-active-repo"),
            mock.patch.object(pm, "_validate_and_authorize_merge", return_value=self.context),
            mock.patch.object(pm, "_execute_git_merge", return_value=None),
            mock.patch.object(pm, "_apply_post_merge_side_effects", return_value={"synced": True}),
            mock.patch.object(pm, "_record_merge_in_task_file", return_value=None),
            mock.patch.object(pm, "_record_merge_in_task_log", return_value=None),
            mock.patch.object(branch_projects, "resolve_scope", return_value=None),
            mock.patch.object(app, "_read_plugins_manifest", return_value=[]),
            mock.patch("plugin_process_manager.PluginProcessManager"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def merge(self):
        url = f"/api/git/branches/{BRANCH.replace('/', '%2F')}/merge"
        return self.client.post(url, json={})

    def test_success_timings_have_exactly_the_eight_keys_non_negative_and_total_covers_each_step(self):
        res = self.merge()
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        timings = res.get_json()["timings"]
        self.assertEqual(set(timings), TIMING_KEYS)
        for key in TIME_KEYS:
            self.assertGreaterEqual(timings[key], 0, key)
        self.assertGreaterEqual(timings["pluginsChecked"], 0)
        for key in TIME_KEYS - {"totalS"}:
            self.assertGreaterEqual(timings["totalS"], timings[key], key)

    def test_a_slow_step_shows_up_in_its_own_timing(self):
        with mock.patch.object(pm, "_execute_git_merge", side_effect=lambda ctx: time.sleep(0.05)):
            res = self.merge()
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        self.assertGreaterEqual(res.get_json()["timings"]["mergeS"], 0.05)

    def test_the_existing_response_keys_are_unchanged(self):
        body = self.merge().get_json()
        self.assertTrue(UNCHANGED_KEYS <= set(body), UNCHANGED_KEYS - set(body))
        self.assertIs(body["succeeded"], True)
        self.assertEqual(body["branch"], BRANCH)
        self.assertEqual(body["mainBranch"], "main")
        self.assertEqual(body["liveSync"], {"synced": True})
        self.assertEqual(body["warnings"], [])
        self.assertEqual(body["restartNeeded"], [])

    def test_a_failing_post_merge_step_is_a_warning_and_still_has_timings(self):
        with mock.patch.object(pm, "_record_merge_in_task_file", side_effect=RuntimeError("boom")):
            res = self.merge()
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertIs(body["succeeded"], True)
        self.assertTrue(body["warnings"], "the failed step must be reported as a warning")
        self.assertIsInstance(body.get("timings"), dict)
        self.assertEqual(set(body["timings"]), TIMING_KEYS)

    def test_a_merge_lock_busy_is_a_409_with_no_timings(self):
        with mock.patch.object(pm, "_execute_git_merge", side_effect=pm.MergeLockBusy()):
            res = self.merge()
        self.assertEqual(res.status_code, 409)
        body = res.get_json(silent=True) or {}
        self.assertNotIn("timings", body)

    def test_the_merge_timings_log_line_is_written_exactly_once(self):
        with self.assertLogs(level="INFO") as captured:
            res = self.merge()
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        lines = [r.getMessage() for r in captured.records if r.getMessage().startswith("merge timings branch=")]
        self.assertEqual(len(lines), 1, lines)


if __name__ == "__main__":
    unittest.main()
