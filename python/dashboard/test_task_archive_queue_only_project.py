"""The archive route also reaches a registered project whose repo root is not its own git repo (2026-11-13).

Before: `?project=<repoRoot>` went through branch_projects.resolve_scope, which drops every registry entry without a `.git` (branch actions run git), so TaxHarvest
(repoRoot a subfolder of another repo, pipelineDir /media/wok/model-cache/taxharvest-pipeline) answered 404 "not a registered project" and 117 duplicate wiki tasks could
not be archived through the route. Now api_task_archive falls back to branch_projects.resolve_queue_dir (registry entry with a pipelineDir, realpath match). Every other
route keeps the git-repo requirement, and an unregistered project is still a 404 that never falls back to the active one.

Run: .venv/bin/python -m unittest test_task_archive_queue_only_project -v   (from python/dashboard)
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TestArchiveQueueOnlyProject(unittest.TestCase):
    def setUp(self):
        root = Path(tempfile.mkdtemp())
        self.active_repo = root / "active-repo"
        self.active_repo.mkdir()
        (self.active_repo / ".git").mkdir()
        self.active_q = root / "active-pipe" / "queue"
        self.other_repo = root / "parent-repo" / "sub-project"     # a subfolder: no .git of its own
        self.other_repo.mkdir(parents=True)
        self.other_pipe = root / "other-pipe"
        self.other_q = self.other_pipe / "queue"
        self.registry = [{"repoRoot": str(self.other_repo), "pipelineDir": str(self.other_pipe), "label": "sub"}]
        self.client = app.app.test_client()
        for p in (mock.patch.object(app, "queue_dir", return_value=self.active_q),
                  mock.patch.object(app, "get_active_repo_root", return_value=str(self.active_repo)),
                  mock.patch.object(app, "read_project_registry", side_effect=lambda: self.registry)):
            p.start()
            self.addCleanup(p.stop)

    def put(self, qdir, state, task_id, **extra):
        d = qdir / state
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{task_id}.json").write_text(json.dumps({"id": task_id, "source": "wiki_transcript_extract", "status": "pending",
                                                       "history": [{"stage": "created", "at": "x"}], **extra}))

    def archived(self, qdir, task_id):
        return json.loads((qdir / "done" / "_archived_no_action" / f"{task_id}.json").read_text())

    def test_a_non_git_registered_project_is_archived_in_its_own_queue_only(self):
        self.put(self.other_q, "pending", "t1")
        self.put(self.active_q, "pending", "t1")      # same id in the active project must not be touched
        r = self.client.post("/api/task/pending/t1/archive", query_string={"project": str(self.other_repo)}, json={"reason": "duplicate of the home copy"})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(r.get_json(), {"id": "t1", "archived": True, "disposition": "abandoned"})
        rec = self.archived(self.other_q, "t1")
        self.assertEqual(rec["terminalDisposition"], "abandoned")
        self.assertEqual(rec["manualArchive"]["reason"], "duplicate of the home copy")
        self.assertFalse((self.other_q / "pending" / "t1.json").exists())
        self.assertTrue((self.active_q / "pending" / "t1.json").is_file())
        self.assertFalse((self.active_q / "done" / "_archived_no_action" / "t1.json").exists())

    def test_a_symlinked_spelling_of_the_root_matches_in_both_directions(self):
        link = self.other_repo.parent.parent / "alias"
        os.symlink(self.other_repo, link)
        self.put(self.other_q, "pending", "t2")
        r = self.client.post("/api/task/pending/t2/archive", query_string={"project": str(link)})        # registry holds the real path
        self.assertEqual(r.status_code, 200)
        self.registry = [{"repoRoot": str(link), "pipelineDir": str(self.other_pipe), "label": "sub"}]     # registry holds the link
        self.put(self.other_q, "pending", "t3")
        r = self.client.post("/api/task/pending/t3/archive", query_string={"project": str(self.other_repo)})
        self.assertEqual(r.status_code, 200)

    def test_an_unregistered_project_is_404_and_nothing_moves(self):
        self.put(self.active_q, "pending", "t4")
        r = self.client.post("/api/task/pending/t4/archive", query_string={"project": "/nowhere/at/all"})
        self.assertEqual(r.status_code, 404)
        self.assertTrue((self.active_q / "pending" / "t4.json").is_file())

    def test_a_registry_entry_without_a_pipeline_dir_is_404(self):
        self.registry = [{"repoRoot": str(self.other_repo), "label": "sub"}]
        self.put(self.other_q, "pending", "t5")
        r = self.client.post("/api/task/pending/t5/archive", query_string={"project": str(self.other_repo)})
        self.assertEqual(r.status_code, 404)
        self.assertTrue((self.other_q / "pending" / "t5.json").is_file())

    def test_the_active_project_by_realpath_still_archives_in_the_active_queue(self):
        self.put(self.active_q, "pending", "t6")
        r = self.client.post("/api/task/pending/t6/archive", query_string={"project": str(self.active_repo)})
        self.assertEqual(r.status_code, 200)
        self.assertTrue((self.active_q / "done" / "_archived_no_action" / "t6.json").is_file())

    def test_requeue_still_needs_a_git_repo_project(self):
        self.put(self.other_q, "blocked", "t7", status="blocked")
        r = self.client.post("/api/task/blocked/t7/requeue", query_string={"project": str(self.other_repo)})
        self.assertEqual(r.status_code, 404)
        self.assertTrue((self.other_q / "blocked" / "t7.json").is_file())


if __name__ == "__main__":
    unittest.main()
