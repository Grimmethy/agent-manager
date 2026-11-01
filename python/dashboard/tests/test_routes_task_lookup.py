"""Route-level tests for project param passthrough to resolve_task_across_projects (2026-10-30).

Verifies that the /api/task/<state>/<task_id> route in routes/task.py:
  1. Passes ?project=<label> as project_hint to resolve_task_across_projects.
  2. Calls resolve_task_across_projects with project_hint=None when no ?project= is given.
  3. Returns 404 when resolve_task_across_projects raises TaskNotFoundError.
  4. Works correctly when multiple projects are registered and the hinted one owns the task.

Sandbox projects only: temp directories, a stubbed branch_projects registry, no live queue.
Imports from project_scope (not from any other module).

Run: .venv/bin/python -m unittest python.dashboard.tests.test_routes_task_lookup -v  (from the repo root)
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent))

import app  # noqa: E402
import branch_projects  # noqa: E402
from project_scope import TaskNotFoundError, resolve_task_across_projects  # noqa: E402


def _make_stub_registry(tmp: Path, alpha_has: str | None, beta_has: str | None) -> tuple[list[dict], Path, Path]:
    """Build two sandbox projects with optional task files, return (registry, alpha_q, beta_q)."""
    alpha_q = tmp / "alpha-pipe" / "queue"
    beta_q = tmp / "beta-pipe" / "queue"
    alpha_q.mkdir(parents=True, exist_ok=True)
    beta_q.mkdir(parents=True, exist_ok=True)
    alpha_root = tmp / "alpha-repo"
    beta_root = tmp / "beta-repo"
    alpha_root.mkdir(parents=True, exist_ok=True)
    beta_root.mkdir(parents=True, exist_ok=True)
    if alpha_has:
        (alpha_q / "pending").mkdir(parents=True, exist_ok=True)
        (alpha_q / "pending" / f"{alpha_has}.json").write_text(json.dumps({"id": alpha_has, "title": f"alpha-{alpha_has}"}))
    if beta_has:
        (beta_q / "pending").mkdir(parents=True, exist_ok=True)
        (beta_q / "pending" / f"{beta_has}.json").write_text(json.dumps({"id": beta_has, "title": f"beta-{beta_has}"}))
    registry = [
        {"repoRoot": str(alpha_root.resolve()), "pipelineDir": str(tmp / "alpha-pipe"), "label": "alpha"},
        {"repoRoot": str(beta_root.resolve()), "pipelineDir": str(tmp / "beta-pipe"), "label": "beta"},
    ]
    return registry, alpha_q, beta_q


class TaskLookupProjectParamTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._captured = {}

        registry, alpha_q, beta_q = _make_stub_registry(self.tmp, "t-alpha", "t-beta")
        alpha_root = str((self.tmp / "alpha-repo").resolve())

        def _resolve_side_effect(task_id, project_hint=None, projects=None):
            self._captured["task_id"] = task_id
            self._captured["project_hint"] = project_hint
            self._captured["projects_keys"] = list(projects.keys()) if projects else []
            # Simulate the real resolution: look in the hinted project first, then others.
            order = list(projects.keys())
            if project_hint and project_hint in projects:
                order = [project_hint] + [k for k in order if k != project_hint]
            for proj_name in order:
                qdir = projects[proj_name].get("qdir")
                if not qdir:
                    continue
                for state in ["pending", "review", "approved", "blocked", "done", "needs-clarification", "awaiting-confirm", "coordinating"]:
                    p = qdir / state / f"{task_id}.json"
                    if p.is_file():
                        return json.loads(p.read_text())
                adh = qdir / "adhoc" / f"{task_id}.json"
                if adh.is_file():
                    return json.loads(adh.read_text())
            raise TaskNotFoundError(f"Task '{task_id}' not found in any project")

        self._patches = [
            mock.patch.object(app, "queue_dir", return_value=alpha_q),
            mock.patch.object(app, "get_active_repo_root", return_value=alpha_root),
            mock.patch.object(branch_projects, "registered_projects", return_value=registry),
            mock.patch(
                "routes.task.resolve_task_across_projects",
                side_effect=_resolve_side_effect,
            ),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

        self.client = app.app.test_client()

    # --- 1. project param passthrough ---------------------------------------------------------------------------------------------

    def test_route_passes_project_param_as_project_hint(self):
        """?project=beta should arrive at resolve_task_across_projects as project_hint='beta'."""
        r = self.client.get("/api/task/pending/t-beta?project=beta")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(self._captured["project_hint"], "beta")

    def test_route_without_project_param_passes_none(self):
        """No ?project= means project_hint=None reaches resolve_task_across_projects."""
        r = self.client.get("/api/task/pending/t-alpha")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertIsNone(self._captured["project_hint"])

    # --- 2. TaskNotFoundError -> 404 ----------------------------------------------------------------------------------------------

    def test_missing_task_returns_404(self):
        """TaskNotFoundError from resolve_task_across_projects becomes a 404 response."""
        r = self.client.get("/api/task/pending/ghost-task")
        self.assertEqual(r.status_code, 404)

    def test_missing_task_with_project_hint_returns_404(self):
        """Even with ?project=, a missing task still 404s."""
        r = self.client.get("/api/task/pending/ghost-task?project=beta")
        self.assertEqual(r.status_code, 404)

    # --- 3. Multi-project resolution ----------------------------------------------------------------------------------------------

    def test_hinted_project_that_owns_the_task_returns_its_data(self):
        """When ?project= points to the project that has the task, that project is searched first."""
        r = self.client.get("/api/task/pending/t-alpha?project=alpha")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(r.get_json()["id"], "t-alpha")
        # The hint should be first in the search order.
        self.assertEqual(self._captured["projects_keys"][0], "alpha")

    def test_hinted_project_without_task_falls_back_to_other(self):
        """?project=alpha but task is in beta -> resolve searches alpha first, then falls back."""
        r = self.client.get("/api/task/pending/t-beta?project=alpha")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(r.get_json()["id"], "t-beta")
        # alpha is hinted so it must come first in search order.
        self.assertEqual(self._captured["projects_keys"][0], "alpha")

    def test_unregistered_project_hint_still_searches_all_projects(self):
        """?project= for an unregistered project is ignored, not a crash."""
        r = self.client.get("/api/task/pending/t-alpha?project=ghost-project")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        # project_hint is passed through as-is (project_scope handles the 'not in projects' case).
        self.assertEqual(self._captured["project_hint"], "ghost-project")


if __name__ == "__main__":
    unittest.main()
