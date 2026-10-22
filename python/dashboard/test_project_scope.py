"""Cross-project path resolver (project_scope.py).

Nothing here touches a real repo or the environment: the registered_projects registry and the
active-root accessor are stubbed, so the cases are hermetic.

Run: .venv/bin/python -m unittest python.dashboard.test_project_scope -v   (from the repo root)
or:  python -m pytest python/dashboard/test_project_scope.py -v
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import project_scope  # noqa: E402


def fake(label, root, pipe, active=False):
    """A raw registered_projects-style entry (camelCase keys, pre-normalisation)."""
    return {"label": label, "repoRoot": root, "pipelineDir": pipe, "active": active}


class ProjectScopeCase(unittest.TestCase):
    def setUp(self):
        self.raw = [
            fake("alpha", "/tmp/alpha", "/tmp/alpha-pipe", True),
            fake("beta-project", "/tmp/beta", "/tmp/beta-pipe", False),
        ]
        reg = mock.patch.object(project_scope, "registered_projects",
                               lambda active_root: [dict(e) for e in self.raw])
        act = mock.patch.object(project_scope, "_active_root", lambda: "/tmp/alpha")
        reg.start()
        act.start()
        self.addCleanup(reg.stop)
        self.addCleanup(act.stop)

    def test_all_registered_projects_shape_and_queue_dir(self):
        out = project_scope.all_registered_projects()
        self.assertEqual(len(out), 2)
        for e in out:
            self.assertEqual(sorted(e), ["active", "label", "pipeline_dir", "queue_dir", "repo_root"])
            self.assertEqual(Path(e["queue_dir"]), Path(e["pipeline_dir"]) / "queue")
        self.assertEqual([e["label"] for e in out], ["alpha", "beta-project"])
        self.assertEqual([e["active"] for e in out], [True, False])
        self.assertEqual(out[1]["queue_dir"], "/tmp/beta-pipe/queue")

    def test_resolve_by_label_case_insensitive(self):
        self.assertEqual(project_scope.resolve_project("alpha")["label"], "alpha")
        self.assertEqual(project_scope.resolve_project("ALPHA")["label"], "alpha")
        self.assertEqual(project_scope.resolve_project("Beta-Project")["repo_root"], "/tmp/beta")

    def test_resolve_by_repo_root(self):
        e = project_scope.resolve_project("/tmp/beta")
        self.assertEqual((e["label"], e["repo_root"], e["queue_dir"]), ("beta-project", "/tmp/beta", "/tmp/beta-pipe/queue"))

    def test_resolve_by_repo_root_suffix(self):
        # "beta" is no project's label; it must still hit via the trailing part of the repoRoot.
        self.assertEqual(project_scope.resolve_project("beta")["repo_root"], "/tmp/beta")
        self.assertEqual(project_scope.resolve_project("tmp/alpha")["label"], "alpha")

    def test_resolve_none_and_empty_fall_back_to_active(self):
        for hint in (None, ""):
            e = project_scope.resolve_project(hint)
            self.assertEqual((e["label"], e["active"]), ("alpha", True))

    def test_resolve_unknown_hint_raises_value_error_no_active_fallback(self):
        with self.assertRaises(ValueError):
            project_scope.resolve_project("nonexistent")
        with self.assertRaises(ValueError):
            project_scope.resolve_project("/nowhere/at/all")

    def test_resolve_none_with_no_active_project_raises(self):
        # No active root AND no active flag in the registry: there is nothing to fall back to.
        act = mock.patch.object(project_scope, "_active_root", lambda: None)
        reg = mock.patch.object(project_scope, "registered_projects",
                               lambda active_root: [
                                   fake("alpha", "/tmp/alpha", "/tmp/alpha-pipe", False),
                                   fake("beta-project", "/tmp/beta", "/tmp/beta-pipe", False),
                               ])
        act.start()
        reg.start()
        self.addCleanup(act.stop)
        self.addCleanup(reg.stop)
        with self.assertRaises(ValueError):
            project_scope.resolve_project(None)


if __name__ == "__main__":
    unittest.main()
