"""Tests for the /api/brain-dump/* write routes (routes/brain_dump.py).

Regression guard for 2026-09-10: the `cfda6720` decompose that split /api/brain-dump/*
out of app.py into routes/brain_dump.py moved the view bodies but not their
`from datetime import datetime, timezone` / `import json` imports, so every write route
that stamps a timestamp (capture, edit-on-text-change, prioritize) raised an unhandled
`NameError: name 'datetime' is not defined` -> HTTP 500. GET /api/brain-dump was
unaffected (no timestamp), which is why the break went unnoticed.

Uses the same ENV_FILE_PATH-override pattern as test_concepts_routes.py to point
get_pipeline_dir() / brain_dump_path() at an isolated tmpdir, driving the routes through
Flask's own test_client().

Run: .venv/bin/python -m unittest python.dashboard.test_brain_dump_routes -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class BrainDumpWriteRoutesTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_env_path = app.ENV_FILE_PATH
        app.ENV_FILE_PATH = Path(self._tmp.name) / "agent-manager.env"
        self._saved = {k: os.environ.get(k) for k in
                       ("AGENT_MANAGER_REPO_ROOT", "AGENT_MANAGER_PIPELINE_DIR",
                        "AGENT_MANAGER_BRAIN_DUMP_PATH")}
        for k in self._saved:
            os.environ.pop(k, None)
        self.pipeline_dir = Path(self._tmp.name) / "pipeline"
        self.pipeline_dir.mkdir(parents=True, exist_ok=True)
        app.ENV_FILE_PATH.write_text(
            f"AGENT_MANAGER_PIPELINE_DIR={self.pipeline_dir}\n", encoding="utf-8")
        self.brain_dump = self.pipeline_dir / "brain-dump.json"
        self.client = app.app.test_client()

    def tearDown(self):
        app.ENV_FILE_PATH = self._orig_env_path
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _entries(self):
        return json.loads(self.brain_dump.read_text(encoding="utf-8"))["entries"]

    def _seed(self, entries):
        self.brain_dump.write_text(json.dumps({"entries": entries}), encoding="utf-8")

    def test_capture_appends_a_captured_entry(self):
        resp = self.client.post("/api/brain-dump/capture", json={"text": "a fresh idea"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        entry = resp.get_json()
        self.assertEqual(entry["status"], "captured")
        self.assertEqual(entry["rawText"], "a fresh idea")
        self.assertEqual(entry["serial"], 1)
        self.assertTrue(entry["id"].startswith("bd-"))
        self.assertIn("T", entry["capturedAt"])  # ISO timestamp actually rendered
        self.assertEqual(len(self._entries()), 1)

    def test_capture_increments_serial_over_existing_entries(self):
        self._seed([{"id": "bd-old", "serial": 7, "rawText": "x", "status": "sorted"}])
        resp = self.client.post("/api/brain-dump/capture", json={"text": "next"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        self.assertEqual(resp.get_json()["serial"], 8)

    # AC-55, 2026-09-25: a stray non-dict scalar in the entries list (e.g. from a hand-edit
    # of brain-dump.json) used to crash next_serial's computation with an unguarded
    # `.get("serial")` -- Test A reproduces the exact failure scenario the task named;
    # Test B (identical to test_capture_increments_serial_over_existing_entries above)
    # confirms the guard doesn't change behavior for well-formed entries.
    def test_capture_test_a_survives_a_stray_non_dict_entry_the_exact_ac55_failure_scenario(self):
        self._seed([42, {"id": "bd-1", "serial": 1, "capturedAt": "2026-01-01T00:00:00+00:00",
                          "rawText": "hello", "status": "captured"}])
        resp = self.client.post("/api/brain-dump/capture", json={"text": "new thought"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        self.assertEqual(resp.get_json()["serial"], 2)

    def test_capture_test_b_still_increments_correctly_with_only_well_formed_entries(self):
        self._seed([{"id": "bd-old", "serial": 7, "rawText": "x", "status": "sorted"}])
        resp = self.client.post("/api/brain-dump/capture", json={"text": "next"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        self.assertEqual(resp.get_json()["serial"], 8)

    def test_capture_rejects_empty_text(self):
        resp = self.client.post("/api/brain-dump/capture", json={"text": "   "})
        self.assertEqual(resp.status_code, 400)

    def test_edit_on_text_change_stamps_editedAt_and_resets_sorted_entry(self):
        self._seed([{"id": "bd-e", "serial": 1, "rawText": "old", "status": "sorted",
                     "sort": {"secondBrainPath": "x.md"}}])
        resp = self.client.put("/api/brain-dump/bd-e", json={"text": "new text"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        entry = resp.get_json()
        self.assertEqual(entry["rawText"], "new text")
        self.assertEqual(entry["status"], "captured")
        self.assertNotIn("sort", entry)
        self.assertIn("T", entry["editedAt"])

    def test_suppress_sets_flag_and_hides_from_default_view_but_not_status_all(self):
        # 2026-09-14: Brain Dump went human-only, everything with a `raisedBy` (like both
        # fixtures below -- suppress only ever applies to a machine-raised finding) moved
        # to /api/filed-findings -- see routes/brain_dump.py's _filtered_brain_dump_view.
        self._seed([
            {"id": "bd-keep", "serial": 1, "rawText": "live finding", "status": "sorted",
             "raisedBy": {"source": "pipeline_debrief"}},
            {"id": "bd-stale", "serial": 2, "rawText": "stale routing finding", "status": "sorted",
             "raisedBy": {"source": "pipeline_debrief"}},
        ])
        resp = self.client.post("/api/brain-dump/bd-stale/suppress", json={"reason": "config removed"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        entry = resp.get_json()
        self.assertTrue(entry["suppressed"])
        self.assertEqual(entry["suppressedReason"], "config removed")
        self.assertIn("T", entry["suppressedAt"])

        default_ids = [e["id"] for e in self.client.get("/api/filed-findings").get_json()]
        self.assertIn("bd-keep", default_ids)
        self.assertNotIn("bd-stale", default_ids)

        all_ids = [e["id"] for e in self.client.get("/api/filed-findings?status=all").get_json()]
        self.assertIn("bd-stale", all_ids)

        # And confirm the human-only endpoint never shows either machine-raised fixture.
        human_ids = [e["id"] for e in self.client.get("/api/brain-dump?status=all").get_json()]
        self.assertNotIn("bd-keep", human_ids)
        self.assertNotIn("bd-stale", human_ids)

    def test_suppress_is_reversible(self):
        self._seed([{"id": "bd-x", "serial": 1, "rawText": "x", "status": "sorted",
                     "suppressed": True, "suppressedReason": "was stale"}])
        resp = self.client.post("/api/brain-dump/bd-x/suppress", json={"suppressed": False})
        self.assertEqual(resp.status_code, 200)
        entry = resp.get_json()
        self.assertNotIn("suppressed", entry)
        self.assertNotIn("suppressedReason", entry)
        self.assertIn("bd-x", [e["id"] for e in self.client.get("/api/brain-dump").get_json()])

    def test_brain_dump_and_filed_findings_are_disjoint_and_status_filtering_still_works_on_both(self):
        # 2026-09-14 (Grimmethy: "Brain dump needs to go back to human input only. All
        # automatically generated tasks need to go into a separate filing tab"): the
        # split itself, and that /api/filed-findings honors the exact same
        # unprocessed/actioned/all semantics as /api/brain-dump always has.
        self._seed([
            {"id": "bd-human", "serial": 1, "rawText": "a note I typed", "status": "captured"},
            {"id": "bd-human-done", "serial": 2, "rawText": "an old note", "status": "actioned"},
            {"id": "bd-machine", "serial": 3, "rawText": "a sweep found this", "status": "captured",
             "raisedBy": {"source": "side-finding-sweep"}},
            {"id": "bd-machine-done", "serial": 4, "rawText": "an old finding", "status": "actioned",
             "raisedBy": {"source": "side-finding-sweep"}},
        ])

        human_default = [e["id"] for e in self.client.get("/api/brain-dump").get_json()]
        self.assertEqual(human_default, ["bd-human"])
        machine_default = [e["id"] for e in self.client.get("/api/filed-findings").get_json()]
        self.assertEqual(machine_default, ["bd-machine"])

        human_actioned = [e["id"] for e in self.client.get("/api/brain-dump?status=actioned").get_json()]
        self.assertEqual(human_actioned, ["bd-human-done"])
        machine_actioned = [e["id"] for e in self.client.get("/api/filed-findings?status=actioned").get_json()]
        self.assertEqual(machine_actioned, ["bd-machine-done"])

        human_all = sorted(e["id"] for e in self.client.get("/api/brain-dump?status=all").get_json())
        self.assertEqual(human_all, ["bd-human", "bd-human-done"])
        machine_all = sorted(e["id"] for e in self.client.get("/api/filed-findings?status=all").get_json())
        self.assertEqual(machine_all, ["bd-machine", "bd-machine-done"])

    def test_suppress_unknown_entry_404s(self):
        self._seed([])
        self.assertEqual(self.client.post("/api/brain-dump/nope/suppress").status_code, 404)

    def test_prioritize_queues_an_adhoc_task_and_actions_the_entry(self):
        self._seed([{"id": "bd-p", "serial": 1, "rawText": "do this now", "status": "captured"}])
        resp = self.client.post("/api/brain-dump/bd-p/prioritize")
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        entry = resp.get_json()
        self.assertEqual(entry["status"], "actioned")
        self.assertTrue(entry["queuedTaskId"].startswith("adhoc-brain-dump-"))
        self.assertIn("T", entry["queuedAt"])
        queued = list((self.pipeline_dir / "queue" / "adhoc").glob("*.json"))
        self.assertEqual(len(queued), 1)
        rec = json.loads(queued[0].read_text(encoding="utf-8"))
        self.assertEqual(rec["promptContext"]["brainDumpEntryId"], "bd-p")


if __name__ == "__main__":
    unittest.main()
