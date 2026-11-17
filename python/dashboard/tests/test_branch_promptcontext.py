"""Unittest coverage for the unmerged-branch listing failure class (HUB0480 4/4).

Covers three cases against a real temp git repo and a temp pipeline dir:
- a task record whose promptContext is a plain string AND one whose promptContext is a
  dict are both listed, each with a non-empty title and description;
- when the per-branch labelling raises, the branch is still listed with its commit
  subject as its title;
- when a project's branch-list refresh raises, that project is reported by
  failed_project_labels() and by the X-Branch-Projects-Failed response header.

Only read-only GET routes are used; no mutating route is called.

Run: python3 -I -m unittest python/dashboard/tests/test_branch_promptcontext.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# Add the dashboard dir to sys.path (python -I ignores PYTHONPATH and the cwd).
sys.path.insert(0, str(Path(__file__).parent.parent))

import app  # noqa: E402
import branch_projects  # noqa: E402

GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@t"]

STRING_TASK = "pc-str-1"
DICT_TASK = "pc-dict-1"
STRING_SUBJECT = "subject for string promptContext"
DICT_SUBJECT = "subject for dict promptContext"


def git(args, cwd):
    return subprocess.run(
        ["git", *GIT_ID, *args],
        cwd=str(cwd), check=True, capture_output=True, text=True,
    ).stdout


class BranchPromptContextFixture(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.origin = root / "origin.git"
        self.work = root / "work"
        self.pipeline = root / "pipeline"
        (self.pipeline / "queue" / "done").mkdir(parents=True)

        git(["init", "--bare", "-b", "master", str(self.origin)], root)
        git(["clone", str(self.origin), str(self.work)], root)
        git(["checkout", "-b", "master"], self.work)
        (self.work / "shared.txt").write_text("base\n")
        git(["add", "-A"], self.work)
        git(["commit", "-m", "base"], self.work)
        git(["push", "origin", "master"], self.work)

        self._make_branch(STRING_TASK, STRING_SUBJECT)
        self._make_branch(DICT_TASK, DICT_SUBJECT)

        self._write_record(STRING_TASK, "Problem: a string body.\nSolution: keep it as prose.")
        self._write_record(DICT_TASK, {"body": "Problem: a dict body.\nSolution: read the body key.",
                                       "decomposedFrom": "some-parent-task"})

    def _make_branch(self, task_id, subject):
        name = f"agent/{task_id}"
        git(["checkout", "-B", name, "master"], self.work)
        (self.work / f"{task_id}.txt").write_text(f"change for {task_id}\n")
        git(["add", "-A"], self.work)
        git(["commit", "-m", subject], self.work)
        git(["push", "-f", "origin", name], self.work)
        git(["checkout", "master"], self.work)

    def _write_record(self, task_id, prompt_context):
        record = {
            "id": task_id,
            "title": f"Title for {task_id}",
            "domain": "adhoc",
            "source": "manual",
            "implementResponse": "",
            "promptContext": prompt_context,
        }
        (self.pipeline / "queue" / "done" / f"{task_id}.json").write_text(json.dumps(record))

    def list_rows(self):
        return app._list_unmerged_branches_uncached(
            force_fetch=True, repo_root=str(self.work), pipeline_dir=str(self.pipeline),
        )


class TestPromptContextListing(BranchPromptContextFixture):
    def test_string_and_dict_prompt_context_are_both_listed_with_labels(self):
        rows = {r["branch"]: r for r in self.list_rows()}
        for task_id in (STRING_TASK, DICT_TASK):
            branch = f"agent/{task_id}"
            self.assertIn(branch, rows)
            self.assertTrue(rows[branch].get("title"), f"empty title for {branch}")
            self.assertTrue(rows[branch].get("description"), f"empty description for {branch}")

    def test_failing_per_branch_labelling_still_lists_branch_with_subject_title(self):
        with mock.patch.object(app, "_label_for_branch", side_effect=RuntimeError("label boom")):
            rows = {r["branch"]: r for r in self.list_rows()}
        self.assertIn(f"agent/{STRING_TASK}", rows)
        self.assertIn(f"agent/{DICT_TASK}", rows)
        self.assertEqual(rows[f"agent/{STRING_TASK}"]["title"], STRING_SUBJECT)
        self.assertEqual(rows[f"agent/{DICT_TASK}"]["title"], DICT_SUBJECT)


class TestProjectRefreshFailureReported(BranchPromptContextFixture):
    LABEL = "tmp-failing-project"

    def setUp(self):
        super().setUp()
        real = os.path.realpath(str(self.work))
        saved_cache = dict(branch_projects._state["cache"])

        def restore():
            with branch_projects._lock:
                branch_projects._state["cache"].clear()
                branch_projects._state["cache"].update(saved_cache)
        self.addCleanup(restore)

        self.real_root = real
        registry = [{"repoRoot": real, "label": self.LABEL, "pipelineDir": str(self.pipeline)}]
        patcher = mock.patch.object(app, "read_project_registry", return_value=registry)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_failed_refresh_is_named_by_failed_labels_and_response_header(self):
        project = {"label": self.LABEL, "repoRoot": self.real_root, "pipelineDir": str(self.pipeline)}
        with mock.patch.object(app, "_list_unmerged_branches_uncached",
                               side_effect=RuntimeError("fetch failed")):
            branch_projects._refresh_stale([project])

        self.assertIn(self.LABEL, branch_projects.failed_project_labels())

        client = app.app.test_client()
        resp = client.get("/api/git/unmerged-branches")
        header = resp.headers.get("X-Branch-Projects-Failed", "")
        self.assertIn(self.LABEL, [label.strip() for label in header.split(",")])


if __name__ == "__main__":
    unittest.main()
