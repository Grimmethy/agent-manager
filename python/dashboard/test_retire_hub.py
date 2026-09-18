"""Tests for the retire-hub server endpoint (POST /api/task/coordinating/<id>/retire-hub).

Retire-Hub lets a human dismiss a coordinating hub wholesale (brain-dump: "no direct
way to archive/dismiss a coord hub"). The UI button (core-ui.js, `retire-hub-btn`)
already ships and calls `postTaskAction(state, id, 'retire-hub')`, which resolves to
this endpoint. The sibling task "Add retire-hub server endpoint" implements the view;
this file pins its contract.

Contract assumptions (documented here so the endpoint implementation and these tests
agree -- see routes/task.py's existing /archive route for the directory conventions):
  - URL:    POST /api/task/coordinating/<coord_id>/retire-hub
  - The hub file (queue/coordinating/<coord_id>.json) is itself moved to a terminal
    archive directory on success, so a SECOND call for the same coord_id 404s
    (idempotency by disappearance, same shape as api_task_archive's FileNotFound 404).
  - Each sub-task listed in the hub's `subTasks` array is moved to a terminal
    directory via _archive_task_file (queue/done/_archived_no_action/<subId>.json is
    the standard target; the dated queue/done/_archived/<YYYY-MM>/ bucket also counts
    as terminal).
  - A sub-task that is ALREADY in a terminal directory is skipped, NOT counted, and
    must not raise.
  - Response body (HTTP 200):
        {
          "id": <coord_id>,
          "archivedChildren": <int -- number of sub-tasks newly moved to a terminal
                              dir; already-terminal sub-tasks are excluded>,
          "fileLocations":    [<queue-dir-relative POSIX path of each newly-archived
                               sub-task file, e.g. "done/_archived_no_action/s1.json">]
        }

Run: .venv/bin/python -m pytest python/dashboard/test_retire_hub.py -v
     (or: .venv/bin/python -m unittest python.dashboard.test_retire_hub -v)
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

TERMINAL_DIRS = ("done/_archived_no_action", "done/_archived")


class RetireHubTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_env_path = app.ENV_FILE_PATH
        app.ENV_FILE_PATH = Path(self._tmp.name) / "agent-manager.env"
        self._saved = {k: os.environ.get(k) for k in
                       ("AGENT_MANAGER_REPO_ROOT", "AGENT_MANAGER_PIPELINE_DIR")}
        for k in self._saved:
            os.environ.pop(k, None)
        self.pipeline_dir = Path(self._tmp.name) / "pipeline"
        self.queue_dir = self.pipeline_dir / "queue"
        self.queue_dir.mkdir(parents=True)
        app.ENV_FILE_PATH.write_text(
            f"AGENT_MANAGER_PIPELINE_DIR={self.pipeline_dir}\n", encoding="utf-8")
        self.client = app.app.test_client()

    def tearDown(self):
        app.ENV_FILE_PATH = self._orig_env_path
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    # -- seeding helpers ----------------------------------------------------

    def _seed_hub(self, coord_id, subtask_ids):
        coord_dir = self.queue_dir / "coordinating"
        coord_dir.mkdir(parents=True, exist_ok=True)
        (coord_dir / f"{coord_id}.json").write_text(json.dumps({
            "id": coord_id,
            "title": "a coordinating hub under test",
            "status": "coordinating",
            "subTasks": [{"id": sid} for sid in subtask_ids],
        }), encoding="utf-8")

    def _seed_subtask(self, state, sub_id):
        state_dir = self.queue_dir / state
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / f"{sub_id}.json").write_text(json.dumps({
            "id": sub_id,
            "title": f"sub-task {sub_id} under test",
            "status": "pending",
        }), encoding="utf-8")

    def _seed_terminal_subtask(self, sub_id, bucket="done/_archived_no_action"):
        d = self.queue_dir / bucket
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{sub_id}.json").write_text(json.dumps({
            "id": sub_id,
            "title": f"sub-task {sub_id}, already terminal",
            "status": "done",
        }), encoding="utf-8")

    def _subtask_file(self, sub_id):
        """Absolute path of sub_id's file wherever it currently sits, or None."""
        hits = [p for p in self.queue_dir.rglob(f"{sub_id}.json") if p.is_file()]
        return hits[0] if hits else None

    def _is_terminal(self, sub_id):
        path = self._subtask_file(sub_id)
        if path is None:
            return False
        rel = path.relative_to(self.queue_dir).as_posix()
        return any(rel.startswith(bucket + "/") for bucket in TERMINAL_DIRS)

    # -- the four scenarios ---------------------------------------------------

    def test_happy_path_mixed_subtask_states(self):
        # Hub with 4 sub-tasks in mixed states: 2 live in queue states, 1 live in
        # another state, 1 already terminal. The 3 live ones must be archived; the
        # terminal one skipped.
        self._seed_hub("hub-mixed", ["s-pending", "s-review", "s-approved", "s-already-done"])
        self._seed_subtask("pending", "s-pending")
        self._seed_subtask("review", "s-review")
        self._seed_subtask("approved", "s-approved")
        self._seed_terminal_subtask("s-already-done")

        resp = self.client.post("/api/task/coordinating/hub-mixed/retire-hub")
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        body = resp.get_json()

        # Only the 3 newly-moved sub-tasks count, not the already-terminal one.
        self.assertEqual(body["archivedChildren"], 3)
        self.assertEqual(len(body["fileLocations"]), 3)

        # Each newly-archived child reports a concrete terminal-directory location.
        locations = {p for p in body["fileLocations"]}
        for sub_id in ("s-pending", "s-review", "s-approved"):
            rel = f"done/_archived_no_action/{sub_id}.json"
            self.assertIn(rel, locations, f"{sub_id} missing from {locations!r}")
            # ...and the move actually happened on disk, out of its live state dir.
            self.assertNotIn(self.queue_dir / "pending" / f"{sub_id}.json",
                             [p.resolve() for p in self.queue_dir.rglob(f"{sub_id}.json")])
            self.assertTrue(self._is_terminal(sub_id),
                            f"{sub_id} not in a terminal dir after retire-hub")
        # The already-terminal sub-task stayed put and is not double-counted.
        self.assertEqual(
            len([p for p in self.queue_dir.rglob("s-already-done.json") if p.is_file()]), 1)

    def test_second_call_returns_404(self):
        # Idempotency: the first call retires the hub (file moves to a terminal dir),
        # so the second call for the same coord id must 404, not 500 or re-archive.
        self._seed_hub("hub-once", ["s-one"])
        self._seed_subtask("pending", "s-one")

        first = self.client.post("/api/task/coordinating/hub-once/retire-hub")
        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        self.assertEqual(first.get_json()["archivedChildren"], 1)
        self.assertEqual(first.get_json()["fileLocations"],
                         ["done/_archived_no_action/s-one.json"])

        second = self.client.post("/api/task/coordinating/hub-once/retire-hub")
        self.assertEqual(second.status_code, 404)
        # The hub file must exist exactly once in a terminal dir -- no duplicates.
        hubs = [p for p in self.queue_dir.rglob("hub-once.json") if p.is_file()]
        self.assertEqual(len(hubs), 1)
        self.assertTrue(any(p.relative_to(self.queue_dir).as_posix().startswith(b + "/")
                            for b in TERMINAL_DIRS for p in hubs))

    def test_empty_subtasks_array(self):
        # A hub with no children at all: retire it gracefully -- 200, zero archived
        # children, empty locations, no stray files created anywhere.
        self._seed_hub("hub-empty", [])

        resp = self.client.post("/api/task/coordinating/hub-empty/retire-hub")
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        body = resp.get_json()
        self.assertEqual(body["archivedChildren"], 0)
        self.assertEqual(body["fileLocations"], [])

        # The hub itself still retired; only the hub file may exist on disk.
        self.assertEqual(len([p for p in self.queue_dir.rglob("*.json") if p.is_file()]), 1)
        self.assertTrue(self._is_hub_terminal())

    def test_terminal_subtask_is_skipped(self):
        # Both sub-tasks are already terminal: nothing to move, archivedChildren is 0,
        # and the endpoint must not raise or duplicate the existing terminal files.
        self._seed_hub("hub-terminal", ["t-done", "t-dated"])
        self._seed_terminal_subtask("t-done", bucket="done/_archived_no_action")
        self._seed_terminal_subtask("t-dated", bucket="done/_archived/2026-09")

        resp = self.client.post("/api/task/coordinating/hub-terminal/retire-hub")
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        body = resp.get_json()
        self.assertEqual(body["archivedChildren"], 0,
                         "already-terminal sub-tasks must be skipped, not counted")
        self.assertEqual(body["fileLocations"], [])

        # No duplicate moves: each terminal sub-task file still exists exactly once,
        # in the SAME terminal bucket it started in.
        for sub_id, bucket in (("t-done", "done/_archived_no_action"),
                              ("t-dated", "done/_archived/2026-09")):
            paths = [p.relative_to(self.queue_dir).as_posix()
                     for p in self.queue_dir.rglob(f"{sub_id}.json") if p.is_file()]
            self.assertEqual(paths, [f"{bucket}/{sub_id}.json"],
                             f"{sub_id} unexpectedly moved or duplicated: {paths}")

    # -- tiny extra helper ----------------------------------------------------

    def _is_hub_terminal(self):
        hubs = [p for p in self.queue_dir.rglob("hub-empty.json") if p.is_file()]
        return len(hubs) == 1 and any(
            p.relative_to(self.queue_dir).as_posix().startswith(b + "/")
            for b in TERMINAL_DIRS for p in hubs)


if __name__ == "__main__":
    unittest.main()
