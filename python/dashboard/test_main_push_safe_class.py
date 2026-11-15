"""The safe diff classes of the main-push gate: a checker worker's `merge` verdict is READY only for a docs-only, tests-only or new-files-only diff that the gate itself re-derives.

Run from python/dashboard: .venv/bin/python -m unittest test_main_push_safe_class
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import main_push_safe_class as safe  # noqa: E402
import main_push_gate as gate  # noqa: E402
from gate_test_support import BRANCH, NOW, SHA, EdgeBase, env_without_bypass, ledger, make_queue, rec  # noqa: E402

CHECKER = [f"{safe.CHECKER_PREFIX} (deterministic): docs-only: every deterministic check passed", "Not checked by this worker: reading the code against the ask."]


class Fx:
    """Fixtures: a checker worker's merge record and a diff-facts dict."""

    @staticmethod
    def worker(**over):
        return rec(**{"source": "worker", "reasons": list(CHECKER), **over})

    @staticmethod
    def facts(cls="docs-only", forbidden=(), files=2):
        return {"class": cls, "files": files, "forbidden": list(forbidden), "base": "origin/master"}


class TestClassify(unittest.TestCase):
    def test_each_class(self):
        self.assertEqual(safe.classify_changes([("A", "docs/a.md"), ("M", "README.md")]), "docs-only")
        self.assertEqual(safe.classify_changes([("A", "src/x.test.js"), ("A", "python/test_y.py")]), "tests-only")
        self.assertEqual(safe.classify_changes([("A", "src/new-module.js"), ("A", "docs/n.md")]), "new-files-only")
        self.assertEqual(safe.classify_changes([("M", "src/x.js")]), "other")
        self.assertEqual(safe.classify_changes([]), "other")

    def test_a_design_or_decision_document_is_never_docs_only(self):
        self.assertEqual(safe.classify_changes([("A", "docs/design-notes/x.md")]), "other")
        self.assertEqual(safe.classify_changes([("A", "docs/adr/0001-x.md")]), "other")

    def test_tests_only_needs_no_deleted_line_and_new_files_only_needs_no_edit(self):
        self.assertEqual(safe.classify_changes([("M", "src/x.test.js")], deletions=0), "tests-only")
        self.assertEqual(safe.classify_changes([("M", "src/x.test.js")], deletions=3), "other")
        self.assertEqual(safe.classify_changes([("A", "src/new.js"), ("M", "src/old.js")]), "other")
        self.assertEqual(safe.classify_changes([("A", "src/new.js"), ("D", "src/old.js")]), "other")

    def test_forbidden_paths_added_or_changed_are_listed_but_a_deletion_is_not(self):
        changes = [("A", "node_modules"), ("M", "config/plugins.json"), ("A", "src/ok.js"), ("D", "queue/pending/x.json"), ("A", "keys/id_rsa")]
        self.assertEqual(safe.forbidden_changed(changes), ["node_modules", "config/plugins.json", "keys/id_rsa"])


