"""Unit tests for project_scope.resolve_task_across_projects.

Covers the three required scenarios:
  (a) cross-project task resolution with project_hint,
  (b) single-project fallback when no hint provided,
  (c) TaskNotFoundError when task not found in any project.

Run: python -m pytest tests/test_project_scope.py -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

# Make the project_scope module importable from the dashboard package.
sys.path.insert(0, str(Path(__file__).parent.parent / "python" / "dashboard"))

from project_scope import TaskNotFoundError, resolve_task_across_projects  # noqa: E402


def _make_project_store(tmp: Path, name: str, task_id: str | None = None, task_data: dict | None = None, state: str = "pending") -> dict:
    """Build a single project's qdir with an optional task file inside it."""
    qdir = tmp / f"{name}-pipe" / "queue"
    qdir.mkdir(parents=True, exist_ok=True)
    if task_id is not None:
        data = task_data or {"id": task_id, "title": f"task-{task_id}"}
        state_dir = qdir / state
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / f"{task_id}.json").write_text(json.dumps(data))
    return {"qdir": qdir, "repoRoot": str(tmp / f"{name}-repo")}


class TestResolveTaskAcrossProjects(unittest.TestCase):
    """Unit tests for resolve_task_across_projects."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)

    def _make_projects(self, **kwargs) -> dict:
        """Build a projects dict from keyword args: name=(task_id_or_None, state)."""
        projects = {}
        for name, value in kwargs.items():
            if value is None:
                projects[name] = _make_project_store(self.tmp, name, task_id=None)
            else:
                task_id, state = value
                projects[name] = _make_project_store(self.tmp, name, task_id=task_id, state=state)
        return projects

    # ------------------------------------------------------------------ #
    # (a) Cross-project task resolution with project_hint                #
    # ------------------------------------------------------------------ #

    def test_hints_to_project_that_owns_task_returns_that_data(self):
        """When project_hint points to the project that has the task, that task is returned."""
        projects = self._make_projects(alpha=("t-alpha", "pending"), beta=None)
        result = resolve_task_across_projects("t-alpha", project_hint="alpha", projects=projects)
        self.assertEqual(result["id"], "t-alpha")
        self.assertEqual(result["title"], "task-t-alpha")

    def test_hints_to_project_and_task_lives_there_in_review_state(self):
        """project_hint works regardless of which queue state the task is in."""
        projects = self._make_projects(alpha=("t-in-review", "review"), beta=None)
        result = resolve_task_across_projects("t-in-review", project_hint="alpha", projects=projects)
        self.assertEqual(result["id"], "t-in-review")

    def test_hints_to_project_without_task_falls_back_to_other_projects(self):
        """When the hinted project doesn't have the task, the search continues to other projects."""
        projects = self._make_projects(alpha=None, beta=("t-beta", "pending"))
        result = resolve_task_across_projects("t-beta", project_hint="alpha", projects=projects)
        self.assertEqual(result["id"], "t-beta")

    def test_unregistered_project_hint_is_ignored_not_failing(self):
        """An unknown project_hint is silently skipped; lookup continues normally."""
        projects = self._make_projects(alpha=None, beta=("t-beta", "pending"))
        result = resolve_task_across_projects("t-beta", project_hint="ghost-project", projects=projects)
        self.assertEqual(result["id"], "t-beta")

    # ------------------------------------------------------------------ #
    # (b) Single-project fallback when no hint provided                  #
    # ------------------------------------------------------------------ #

    def test_no_hint_searches_all_projects_in_registration_order(self):
        """Without a project_hint, the function searches every project and returns the first match."""
        projects = self._make_projects(alpha=None, beta=("t-beta", "pending"))
        result = resolve_task_across_projects("t-beta", project_hint=None, projects=projects)
        self.assertEqual(result["id"], "t-beta")

    def test_no_hint_first_matching_project_wins(self):
        """When the task exists in multiple projects and no hint is given, the first project in the dict wins."""
        projects = self._make_projects(
            alpha=("t-dup", "pending"),
            beta=("t-dup", "pending"),
        )
        result = resolve_task_across_projects("t-dup", project_hint=None, projects=projects)
        # alpha is first in insertion order
        self.assertEqual(result["title"], "task-t-dup")

    # ------------------------------------------------------------------ #
    # (c) TaskNotFoundError when not found in any project              #
    # ------------------------------------------------------------------ #

    def test_missing_task_raises_TaskNotFoundError(self):
        """A task that does not exist in any project raises TaskNotFoundError."""
        projects = self._make_projects(alpha=None, beta=None)
        with self.assertRaises(TaskNotFoundError) as ctx:
            resolve_task_across_projects("ghost-task", project_hint="alpha", projects=projects)
        self.assertIn("ghost-task", str(ctx.exception))

    def test_missing_task_without_hint_still_raises(self):
        """Even with no hint, a missing task raises TaskNotFoundError."""
        projects = self._make_projects(alpha=None, beta=None)
        with self.assertRaises(TaskNotFoundError):
            resolve_task_across_projects("ghost-task", project_hint=None, projects=projects)

    def test_empty_projects_dict_raises_TaskNotFoundError(self):
        """An empty projects dict always raises TaskNotFoundError."""
        with self.assertRaises(TaskNotFoundError):
            resolve_task_across_projects("anything", project_hint=None, projects={})

    def test_empty_projects_with_hint_raises_TaskNotFoundError(self):
        """An empty projects dict with a hint still raises TaskNotFoundError."""
        with self.assertRaises(TaskNotFoundError):
            resolve_task_across_projects("anything", project_hint="alpha", projects={})

    def test_project_without_qdir_is_skipped(self):
        """A project entry missing a qdir is silently skipped."""
        projects = {"alpha": {"repoRoot": str(self.tmp / "alpha-repo")}}  # no qdir
        with self.assertRaises(TaskNotFoundError):
            resolve_task_across_projects("anything", project_hint="alpha", projects=projects)

    def test_corrupt_task_file_falls_through_to_next_project(self):
        """If the hinted project has a corrupt task file, the search continues to the next project."""
        alpha_qdir = (self.tmp / "alpha-pipe" / "queue").resolve()
        alpha_qdir.mkdir(parents=True)
        (alpha_qdir / "pending").mkdir(exist_ok=True)
        (alpha_qdir / "pending" / "t-dup.json").write_text("not-json")
        beta_qdir = (self.tmp / "beta-pipe" / "queue").resolve()
        beta_qdir.mkdir(parents=True)
        (beta_qdir / "pending").mkdir(exist_ok=True)
        (beta_qdir / "pending" / "t-dup.json").write_text(json.dumps({"id": "t-dup", "title": "from-beta"}))
        projects = {
            "alpha": {"qdir": alpha_qdir, "repoRoot": str(self.tmp / "alpha-repo")},
            "beta": {"qdir": beta_qdir, "repoRoot": str(self.tmp / "beta-repo")},
        }
        result = resolve_task_across_projects("t-dup", project_hint="alpha", projects=projects)
        self.assertEqual(result["title"], "from-beta")


if __name__ == "__main__":
    unittest.main()
