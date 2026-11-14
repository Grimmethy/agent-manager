"""Archive and requeue act on the project a request names (?project=<repoRoot>), 2026-11-02.

Before: api_task_archive and api_task_requeue used the ACTIVE project's queue only, so a cross-project worker (the stalled-task worker) could not
archive or requeue another project's task without switching the active project, which restarts pipelines. Now `?project=` (or body.project)
selects another registered project exactly like the hub and branch routes do (_qdir_for_request); an unregistered project is a 404 and never
falls back to the active one; with no project nothing changes. Everything the requeue does beyond moving the file (the superseded-branch
delete, the requeue attribution record) uses that project's repo and pipeline dir, not the active one.

Run: .venv/bin/python -m unittest python.dashboard.test_task_project_scope -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import branch_projects  # noqa: E402
from routes import task as task_routes  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        root = Path(tempfile.mkdtemp())
        self.active_pipe, self.other_pipe = root / "active-pipe", root / "other-pipe"
        self.active_q, self.other_q = self.active_pipe / "queue", self.other_pipe / "queue"
        self.other_repo = root / "other-repo"
        self.other_repo.mkdir()
        self.active_repo = root / "active-repo"
        self.active_repo.mkdir()
        self.scope = {"label": "other", "repoRoot": str(self.other_repo), "pipelineDir": str(self.other_pipe), "repoPath": self.other_repo, "qdir": self.other_q}
        self.client = app.app.test_client()

        def resolve(project_root, active_root):
            if not project_root or project_root == str(self.active_repo):
                return None
            if project_root == str(self.other_repo):
                return self.scope
            raise LookupError(f"'{project_root}' is not a registered project")
        for p in (mock.patch.object(app, "queue_dir", return_value=self.active_q),
                  mock.patch.object(app, "get_active_repo_root", return_value=str(self.active_repo)),
                  mock.patch.object(branch_projects, "resolve_scope", side_effect=resolve)):
            p.start()
            self.addCleanup(p.stop)

    def put(self, qdir, state, task_id, **extra):
        d = qdir / state
        d.mkdir(parents=True, exist_ok=True)
        rec = {"id": task_id, "source": "arch_review", "domain": "default", "status": "blocked", "blockedReason": "x",
               "history": [{"stage": "created", "at": "x"}], **extra}
        (d / f"{task_id}.json").write_text(json.dumps(rec))

    def has(self, qdir, *parts):
        return (qdir.joinpath(*parts)).is_file()


class Archive(Base):
    def test_archive_with_project_moves_the_file_in_that_projects_queue_only(self):
        self.put(self.other_q, "blocked", "t1")
        self.put(self.active_q, "blocked", "t1")              # same id in the active project must not be touched
        r = self.client.post("/api/task/blocked/t1/archive", query_string={"project": str(self.other_repo)}, json={"reason": "duplicate of x"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(self.has(self.other_q, "done", "_archived_no_action", "t1.json"))
        self.assertFalse(self.has(self.other_q, "blocked", "t1.json"))
        self.assertTrue(self.has(self.active_q, "blocked", "t1.json"))
        self.assertFalse(self.has(self.active_q, "done", "_archived_no_action", "t1.json"))
        rec = json.loads((self.other_q / "done" / "_archived_no_action" / "t1.json").read_text())
        self.assertEqual((rec["terminalDisposition"], rec["manualArchive"]["reason"]), ("abandoned", "duplicate of x"))

    def test_project_may_come_in_the_json_body(self):
        self.put(self.other_q, "needs-clarification", "t2")
        r = self.client.post("/api/task/needs-clarification/t2/archive", json={"project": str(self.other_repo), "reason": "r"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(self.has(self.other_q, "done", "_archived_no_action", "t2.json"))

    def test_unknown_project_is_404_and_never_falls_back_to_the_active_project(self):
        self.put(self.active_q, "blocked", "t3")
        r = self.client.post("/api/task/blocked/t3/archive", query_string={"project": "/nowhere"})
        self.assertEqual(r.status_code, 404)
        self.assertTrue(self.has(self.active_q, "blocked", "t3.json"))

    def test_without_a_project_the_active_queue_is_used_as_before(self):
        self.put(self.active_q, "blocked", "t4")
        self.put(self.other_q, "blocked", "t4")
        r = self.client.post("/api/task/blocked/t4/archive", json={"reason": "r"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(self.has(self.active_q, "done", "_archived_no_action", "t4.json"))
        self.assertTrue(self.has(self.other_q, "blocked", "t4.json"))

    def test_a_task_that_is_only_in_the_other_project_is_404_for_the_active_one(self):
        self.put(self.other_q, "blocked", "t5")
        self.assertEqual(self.client.post("/api/task/blocked/t5/archive").status_code, 404)


class Requeue(Base):
    def setUp(self):
        super().setUp()
        attr = mock.patch.object(app, "_record_manual_requeue")
        self.attr = attr.start()
        self.addCleanup(attr.stop)

    def test_requeue_with_project_writes_pending_in_that_project_and_keeps_stacked_and_history(self):
        self.put(self.other_q, "blocked", "r1", stacked={"branch": "agent/decompose-x", "seq": 2, "total": 3}, dependsOn=["r0"])
        r = self.client.post("/api/task/blocked/r1/requeue", query_string={"project": str(self.other_repo)}, json={"force": True})
        self.assertEqual(r.status_code, 200)
        rec = json.loads((self.other_q / "pending" / "r1.json").read_text())
        self.assertEqual(rec["stacked"]["seq"], 2)
        self.assertEqual(rec["dependsOn"], ["r0"])
        self.assertEqual(rec["history"][-1]["stage"], "requeued")
        self.assertFalse(self.has(self.active_q, "pending", "r1.json"))
        self.attr.assert_called_once()
        self.assertEqual(self.attr.call_args.kwargs["pipeline_dir"], str(self.other_pipe))

    def test_requeue_without_project_attributes_to_the_active_pipeline(self):
        self.put(self.active_q, "blocked", "r2")
        self.assertEqual(self.client.post("/api/task/blocked/r2/requeue", json={"force": True}).status_code, 200)
        self.assertTrue(self.has(self.active_q, "pending", "r2.json"))
        self.assertIsNone(self.attr.call_args.kwargs["pipeline_dir"])

    def test_requeue_unknown_project_is_404_and_leaves_both_queues_alone(self):
        self.put(self.active_q, "blocked", "r3")
        self.put(self.other_q, "blocked", "r3")
        r = self.client.post("/api/task/blocked/r3/requeue", query_string={"project": "/nowhere"}, json={"force": True})
        self.assertEqual(r.status_code, 404)
        self.assertTrue(self.has(self.active_q, "blocked", "r3.json") and self.has(self.other_q, "blocked", "r3.json"))
        self.assertFalse(self.has(self.active_q, "pending", "r3.json") or self.has(self.other_q, "pending", "r3.json"))

    def test_requeue_of_an_applied_unmerged_task_deletes_the_branch_in_the_named_projects_repo(self):
        hist = [{"stage": "created", "at": "x"}, {"stage": "applied", "at": "x", "detail": "agent/r4"}]
        self.put(self.other_q, "blocked", "r4", history=hist)
        git_calls = []
        with mock.patch.object(app, "_run_git", side_effect=lambda args, cwd: git_calls.append((args, str(cwd)))), \
                mock.patch.object(task_routes, "_shared_branch_siblings", return_value={"siblings": []}), \
                mock.patch.object(branch_projects, "after_action") as after, \
                mock.patch.object(app, "_invalidate_branch_cache") as inval, \
                mock.patch("branch_removals.record_branch_removal") as rec_removal:
            r = self.client.post("/api/task/blocked/r4/requeue", query_string={"project": str(self.other_repo)}, json={"force": True})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(git_calls, [(["push", "origin", "--delete", "agent/r4"], str(self.other_repo))])   # that project's repo, not the active one
        after.assert_called_once_with(self.scope)
        inval.assert_not_called()
        self.assertEqual(rec_removal.call_args.args[0], self.other_q)


if __name__ == "__main__":
    unittest.main()
