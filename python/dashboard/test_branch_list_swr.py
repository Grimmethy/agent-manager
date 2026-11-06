"""The read-only branch listing never recomputes inside the request (2026-11-02, phase 5 of the memory-pressure plan).

Before: a merge, discard or verdict reset the cache timestamp to 0, and the NEXT request for the list took the "no cache" path and recomputed synchronously, including
a `git fetch` (about 37 s under IO pressure on 2026-11-01, past the tab's 30 s timeout). Now the listing endpoint (stale_ok=True) serves the last good list at once,
starts the one background refresh, and says so in X-Branch-Refreshing. The mutating routes keep their synchronous recompute (they must see their own change), but
the branch they just merged or discarded is dropped from the cached list immediately.

Run: .venv/bin/python -m unittest python.dashboard.test_branch_list_swr -v   (from the repo root)
"""
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from test_branch_list_cache import CacheCase, NEW, OLD  # noqa: E402


class StaleOk(CacheCase):
    def setUp(self):
        super().setUp()
        with app._branch_cache_lock:
            app._branch_cache.pop("filled", None)

    def invalidated_with(self, branches):
        self.fill(branches, age=0)
        with app._branch_cache_lock:
            app._branch_cache["filled"] = True
        app._invalidate_branch_cache(refetch=False)

    def test_an_invalidated_cache_serves_the_last_list_at_once_and_refreshes_on_the_background_thread(self):
        self.invalidated_with(OLD)
        gate, calls = threading.Event(), []

        def slow(force_fetch=True):
            calls.append(threading.current_thread().name)
            gate.wait(5)
            return NEW

        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=slow):
            t0 = time.time()
            got = app.list_unmerged_branches(force=False, stale_ok=True)
            self.assertLess(time.time() - t0, 2, "the request must not wait for the recompute")
            self.assertEqual(got, OLD)
            self.assertTrue(app.branch_list_refreshing())
            gate.set()
            self.join_refresh()
        self.assertEqual(calls, ["branch-list-refresh"])
        self.assertEqual(app.list_unmerged_branches(force=False), NEW)
        self.assertFalse(app.branch_list_refreshing())

    def test_two_listing_requests_during_a_refresh_start_exactly_one_recompute(self):
        self.invalidated_with(OLD)
        gate, calls = threading.Event(), []

        def slow(force_fetch=True):
            calls.append(1)
            gate.wait(5)
            return NEW

        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=slow):
            a = app.list_unmerged_branches(force=False, stale_ok=True)
            b = app.list_unmerged_branches(force=False, stale_ok=True)
            gate.set()
            self.join_refresh()
        self.assertEqual((a, b, len(calls)), (OLD, OLD, 1))

    def test_a_cold_start_has_nothing_to_serve_so_that_one_request_computes_the_first_list(self):
        calls = []

        def recompute(force_fetch=True):
            calls.append(threading.current_thread().name)
            return NEW

        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=recompute):
            self.assertEqual(app.list_unmerged_branches(force=False, stale_ok=True), NEW)
            self.assertEqual(calls, [threading.current_thread().name])
            self.assertEqual(app.list_unmerged_branches(force=False, stale_ok=True), NEW)       # filled: served from the cache from here on
        self.assertEqual(len(calls), 1)

    def test_without_stale_ok_an_invalidated_cache_still_recomputes_synchronously_so_mutating_routes_see_their_change(self):
        self.invalidated_with(OLD)
        calls = []

        def recompute(force_fetch=True):
            calls.append(threading.current_thread().name)
            return NEW

        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=recompute):
            got = app.list_unmerged_branches(force=False)
        self.assertEqual(got, NEW)
        self.assertEqual(calls, [threading.current_thread().name])

    def test_force_recomputes_synchronously_even_with_stale_ok(self):
        self.invalidated_with(OLD)
        with mock.patch.object(app, "_list_unmerged_branches_uncached", return_value=NEW):
            self.assertEqual(app.list_unmerged_branches(force=True, stale_ok=True), NEW)

    def test_a_fresh_cache_is_served_with_no_refresh(self):
        self.fill(OLD, age=1)
        with app._branch_cache_lock:
            app._branch_cache["filled"] = True
        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=AssertionError("must not recompute")):
            self.assertEqual(app.list_unmerged_branches(force=False, stale_ok=True), OLD)
        self.assertFalse(app.branch_list_refreshing())

    def test_a_stale_cache_counts_as_refreshing_even_before_the_thread_has_started(self):
        self.fill(OLD, age=app._BRANCH_CACHE_TTL_SECONDS + 5)
        self.assertTrue(app.branch_list_refreshing())
        self.fill(OLD, age=app._BRANCH_CACHE_TTL_SECONDS - 5)
        self.assertFalse(app.branch_list_refreshing())

    def test_a_failed_background_refresh_keeps_serving_the_old_list(self):
        self.invalidated_with(OLD)
        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=RuntimeError("git down")):
            self.assertEqual(app.list_unmerged_branches(force=False, stale_ok=True), OLD)
            self.join_refresh()
            self.assertEqual(app.list_unmerged_branches(force=False, stale_ok=True), OLD)


