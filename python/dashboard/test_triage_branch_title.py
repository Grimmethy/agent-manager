"""The Unmerged Branches title for a rolling candidate-doc branch is the BRANCH total, not the tip commit's "1" (brain-dump #1755, 2026-10-03).

The rolling agent/triage-queue branch has no task record, so its card/detail title fell back to the tip commit's subject, and every commit says
"Triage batch: 1 candidate-doc update(s)" (one task per apply tick). Now the title counts the `### AC-` candidates the branch adds against the default
branch. Real bare origin + clone, same fixture shape as test_unmerged_squash_merged.py.

Run: .venv/bin/python -m unittest python.dashboard.test_triage_branch_title -v
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import branch_removals  # noqa: E402

TRIAGE_SUBJECT = "Triage batch: 1 candidate-doc update(s)"
DOC = "Docs/X_CANDIDATES.md"


def _git(args, cwd):
    return subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True).stdout


def make_repo():
    root = Path(tempfile.mkdtemp())
    bare, repo = root / "origin.git", root / "repo"
    _git(["init", "--bare", "-b", "main", str(bare)], cwd=root)
    _git(["clone", str(bare), str(repo)], cwd=root)
    _git(["config", "user.email", "t@example.com"], cwd=repo)
    _git(["config", "user.name", "T"], cwd=repo)
    (repo / "README.md").write_text("base\n")
    _git(["add", "-A"], cwd=repo)
    _git(["commit", "-q", "-m", "initial"], cwd=repo)
    _git(["push", "-q", "origin", "main"], cwd=repo)
    return repo


def candidate(n, title="Remove unused thing", files="src/a.ts"):
    return f"\n### AC-{n} · {title} {n}\nStrength: Strong\nFiles: {files}\n\nProblem:\np\n"


def commit_on_branch(repo, branch, subject, rel, text, first=False):
    if first:
        _git(["checkout", "-q", "-b", branch], cwd=repo)
    else:
        _git(["checkout", "-q", branch], cwd=repo)
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a") as fh:
        fh.write(text)
    _git(["add", "-A"], cwd=repo)
    _git(["commit", "-q", "-m", subject], cwd=repo)
    _git(["push", "-q", "-u", "origin", branch], cwd=repo)
    _git(["checkout", "-q", "main"], cwd=repo)


def triage_branch(repo, counts=(1, 1, 1), branch="agent/triage-queue"):
    """One commit per entry of `counts`, each adding that many candidates, every subject 'Triage batch: 1 ...'."""
    n = 0
    for i, c in enumerate(counts):
        text = "".join(candidate(n + k + 1) for k in range(c))
        n += c
        commit_on_branch(repo, branch, TRIAGE_SUBJECT, DOC, text, first=(i == 0))


class TestTriageBranchTitle(unittest.TestCase):
    def setUp(self):
        app._invalidate_branch_cache()
        self._env = mock.patch.dict(os.environ, {"AGENT_MANAGER_BRANCH_TITLE_COUNT": ""})
        self._env.start()

    def tearDown(self):
        self._env.stop()
        app._invalidate_branch_cache()

    def listed(self, repo, pipeline_dir=None):
        patches = [mock.patch.object(app, "get_active_repo_root", return_value=str(repo)),
                   mock.patch.object(app, "get_pipeline_dir", return_value=pipeline_dir or repo)]
        for p in patches:
            p.start()
        try:
            return {b["branch"]: b for b in app.list_unmerged_branches(force=True)}
        finally:
            for p in patches:
                p.stop()

    def test_three_single_candidate_commits_list_as_three_and_keep_the_raw_subject(self):
        repo = make_repo()
        triage_branch(repo, counts=(1, 1, 1))
        b = self.listed(repo)["agent/triage-queue"]
        self.assertEqual(b["title"], "Triage batch: 3 candidate-doc update(s)")
        self.assertEqual(b["candidateCount"], 3)
        self.assertEqual(b["subject"], TRIAGE_SUBJECT, "the raw tip subject is unchanged")
        self.assertEqual(b["ahead"], 3)

    def test_a_commit_that_adds_two_candidates_counts_both_not_commits(self):
        repo = make_repo()
        triage_branch(repo, counts=(2, 1))
        b = self.listed(repo)["agent/triage-queue"]
        self.assertEqual(b["candidateCount"], 3)
        self.assertEqual(b["title"], "Triage batch: 3 candidate-doc update(s)")
        self.assertEqual(b["ahead"], 2, "two commits, three candidates")

    def test_a_branch_whose_subject_is_not_a_triage_batch_keeps_its_title(self):
        repo = make_repo()
        commit_on_branch(repo, "agent/other-work", "Add a feature", DOC, candidate(1) + candidate(2), first=True)
        b = self.listed(repo)["agent/other-work"]
        self.assertEqual(b["title"], "Add a feature")
        self.assertNotIn("candidateCount", b)

    def test_a_triage_style_subject_that_adds_no_candidate_heading_keeps_the_subject(self):
        repo = make_repo()
        commit_on_branch(repo, "agent/triage-queue", TRIAGE_SUBJECT, "notes/readme.md", "just prose, no candidate\n", first=True)
        b = self.listed(repo)["agent/triage-queue"]
        self.assertEqual(b["title"], TRIAGE_SUBJECT)
        self.assertNotIn("candidateCount", b)

    def test_a_branch_with_a_matching_task_record_keeps_the_tasks_title(self):
        repo = make_repo()
        pipe = Path(tempfile.mkdtemp())
        (pipe / "queue" / "done").mkdir(parents=True)
        (pipe / "queue" / "done" / "some-task.json").write_text(json.dumps({"id": "some-task", "title": "The real task title", "domain": "adhoc", "source": "manual"}))
        commit_on_branch(repo, "agent/some-task", TRIAGE_SUBJECT, DOC, candidate(1) + candidate(2), first=True)
        b = self.listed(repo, pipeline_dir=pipe)["agent/some-task"]
        self.assertEqual(b["title"], "The real task title")
        self.assertNotIn("candidateCount", b)

    def test_the_kill_switch_keeps_the_old_title(self):
        repo = make_repo()
        triage_branch(repo, counts=(1, 1))
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_BRANCH_TITLE_COUNT": "false"}):
            b = self.listed(repo)["agent/triage-queue"]
        self.assertEqual(b["title"], TRIAGE_SUBJECT)
        self.assertNotIn("candidateCount", b)

    def test_a_git_failure_while_counting_keeps_the_old_title(self):
        repo = make_repo()
        triage_branch(repo, counts=(1, 1))
        with mock.patch("branch_removals.count_added_candidates", return_value=None):
            b = self.listed(repo)["agent/triage-queue"]
        self.assertEqual(b["title"], TRIAGE_SUBJECT)
        self.assertNotIn("candidateCount", b)
        app._invalidate_branch_cache()
        with mock.patch("branch_removals.count_added_candidates", side_effect=RuntimeError("boom")):
            b = self.listed(repo)["agent/triage-queue"]
        self.assertEqual(b["title"], TRIAGE_SUBJECT)


class TestCountAddedCandidates(unittest.TestCase):
    def test_counts_added_headings_ignoring_removed_lines_and_non_markdown_files(self):
        repo = make_repo()
        triage_branch(repo, counts=(2, 1))
        _git(["checkout", "-q", "agent/triage-queue"], cwd=repo)
        (repo / "src").mkdir(exist_ok=True)
        (repo / "src" / "code.js").write_text("### AC-99 · not markdown\n")
        _git(["add", "-A"], cwd=repo)
        _git(["commit", "-q", "-m", "code"], cwd=repo)
        _git(["checkout", "-q", "main"], cwd=repo)
        run_git = app._run_git
        self.assertEqual(branch_removals.count_added_candidates(run_git, repo, "main", "origin/agent/triage-queue"), 3, "the .js heading is not counted")

    def test_returns_none_when_git_fails_and_never_raises(self):
        def boom(*a, **k):
            raise RuntimeError("git exploded")
        self.assertIsNone(branch_removals.count_added_candidates(boom, "/nowhere", "main", "origin/x"))
        self.assertIsNone(branch_removals.count_added_candidates(app._run_git, "/definitely/not/a/repo", "main", "origin/x"))

    def test_parse_added_candidates_matches_what_snapshot_branch_reports_for_the_same_diff(self):
        repo = make_repo()
        triage_branch(repo, counts=(2, 2))
        diff = _git(["diff", "--unified=0", "origin/main...origin/agent/triage-queue", "--", "*.md"], cwd=repo)
        parsed = branch_removals.parse_added_candidates(diff)
        snap = branch_removals.snapshot_branch(app._run_git, repo, "main", "agent/triage-queue", None, None)
        self.assertEqual(len(parsed), 4)
        self.assertEqual(snap["candidatesTotal"], len(parsed))
        self.assertEqual(snap["candidates"], parsed[:branch_removals.MAX_CANDIDATES])
        self.assertEqual(parsed[0]["files"], "src/a.ts", "the Files: line attaches to its heading")

    def test_a_files_line_does_not_attach_across_files(self):
        diff = "+++ b/Docs/A.md\n+### AC-1 · First\n+++ b/Docs/B.md\n+Files: stray.ts\n"
        out = branch_removals.parse_added_candidates(diff)
        self.assertEqual(out, [{"id": "AC-1", "title": "First", "files": ""}])


if __name__ == "__main__":
    unittest.main()