class TestReadDiffFacts(unittest.TestCase):
    """The real git reader, on a throwaway repository whose `origin/master` ref is the base."""

    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="safe-class-"))
        self.git("init", "-q", "-b", "master")
        self.git("config", "user.email", "t@example.invalid")
        self.git("config", "user.name", "t")
        (self.repo / "a.js").write_text("one\ntwo\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "base")
        self.git("update-ref", "refs/remotes/origin/master", "HEAD")
        self.git("checkout", "-q", "-b", "feature")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True, text=True).stdout

    @staticmethod
    def run_git(args, cwd):
        out = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
        if out.returncode:
            raise RuntimeError(out.stderr)
        return out.stdout

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "change")
        return self.git("rev-parse", "HEAD").strip()

    def test_a_docs_only_branch_and_a_new_files_branch(self):
        (self.repo / "docs").mkdir()
        (self.repo / "docs" / "n.md").write_text("hello\n")
        got = safe.read_diff_facts(self.run_git, self.repo, self.commit())
        self.assertEqual((got["class"], got["files"], got["forbidden"], got["base"]), ("docs-only", 1, [], "origin/master"))
        (self.repo / "lib.js").write_text("x\n")
        self.assertEqual(safe.read_diff_facts(self.run_git, self.repo, self.commit())["class"], "new-files-only")

    def test_a_deleted_line_in_a_test_file_makes_it_other(self):
        (self.repo / "a.test.js").write_text("one\ntwo\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "t")
        self.git("update-ref", "refs/remotes/origin/master", "HEAD")
        (self.repo / "a.test.js").write_text("one\n")
        self.assertEqual(safe.read_diff_facts(self.run_git, self.repo, self.commit())["class"], "other")

    def test_a_forbidden_path_is_reported_and_an_unreadable_head_raises(self):
        (self.repo / ".venv").write_text("x")
        self.assertEqual(safe.read_diff_facts(self.run_git, self.repo, self.commit())["forbidden"], [".venv"])
        with self.assertRaises(RuntimeError):
            safe.read_diff_facts(self.run_git, self.repo, "f" * 40)


class TestRules(unittest.TestCase):
    def check(self, q, loader, branch=BRANCH, sha=SHA):
        return gate.assert_main_push_ready(q, branch, sha, caller="t", task_id="T1", now=NOW, diff_facts_loader=loader)

    def test_a_checker_merge_for_each_safe_class_passes_and_writes_one_audit_row(self):
        for cls in safe.SAFE_WORKER_CLASSES:
            q = make_queue({BRANCH: {SHA: Fx.worker()}})
            with env_without_bypass():
                self.assertEqual(self.check(q, lambda c=cls: Fx.facts(c)), {"allowed": True, "bypass": False, "viaClass": cls})
            row = ledger(q)
            self.assertEqual([(r["outcome"], r["class"], r["files"], r["caller"], r["headSha"]) for r in row], [("allowed-worker-class", cls, 2, "t", SHA)])

    def test_a_class_other_or_a_forbidden_path_is_refused_with_the_reason(self):
        for fx, text in ((Fx.facts("other"), "class is 'other'"), (Fx.facts("docs-only", ["node_modules"]), "forbidden paths: node_modules")):
            q = make_queue({BRANCH: {SHA: Fx.worker()}})
            with env_without_bypass(), self.assertRaisesRegex(gate.MainPushNotReady, text):
                self.check(q, lambda f=fx: f)
            self.assertEqual([r["outcome"] for r in ledger(q)], ["refused"])

    def test_a_worker_merge_without_the_checker_text_or_without_a_loader_is_refused_as_before(self):
        q = make_queue({BRANCH: {SHA: rec(source="worker")}})
        with env_without_bypass(), self.assertRaisesRegex(gate.MainPushNotReady, "not a human source"):
            self.check(q, lambda: Fx.facts())
        q = make_queue({BRANCH: {SHA: Fx.worker()}})
        with env_without_bypass(), self.assertRaisesRegex(gate.MainPushNotReady, "not a human source"):
            self.check(q, None)

    def test_an_unreadable_diff_fails_closed(self):
        def boom():
            raise RuntimeError("git exploded")
        q = make_queue({BRANCH: {SHA: Fx.worker()}})
        with env_without_bypass(), self.assertRaisesRegex(gate.MainPushNotReady, "could not be read"):
            self.check(q, boom)

    def test_only_the_checker_worker_source_qualifies(self):
        q = make_queue({BRANCH: {SHA: Fx.worker(source="deterministic")}})
        with env_without_bypass(), self.assertRaisesRegex(gate.MainPushNotReady, "not a human source"):
            self.check(q, lambda: Fx.facts())

    def test_a_human_verdict_never_calls_the_loader(self):
        q = make_queue({BRANCH: {SHA: rec(source="chat")}})
        calls = []
        with env_without_bypass():
            self.assertEqual(self.check(q, lambda: calls.append(1) or Fx.facts()), {"allowed": True, "bypass": False})
        self.assertEqual((calls, ledger(q)), ([], []))


class TestEdge(EdgeBase):
    """The merge route hook reads the diff through the gate's own git calls."""

    def fake_git(self, args, cwd, timeout=30):
        self.git_calls.append(list(args))
        if args[0] == "rev-parse" and "--verify" not in args:
            return self.head + "\n"
        if args[0] == "symbolic-ref":
            return "origin/master\n"
        if args[:2] == ["diff", "--name-status"]:
            return self.changes
        if args[:2] == ["diff", "--numstat"]:
            return self.numstat
        return ""

    def test_a_checker_merge_for_a_docs_only_diff_lets_the_route_run(self):
        self.changes, self.numstat = "A\tdocs/x.md\n", "3\t0\tdocs/x.md\n"
        self.record({BRANCH: {SHA: Fx.worker()}})
        resp, listing = self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertNotEqual(resp.status_code, 409)
        listing.assert_called()
        self.assertEqual(ledger(self.qdir)[0]["outcome"], "allowed-worker-class")

    def test_a_checker_merge_for_a_source_edit_is_refused(self):
        self.changes, self.numstat = "M\tsrc/x.js\n", "3\t1\tsrc/x.js\n"
        self.record({BRANCH: {SHA: Fx.worker()}})
        resp, listing = self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual(resp.status_code, 409)
        self.assertIn("class is 'other'", resp.get_json()["reason"])
        listing.assert_not_called()


if __name__ == "__main__":
    unittest.main()
