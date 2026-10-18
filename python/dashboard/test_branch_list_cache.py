"""The Unmerged Branches list is served stale-while-revalidate and its `git fetch` has its own timer.

2026-10-15: /api/git/unmerged-branches forced a full recompute on every call (a 14-16 s `git fetch origin --prune` plus per-branch git work: ~37 s at load 13), past the tab's
30 s client timeout. These tests stub the recompute and git so nothing here touches a real repo or the network.

Run: .venv/bin/python -m unittest python.dashboard.test_branch_list_cache -v   (from the repo root)
"""
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

OLD = [{"branch": "agent/old", "headSha": "sha-old"}]
NEW = [{"branch": "agent/new", "headSha": "sha-new"}]


class CacheCase(unittest.TestCase):
    def setUp(self):
        with app._branch_cache_lock:
            self._saved = (dict(app._branch_cache), dict(app._branch_fetch_state))
            app._branch_cache.update({"at": 0.0, "branches": []})
            app._branch_fetch_state.clear()
            app._branch_fetch_state.update({"at": 0.0, "refreshing": False})
        self.addCleanup(self._restore)

    def _restore(self):
        t = app._branch_fetch_state.get("thread")
        if t is not None:
            t.join(5)
        with app._branch_cache_lock:
            app._branch_cache.clear()
            app._branch_cache.update(self._saved[0])
            app._branch_fetch_state.clear()
            app._branch_fetch_state.update(self._saved[1])

    def fill(self, branches, age):
        with app._branch_cache_lock:
            app._branch_cache["at"] = time.time() - age
            app._branch_cache["branches"] = branches

    def join_refresh(self):
        t = app._branch_fetch_state.get("thread")
        self.assertIsNotNone(t, "no refresh thread was started")
        t.join(5)
        self.assertFalse(t.is_alive())


class StaleWhileRevalidate(CacheCase):
    def test_stale_cache_is_returned_immediately_and_exactly_one_refresh_runs(self):
        self.fill(OLD, age=app._BRANCH_CACHE_TTL_SECONDS + 10)
        gate, calls = threading.Event(), []

        def slow_recompute(force_fetch=True):
            calls.append((threading.current_thread().name, force_fetch))
            gate.wait(5)
            return NEW

        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=slow_recompute):
            first = app.list_unmerged_branches(force=False)
            second = app.list_unmerged_branches(force=False)
            self.assertEqual(first, OLD)
            self.assertEqual(second, OLD)
            gate.set()
            self.join_refresh()
        self.assertEqual(len(calls), 1, "single-flight: two stale reads must start one refresh")
        self.assertEqual(calls[0][0], "branch-list-refresh", "the recompute ran on the refresh thread, not the caller's")
        self.assertFalse(calls[0][1], "the background refresh leaves the fetch to its own timer")
        self.assertEqual(app.list_unmerged_branches(force=False), NEW)
        self.assertFalse(app._branch_fetch_state["refreshing"])

    def test_fresh_cache_is_returned_without_any_recompute(self):
        self.fill(OLD, age=1)
        with mock.patch.object(app, "_list_unmerged_branches_uncached") as rec:
            self.assertEqual(app.list_unmerged_branches(force=False), OLD)
        rec.assert_not_called()

    def test_empty_cache_computes_synchronously(self):
        with mock.patch.object(app, "_list_unmerged_branches_uncached", return_value=NEW) as rec:
            self.assertEqual(app.list_unmerged_branches(force=False), NEW)
        rec.assert_called_once_with(force_fetch=False)
        self.assertIsNone(app._branch_fetch_state.get("thread"))

    def test_force_true_always_computes_synchronously_with_a_forced_fetch(self):
        self.fill(OLD, age=app._BRANCH_CACHE_TTL_SECONDS + 10)
        with mock.patch.object(app, "_list_unmerged_branches_uncached", return_value=NEW) as rec:
            self.assertEqual(app.list_unmerged_branches(force=True), NEW)
        rec.assert_called_once_with(force_fetch=True)
        self.assertIsNone(app._branch_fetch_state.get("thread"))

    def test_a_refresh_that_raises_keeps_the_old_list_and_a_later_call_can_refresh_again(self):
        self.fill(OLD, age=app._BRANCH_CACHE_TTL_SECONDS + 10)
        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=RuntimeError("git fetch failed")):
            self.assertEqual(app.list_unmerged_branches(force=False), OLD)
            self.join_refresh()
            self.assertFalse(app._branch_fetch_state["refreshing"], "the flag is cleared even when the refresh raised")
            self.assertEqual(app._branch_cache["branches"], OLD, "a failed refresh leaves the old list in the cache")
        with mock.patch.object(app, "_list_unmerged_branches_uncached", return_value=NEW):
            self.assertEqual(app.list_unmerged_branches(force=False), OLD)
            self.join_refresh()
        self.assertEqual(app.list_unmerged_branches(force=False), NEW)


