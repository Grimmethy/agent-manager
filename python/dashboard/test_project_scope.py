"""Unit tests for project_scope.resolve_task_across_projects (2026-10-30).

Covers the four resolution paths: found in the hinted project, found in a
non-hinted project, not found anywhere, and an empty projects dict. Each test
uses its own temp directory + stubbed project stores so there is no dependency
on the live registry, the active project, or any Flask machinery.

Run: .venv/bin/python -m unittest python.dashboard.test_project_scope -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

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


class ResolveTaskAcrossProjectsTest(unittest.TestCase):
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

    # --- found in the hinted project ------------------------------------------------------------------------------------------------------

    def test_hints_to_the_project_that_owns_the_task_returns_that_project_data(self):
        projects = self._make_projects(alpha=("t-alpha", "pending"), beta=None)
        result = resolve_task_across_projects("t-alpha", project_hint="alpha", projects=projects)
        self.assertEqual(result["id"], "t-alpha")
        self.assertEqual(result["title"], "task-t-alpha")

    def test_hints_to_a_project_and_task_lives_there_in_review_not_pending(self):
        projects = self._make_projects(alpha=("t-in-review", "review"), beta=None)
        result = resolve_task_across_projects("t-in-review", project_hint="alpha", projects=projects)
        self.assertEqual(result["id"], "t-in-review")

    # --- found in a non-hinted project ----------------------------------------------------------------------------------------------------

    def test_when_hinted_project_has_no_task_falls_back_to_other_projects(self):
        projects = self._make_projects(alpha=None, beta=("t-beta", "pending"))
        result = resolve_task_across_projects("t-beta", project_hint="alpha", projects=projects)
        self.assertEqual(result["id"], "t-beta")

    def test_hinted_project_with_wrong_task_id_does_not_confuse_the_lookup(self):
        projects = self._make_projects(alpha=("t-alpha", "pending"), beta=("t-beta", "pending"))
        result = resolve_task_across_projects("t-beta", project_hint="alpha", projects=projects)
        self.assertEqual(result["id"], "t-beta")

    # --- not found raises TaskNotFoundError -----------------------------------------------------------------------------------------------

    def test_missing_task_in_all_projects_raises_TaskNotFoundError(self):
        projects = self._make_projects(alpha=None, beta=None)
        with self.assertRaises(TaskNotFoundError) as ctx:
            resolve_task_across_projects("ghost-task", project_hint="alpha", projects=projects)
        self.assertIn("ghost-task", str(ctx.exception))

    def test_missing_task_without_hint_still_raises(self):
        projects = self._make_projects(alpha=None, beta=None)
        with self.assertRaises(TaskNotFoundError):
            resolve_task_across_projects("ghost-task", project_hint=None, projects=projects)

    def test_unregistered_project_hint_is_ignored_not_failing(self):
        projects = self._make_projects(alpha=None, beta=("t-beta", "pending"))
        result = resolve_task_across_projects("t-beta", project_hint="ghost-project", projects=projects)
        self.assertEqual(result["id"], "t-beta")

    # --- empty projects dict --------------------------------------------------------------------------------------------------------------

    def test_empty_projects_dict_raises_TaskNotFoundError(self):
        with self.assertRaises(TaskNotFoundError):
            resolve_task_across_projects("anything", project_hint=None, projects={})

    def test_empty_projects_with_hint_raises_TaskNotFoundError(self):
        with self.assertRaises(TaskNotFoundError):
            resolve_task_across_projects("anything", project_hint="alpha", projects={})

    # --- edge cases -----------------------------------------------------------------------------------------------------------------------

    def test_project_without_qdir_is_skipped(self):
        projects = {"alpha": {"repoRoot": str(self.tmp / "alpha-repo")}}  # no qdir
        with self.assertRaises(TaskNotFoundError):
            resolve_task_across_projects("anything", project_hint="alpha", projects=projects)

    def test_corrupt_task_file_in_hinted_project_falls_through_to_next(self):
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
