import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import branch_git_memo as memo  # noqa: E402
try:
    import app  # noqa: E402
except ModuleNotFoundError:      # a bare interpreter without Flask (the review sandbox): the listing tests below skip, the memo unit tests still run
    app = None


class MemoUnit(unittest.TestCase):
    def setUp(self):
        memo.reset()
        self.addCleanup(memo.reset)
        self.calls = 0

    def compute(self, value=7):
        def run():
            self.calls += 1
            return value
        return run

    def test_same_branch_and_base_is_computed_once(self):
        self.assertEqual(memo.get("/r", "b1", "h1", "ahead", self.compute()), 7)
        self.assertEqual(memo.get("/r", "b1", "h1", "ahead", self.compute()), 7)
        self.assertEqual(self.calls, 1)
        self.assertEqual(memo.stats()["hits"], 1)
        self.assertEqual(memo.stats()["misses"], 1)

    def test_a_moved_head_or_a_moved_base_or_another_kind_or_repo_recomputes(self):
        memo.get("/r", "b1", "h1", "ahead", self.compute())
        memo.get("/r", "b1", "h2", "ahead", self.compute())
        memo.get("/r", "b2", "h1", "ahead", self.compute())
        memo.get("/r", "b1", "h1", "behind", self.compute())
        memo.get("/other", "b1", "h1", "ahead", self.compute())
        self.assertEqual(self.calls, 5)

    def test_extra_is_part_of_the_key(self):
        memo.get("/r", "b1", "h1", "k", self.compute(), extra="x")
        memo.get("/r", "b1", "h1", "k", self.compute(), extra="y")
        self.assertEqual(self.calls, 2)

    def test_a_value_that_is_not_final_is_not_kept(self):
        memo.get("/r", "b1", "h1", "conflict", self.compute(None), final=lambda v: v is not None)
        memo.get("/r", "b1", "h1", "conflict", self.compute(None), final=lambda v: v is not None)
        self.assertEqual(self.calls, 2)
        self.assertEqual(memo.stats()["size"], 0)

    def test_a_raising_compute_stores_nothing_and_propagates(self):
        def boom():
            self.calls += 1
            raise RuntimeError("git down")
        for _ in range(2):
            with self.assertRaises(RuntimeError):
                memo.get("/r", "b1", "h1", "ahead", boom)
        self.assertEqual(self.calls, 2)
        self.assertEqual(memo.get("/r", "b1", "h1", "ahead", self.compute(3)), 3)

    def test_an_unknown_sha_bypasses_the_memo(self):
        memo.get("/r", "", "h1", "ahead", self.compute())
        memo.get("/r", "", "h1", "ahead", self.compute())
        memo.get("/r", "b1", "", "ahead", self.compute())
        memo.get("/r", "b1", "", "ahead", self.compute())
        self.assertEqual(self.calls, 4)
        self.assertEqual(memo.stats()["bypass"], 4)
        self.assertEqual(memo.stats()["size"], 0)

    def test_a_falsy_final_value_is_still_a_hit(self):
        memo.get("/r", "b1", "h1", "ahead", self.compute(0))
        self.assertEqual(memo.get("/r", "b1", "h1", "ahead", self.compute(0)), 0)
        self.assertEqual(self.calls, 1)

    def test_bounded_oldest_entry_is_dropped(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_BRANCH_GIT_MEMO_MAX": "2"}):
            memo.get("/r", "b", "h1", "k", self.compute())
            memo.get("/r", "b", "h2", "k", self.compute())
            memo.get("/r", "b", "h1", "k", self.compute())      # h1 is now the newest
            memo.get("/r", "b", "h3", "k", self.compute())      # drops h2
            self.assertEqual(memo.stats()["size"], 2)
            before = self.calls
            memo.get("/r", "b", "h1", "k", self.compute())
            self.assertEqual(self.calls, before, "h1 survived")
            memo.get("/r", "b", "h2", "k", self.compute())
            self.assertEqual(self.calls, before + 1, "h2 was dropped")

    def test_zero_turns_it_off_and_a_bad_value_uses_the_default(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_BRANCH_GIT_MEMO_MAX": "0"}):
            memo.get("/r", "b", "h", "k", self.compute())
            memo.get("/r", "b", "h", "k", self.compute())
            self.assertEqual(self.calls, 2)
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_BRANCH_GIT_MEMO_MAX": "lots"}):
            self.assertEqual(memo.max_entries(), 8192)

    def test_take_delta_reports_only_what_happened_since_the_last_call(self):
        memo.get("/r", "b", "h", "k", self.compute())
        self.assertEqual(memo.take_delta(), {"hits": 0, "misses": 1})
        memo.get("/r", "b", "h", "k", self.compute())
        self.assertEqual(memo.take_delta(), {"hits": 1, "misses": 0})
        self.assertEqual(memo.take_delta(), {"hits": 0, "misses": 0})


@unittest.skipIf(app is None, 'Flask is not installed')
class ListingUsesTheMemo(unittest.TestCase):
    """A second listing of unmoved branches under an unmoved base spawns no per-branch git; a moved branch or base recomputes."""

    def setUp(self):
        memo.reset()
        self.addCleanup(memo.reset)
        self.heads = {"origin/agent/t1": "h1", "origin/agent/t2": "h2"}
        self.base = "base1"
        self.git = []
        self.conflict_calls = 0
        self.conflict_checked = True
        self.fail_merge_base = False

    def fake_git(self, args, cwd, timeout=30):
        self.git.append(args)
        if args[0] == "for-each-ref":
            return "".join(f"{ref}\t{sha}\t2026-11-07T00:00:00+00:00\tsubject {ref}\n" for ref, sha in self.heads.items())
        if args[0] == "rev-parse":
            return self.base + "\n"
        if args[0] == "rev-list":
            return "2\n"
        if args[0] == "log":
            return "Task: tX\n"
        if args[0] == "merge-base":
            if self.fail_merge_base:
                raise RuntimeError("boom")
            return "mb\n"
        if args[0] == "diff":
            return "f.txt\0"
        return ""

    def fake_conflict(self, repo_root, main, branch):
        self.conflict_calls += 1
        return {"willConflict": False if self.conflict_checked else None, "conflictFiles": [], "checked": self.conflict_checked}

    def listing(self):
        self.git.clear()
        self.conflict_calls = 0
        with mock.patch.object(app, "get_active_repo_root", return_value="/repo"), \
                mock.patch.object(app, "get_pipeline_dir", return_value=None), \
                mock.patch.object(app, "_detect_main_branch", return_value="master"), \
                mock.patch.object(app, "_run_git", side_effect=self.fake_git), \
                mock.patch.object(app, "_check_merge_conflict", side_effect=self.fake_conflict), \
                mock.patch.object(app, "_annotate_hub_sibling_conflicts"), \
                mock.patch.object(app, "queue_dir", return_value=Path(tempfile.gettempdir())), \
                mock.patch("branch_verdicts.enrich_branches_with_verdicts"):
            with app._branch_cache_lock:
                app._branch_fetch_state["at"] = 1e18      # no fetch
            return app._list_unmerged_branches_uncached(force_fetch=False)

    def per_branch(self):
        return [a for a in self.git if a[0] in ("rev-list", "log", "merge-base", "diff")]

    def test_second_listing_runs_no_per_branch_git(self):
        first = self.listing()
        self.assertEqual([b["branch"] for b in first], ["agent/t1", "agent/t2"])
        self.assertTrue(self.per_branch())
        self.assertEqual(self.conflict_calls, 2)
        second = self.listing()
        self.assertEqual(second, first)
        self.assertEqual(self.per_branch(), [])
        self.assertEqual(self.conflict_calls, 0)

    def test_only_the_moved_branch_is_recomputed(self):
        self.listing()
        self.heads["origin/agent/t2"] = "h2b"
        self.listing()
        self.assertEqual(self.conflict_calls, 1)
        self.assertTrue(all("agent/t2" in " ".join(a) for a in self.per_branch() if a[0] == "rev-list"))

    def test_a_moved_base_recomputes_every_branch(self):
        self.listing()
        self.base = "base2"
        self.listing()
        self.assertEqual(self.conflict_calls, 2)

    def test_an_unreadable_base_sha_bypasses_the_memo(self):
        self.base = ""
        self.listing()
        self.listing()
        self.assertEqual(self.conflict_calls, 2)

    def test_a_conflict_check_that_errored_is_asked_again_but_the_rest_is_kept(self):
        self.conflict_checked = False
        self.listing()
        self.listing()
        self.assertEqual(self.conflict_calls, 2, "an unchecked conflict preview is not kept")
        self.assertEqual(self.per_branch(), [], "ahead, behind, squash and trailers were kept")

    def test_a_git_failure_in_the_squash_check_is_not_kept(self):
        self.fail_merge_base = True
        self.listing()
        self.fail_merge_base = False
        self.listing()
        self.assertTrue(any(a[0] == "merge-base" for a in self.git), "the failed squash check ran again")
        self.listing()
        self.assertFalse(any(a[0] == "merge-base" for a in self.git), "and once it succeeded it was kept")


if __name__ == "__main__":
    unittest.main()