class DropBranch(CacheCase):
    def test_invalidate_with_drop_branch_removes_only_that_card_at_once(self):
        rows = [{"branch": "agent/a"}, {"branch": "agent/b"}, {"branch": "agent/c"}]
        self.fill(rows, age=0)
        app._invalidate_branch_cache(drop_branch="agent/b")
        self.assertEqual([b["branch"] for b in app._branch_cache["branches"]], ["agent/a", "agent/c"])
        self.assertEqual(app._branch_cache["at"], 0.0)

    def test_invalidate_without_drop_branch_keeps_every_card(self):
        self.fill([{"branch": "agent/a"}], age=0)
        app._invalidate_branch_cache()
        self.assertEqual(len(app._branch_cache["branches"]), 1)


class ListingRoute(CacheCase):
    def setUp(self):
        super().setUp()
        with app._branch_cache_lock:
            app._branch_cache.pop("filled", None)
        self.client = app.app.test_client()

    def test_the_route_answers_from_the_last_list_and_flags_refreshing_while_the_recompute_runs(self):
        self.fill(OLD, age=0)
        with app._branch_cache_lock:
            app._branch_cache["filled"] = True
        app._invalidate_branch_cache(refetch=False)
        gate = threading.Event()
        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=lambda force_fetch=True: (gate.wait(5), NEW)[1]):
            t0 = time.time()
            r = self.client.get("/api/git/unmerged-branches")
            self.assertLess(time.time() - t0, 2)
            self.assertEqual((r.status_code, [b["branch"] for b in r.get_json()], r.headers["X-Branch-Refreshing"]), (200, ["agent/old"], "1"))
            gate.set()
            self.join_refresh()
        r2 = self.client.get("/api/git/unmerged-branches")
        self.assertEqual(([b["branch"] for b in r2.get_json()], r2.headers["X-Branch-Refreshing"]), (["agent/new"], "0"))

    def test_the_etag_changes_when_only_the_refreshing_flag_changes(self):
        self.fill(OLD, age=1)
        with app._branch_cache_lock:
            app._branch_cache["filled"] = True
        a = self.client.get("/api/git/unmerged-branches")
        self.assertEqual(a.headers["X-Branch-Refreshing"], "0")
        with app._branch_cache_lock:
            app._branch_fetch_state["refreshing"] = True
        b = self.client.get("/api/git/unmerged-branches")
        self.assertEqual(b.headers["X-Branch-Refreshing"], "1")
        self.assertNotEqual(a.headers["ETag"], b.headers["ETag"])
        c = self.client.get("/api/git/unmerged-branches", headers={"If-None-Match": a.headers["ETag"]})
        self.assertEqual(c.status_code, 200, "the unchanged-list 304 must not hide the flag change")


if __name__ == "__main__":
    unittest.main()


class RealStorePath(CacheCase):
    def test_a_list_stored_by_the_normal_path_survives_invalidation_as_the_stale_list(self):
        # No hand-set flags: the list is stored the way the app stores it, then a verdict/merge/discard invalidates the cache.
        with app._branch_cache_lock:
            app._branch_cache.pop("filled", None)
        with mock.patch.object(app, "queue_dir", return_value=None):
            app._store_branch_list(OLD)
        app._invalidate_branch_cache(refetch=False)
        self.assertEqual(app._branch_cache["at"], 0.0)
        gate = threading.Event()
        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=lambda force_fetch=True: (gate.wait(5), NEW)[1]):
            self.assertEqual(app.list_unmerged_branches(force=False, stale_ok=True), OLD)
            gate.set()
            self.join_refresh()

    def test_an_invalidated_cache_counts_as_refreshing_before_any_refresh_thread_exists(self):
        self.fill(OLD, age=0)
        app._invalidate_branch_cache(refetch=False)
        self.assertFalse(app._branch_fetch_state["refreshing"])
        self.assertTrue(app.branch_list_refreshing())

    def test_rows_without_a_branch_key_are_left_alone_when_nothing_is_dropped(self):
        self.fill([{"headSha": "x"}, {"branch": "agent/a"}], age=0)
        app._invalidate_branch_cache()
        self.assertEqual(len(app._branch_cache["branches"]), 2)