class FetchTimer(CacheCase):
    def run_uncached(self, **kw):
        git_calls = []

        def fake_git(args, cwd, timeout=30):
            git_calls.append(args[0])
            if args[0] == "for-each-ref":
                return ""
            return "master\n"

        with mock.patch.object(app, "get_active_repo_root", return_value="/repo"), \
                mock.patch.object(app, "get_pipeline_dir", return_value=None), \
                mock.patch.object(app, "_detect_main_branch", return_value="master"), \
                mock.patch.object(app, "_run_git", side_effect=fake_git), \
                mock.patch.object(app, "_annotate_hub_sibling_conflicts"), \
                mock.patch.object(app, "queue_dir", return_value=Path(tempfile.gettempdir())), \
                mock.patch("branch_verdicts.enrich_branches_with_verdicts"):
            app._list_unmerged_branches_uncached(**kw)
        return git_calls

    def test_fetch_runs_when_never_fetched_and_is_skipped_inside_the_ttl(self):
        self.assertEqual(self.run_uncached(force_fetch=False).count("fetch"), 1)
        self.assertEqual(self.run_uncached(force_fetch=False).count("fetch"), 0, "second recompute inside 60 s reuses the local refs")

    def test_fetch_runs_again_once_the_ttl_has_passed_and_when_forced(self):
        self.run_uncached(force_fetch=False)
        with app._branch_cache_lock:
            app._branch_fetch_state["at"] = time.time() - app._BRANCH_FETCH_TTL_SECONDS - 1
        self.assertEqual(self.run_uncached(force_fetch=False).count("fetch"), 1)
        self.assertEqual(self.run_uncached(force_fetch=True).count("fetch"), 1, "force_fetch ignores the timer")

    def test_invalidate_clears_the_fetch_timer_by_default_but_not_with_refetch_false(self):
        with app._branch_cache_lock:
            app._branch_fetch_state["at"] = 12345.0
        app._invalidate_branch_cache(refetch=False)
        self.assertEqual(app._branch_fetch_state["at"], 12345.0)
        self.assertEqual(app._branch_cache["at"], 0.0)
        app._invalidate_branch_cache()
        self.assertEqual(app._branch_fetch_state["at"], 0.0)


class Routes(CacheCase):
    def setUp(self):
        super().setUp()
        self.client = app.app.test_client()

    def test_get_list_uses_the_cache_returns_a_plain_list_and_reports_its_age(self):
        self.fill(OLD, age=7)
        with mock.patch.object(app, "list_unmerged_branches", wraps=app.list_unmerged_branches) as spy, \
                mock.patch.object(app, "_list_unmerged_branches_uncached") as rec:
            resp = self.client.get("/api/git/unmerged-branches")
        spy.assert_called_once_with(force=False)
        rec.assert_not_called()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json(), OLD)
        self.assertGreaterEqual(int(resp.headers["X-Branch-Cache-Age"]), 7)

    def test_verdict_post_uses_the_cached_gate_and_skips_the_refetch(self):
        card = {"branch": "agent/t1", "taskId": "t1", "headSha": "sha-A", "hub": None, "mainBranch": "master"}
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with app._branch_cache_lock:
            app._branch_fetch_state["at"] = 999.0
        with mock.patch.object(app, "get_active_repo_root", return_value="/repo"), \
                mock.patch.object(app, "queue_dir", return_value=Path(tmp.name)), \
                mock.patch.object(app, "list_unmerged_branches", return_value=[card]) as lst, \
                mock.patch.object(app, "_run_git", return_value="") as git, \
                mock.patch.object(app, "get_hub_data_provider"), \
                mock.patch("branch_verdicts.resolve_owner", return_value=([], None)), \
                mock.patch("branch_verdicts.write_task_log"):
            resp = self.client.post("/api/git/branches/agent/t1/verdict", json={"verdict": "merge", "reasons": ["ok"], "source": "chat", "sha": "sha-A"})
        lst.assert_called_once_with(force=False)
        git.assert_not_called()
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        self.assertEqual(resp.get_json()["headSha"], "sha-A")
        self.assertEqual(app._branch_fetch_state["at"], 999.0, "recording a verdict must not clear the fetch timer")
        self.assertEqual(app._branch_cache["at"], 0.0, "but it still drops the cached cards")


if __name__ == "__main__":
    unittest.main()
