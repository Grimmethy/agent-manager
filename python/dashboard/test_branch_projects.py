"""Unmerged Branches across every registered project (branch_projects.py + `?projects=all`).

Nothing here touches a real repo or the network: the per-project recompute and the registry are stubbed.

Run: .venv/bin/python -m unittest python.dashboard.test_branch_projects -v   (from the repo root)
"""
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import branch_projects  # noqa: E402


def row(branch, pushed="2026-10-01T00:00:00-06:00"):
    return {"branch": branch, "pushedAt": pushed, "headSha": "sha-" + branch}


class ProjectsCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.roots = {}
        for name in ("alpha", "beta", "gamma"):
            r = self.tmp / name
            (r / ".git").mkdir(parents=True)
            self.roots[name] = str(r.resolve())
        (self.tmp / "sub").mkdir()  # in the registry but not its own repo
        self.registry = [
            {"repoRoot": self.roots["alpha"], "pipelineDir": str(self.tmp / "alpha-pipe"), "label": "alpha"},
            {"repoRoot": self.roots["beta"], "pipelineDir": str(self.tmp / "beta-pipe"), "label": "beta"},
            {"repoRoot": self.roots["gamma"], "pipelineDir": str(self.tmp / "gamma-pipe"), "label": "gamma"},
            {"repoRoot": self.roots["beta"], "pipelineDir": str(self.tmp / "beta-pipe"), "label": "beta-dup"},
            {"repoRoot": str(self.tmp / "sub"), "pipelineDir": str(self.tmp), "label": "sub"},
        ]
        with branch_projects._lock:
            self._saved = dict(branch_projects._state)
            branch_projects._state.update({"cache": {}, "thread": None})
        self.addCleanup(self._restore)
        p = mock.patch.object(app, "read_project_registry", lambda: list(self.registry))
        p.start()
        self.addCleanup(p.stop)

    def _restore(self):
        t = branch_projects._state.get("thread")
        if t is not None:
            t.join(5)
        with branch_projects._lock:
            branch_projects._state.clear()
            branch_projects._state.update(self._saved)

    def join(self):
        t = branch_projects._state.get("thread")
        if t is not None:
            t.join(5)

    def test_registry_dedupes_by_real_root_skips_non_repos_and_flags_active(self):
        ps = branch_projects.registered_projects(self.roots["alpha"])
        self.assertEqual([p["label"] for p in ps], ["alpha", "beta", "gamma"])
        self.assertEqual([p["active"] for p in ps], [True, False, False])

    def test_active_project_missing_from_registry_still_listed(self):
        extra = self.tmp / "delta"
        (extra / ".git").mkdir(parents=True)
        ps = branch_projects.registered_projects(str(extra))
        self.assertEqual([p["label"] for p in ps if p["active"]], ["delta"])

    def test_first_call_returns_active_rows_and_names_pending_projects_without_blocking(self):
        gate = threading.Event()

        def slow(**kw):
            gate.wait(5)
            return []
        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=slow):
            rows, pending = branch_projects.combined_branches([row("agent/a1")], self.roots["alpha"])
            self.assertEqual([r["branch"] for r in rows], ["agent/a1"])
            self.assertEqual(rows[0]["project"]["label"], "alpha")
            self.assertTrue(rows[0]["project"]["active"])
            self.assertEqual(sorted(pending), ["beta", "gamma"])
            gate.set()
            self.join()

    def test_active_first_then_other_projects_alphabetical_oldest_push_first(self):
        by_root = {
            self.roots["beta"]: [row("agent/b-new", "2026-10-05T00:00:00-06:00"), row("agent/b-old", "2026-10-02T00:00:00-06:00")],
            self.roots["gamma"]: [row("agent/g1")],
        }
        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=lambda **kw: by_root[kw["repo_root"]]):
            branch_projects.combined_branches([row("agent/a1"), row("agent/a2")], self.roots["alpha"])
            self.join()
            rows, pending = branch_projects.combined_branches([row("agent/a1"), row("agent/a2")], self.roots["alpha"])
        self.assertEqual(pending, [])
        self.assertEqual([r["branch"] for r in rows], ["agent/a1", "agent/a2", "agent/b-old", "agent/b-new", "agent/g1"])
        self.assertEqual([r["project"]["label"] for r in rows], ["alpha", "alpha", "beta", "beta", "gamma"])

    def test_cached_lists_are_not_mutated_by_tagging(self):
        cached = [row("agent/b1")]
        with mock.patch.object(app, "_list_unmerged_branches_uncached", return_value=cached):
            branch_projects.combined_branches([], self.roots["alpha"])
            self.join()
            branch_projects.combined_branches([], self.roots["alpha"])
        self.assertNotIn("project", cached[0])

    def test_one_failing_project_does_not_stop_the_others_and_is_not_retried_every_call(self):
        calls = []

        def stub(**kw):
            calls.append(kw["repo_root"])
            if kw["repo_root"] == self.roots["beta"]:
                raise RuntimeError("fetch failed")
            return [row("agent/g1")]
        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=stub):
            branch_projects.combined_branches([], self.roots["alpha"])
            self.join()
            rows, pending = branch_projects.combined_branches([], self.roots["alpha"])
            self.join()
        self.assertEqual([r["branch"] for r in rows], ["agent/g1"])
        self.assertEqual(pending, [])
        self.assertEqual(sorted(calls), sorted([self.roots["beta"], self.roots["gamma"]]), "each project computed once; the failure waits for the TTL")

    def test_other_projects_use_their_own_repo_and_pipeline_dir(self):
        seen = {}
        with mock.patch.object(app, "_list_unmerged_branches_uncached", side_effect=lambda **kw: seen.update({kw["repo_root"]: (kw["pipeline_dir"], kw["force_fetch"])}) or []):
            branch_projects.combined_branches([], self.roots["alpha"])
            self.join()
        self.assertEqual(seen[self.roots["beta"]], (str(self.tmp / "beta-pipe"), True))

    def test_find_other_project_branch_only_matches_cached_rows(self):
        with mock.patch.object(app, "_list_unmerged_branches_uncached", return_value=[row("agent/b1")]):
            branch_projects.combined_branches([], self.roots["alpha"])
            self.join()
        real, match = branch_projects.find_other_project_branch(self.roots["beta"], "agent/b1")
        self.assertEqual((real, match["branch"]), (self.roots["beta"], "agent/b1"))
        self.assertEqual(branch_projects.find_other_project_branch(self.roots["beta"], "agent/nope"), (None, None))
        self.assertEqual(branch_projects.find_other_project_branch(str(self.tmp / "elsewhere"), "agent/b1"), (None, None))


if __name__ == "__main__":
    unittest.main()
