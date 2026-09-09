"""Tests for the /api/concepts* routes (Concept Chart, 2026-09-06 -- see AGENTS.md's
"Concept research" section and src/concepts.js, this route set's Node-side counterpart).

Uses the same ENV_FILE_PATH-override pattern as test_active_project_resolution.py to
point get_pipeline_dir() at an isolated tmpdir, then drives the routes through Flask's
own test_client() rather than calling the view functions directly.

Run: .venv/bin/python -m unittest python.dashboard.test_concepts_routes -v
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class ConceptsRoutesTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_env_path = app.ENV_FILE_PATH
        app.ENV_FILE_PATH = Path(self._tmp.name) / "agent-manager.env"
        self._saved = {k: os.environ.get(k) for k in
                       ("AGENT_MANAGER_REPO_ROOT", "AGENT_MANAGER_PIPELINE_DIR")}
        for k in self._saved:
            os.environ.pop(k, None)
        self.pipeline_dir = Path(self._tmp.name) / "pipeline"
        self.pipeline_dir.mkdir(parents=True, exist_ok=True)
        app.ENV_FILE_PATH.write_text(f"AGENT_MANAGER_PIPELINE_DIR={self.pipeline_dir}\n", encoding="utf-8")
        self.client = app.app.test_client()

    def tearDown(self):
        app.ENV_FILE_PATH = self._orig_env_path
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _write_concepts(self, concepts):
        (self.pipeline_dir / "concepts.json").write_text(json.dumps({"concepts": concepts}), encoding="utf-8")

    def _write_brain_dump(self, entries):
        (self.pipeline_dir / "brain-dump.json").write_text(json.dumps({"entries": entries}), encoding="utf-8")

    def test_api_concepts_returns_empty_list_when_no_file_exists_yet(self):
        resp = self.client.get("/api/concepts")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json(), [])

    def test_api_concepts_returns_existing_rows(self):
        self._write_concepts([{"id": "concept-foo-1", "slug": "foo", "name": "Foo"}])
        resp = self.client.get("/api/concepts")
        data = resp.get_json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["id"], "concept-foo-1")

    def test_create_concept_writes_a_new_row_with_expected_shape(self):
        resp = self.client.post("/api/concepts", json={"name": "Chat context trimming", "description": "Trim old turns."})
        self.assertEqual(resp.status_code, 200)
        concept = resp.get_json()
        self.assertEqual(concept["name"], "Chat context trimming")
        self.assertEqual(concept["slug"], "chat-context-trimming")
        self.assertEqual(concept["status"], "open")
        self.assertEqual(concept["createdBy"], "manual")
        self.assertEqual(concept["researchForkCount"], 0)

        on_disk = json.loads((self.pipeline_dir / "concepts.json").read_text())
        self.assertEqual(len(on_disk["concepts"]), 1)

    # 2026-09-08: `kind` distinguishes a reference/template document (rendered with real
    # markdown, index.html's renderConceptCard) from every existing concept's narrative
    # finding (rendered as plain escaped text) -- mirrors src/concepts.js's own
    # createConcept(). Omitted entirely unless explicitly 'reference'.
    def test_create_concept_with_kind_reference_persists_it(self):
        resp = self.client.post("/api/concepts", json={"name": "Task Record Reference", "description": "x", "kind": "reference"})
        concept = resp.get_json()
        self.assertEqual(concept["kind"], "reference")
        on_disk = json.loads((self.pipeline_dir / "concepts.json").read_text())
        self.assertEqual(on_disk["concepts"][0]["kind"], "reference")

    def test_create_concept_without_kind_omits_the_field(self):
        resp = self.client.post("/api/concepts", json={"name": "Ordinary finding"})
        concept = resp.get_json()
        self.assertNotIn("kind", concept)

    def test_create_concept_ignores_an_unrecognized_kind_value(self):
        resp = self.client.post("/api/concepts", json={"name": "Something else", "kind": "bogus"})
        concept = resp.get_json()
        self.assertNotIn("kind", concept)

    def test_create_concept_requires_a_name(self):
        resp = self.client.post("/api/concepts", json={"description": "no name given"})
        self.assertEqual(resp.status_code, 400)

    def test_create_concept_is_idempotent_on_slug(self):
        first = self.client.post("/api/concepts", json={"name": "Web search capability"}).get_json()
        second = self.client.post("/api/concepts", json={"name": "web search capability!"}).get_json()
        self.assertEqual(first["id"], second["id"])
        on_disk = json.loads((self.pipeline_dir / "concepts.json").read_text())
        self.assertEqual(len(on_disk["concepts"]), 1)

    def test_timeline_merges_brain_dump_findings_sorted_chronologically(self):
        self._write_concepts([{"id": "concept-x", "slug": "x", "name": "X"}])
        self._write_brain_dump([
            {"id": "bd-2", "capturedAt": "2026-09-06T02:00:00Z", "rawText": "Second\nbody", "raisedBy": {"conceptId": "concept-x"}},
            {"id": "bd-1", "capturedAt": "2026-09-06T01:00:00Z", "rawText": "First\nbody", "raisedBy": {"conceptId": "concept-x"}},
            {"id": "bd-other", "capturedAt": "2026-09-06T01:30:00Z", "rawText": "Unrelated", "raisedBy": {"conceptId": "concept-other"}},
            {"id": "bd-human", "capturedAt": "2026-09-06T01:15:00Z", "rawText": "Human note"},
        ])
        resp = self.client.get("/api/concepts/concept-x/timeline")
        data = resp.get_json()
        self.assertEqual(data["truncated"], False)
        self.assertEqual([r["ref"] for r in data["rows"]], ["bd-1", "bd-2"])
        self.assertEqual(data["rows"][0]["kind"], "research-finding")

    def test_timeline_includes_matching_task_history_rows(self):
        self._write_concepts([{"id": "concept-x", "slug": "x", "name": "X"}])
        self._write_brain_dump([])
        done_dir = self.pipeline_dir / "queue" / "done"
        done_dir.mkdir(parents=True, exist_ok=True)
        (done_dir / "task-1.json").write_text(json.dumps({
            "id": "task-1", "conceptId": "concept-x", "completedAt": "2026-09-06T03:00:00Z", "title": "Implement thing",
        }), encoding="utf-8")
        (done_dir / "task-other.json").write_text(json.dumps({
            "id": "task-other", "conceptId": "concept-other", "completedAt": "2026-09-06T00:00:00Z", "title": "Unrelated",
        }), encoding="utf-8")

        resp = self.client.get("/api/concepts/concept-x/timeline")
        data = resp.get_json()
        self.assertEqual(data["truncated"], False)
        self.assertEqual([r["ref"] for r in data["rows"]], ["task-1"])
        self.assertEqual(data["rows"][0]["kind"], "task")
        self.assertEqual(data["rows"][0]["summary"], "Implement thing")

    # --- Lifecycle: shelve/reopen/ship (2026-09-06) ---------------------------------
    # Real registry data confirmed 14 of 16 concepts were stuck at 'researched' forever
    # with no way to distinguish "deliberately parked" from "forgotten." Mirrors
    # src/concepts.js's shelveConcept/reopenConcept/shipConcept exactly.

    def test_shelve_requires_a_reason(self):
        self._write_concepts([{"id": "concept-x", "slug": "x", "name": "X", "status": "researched"}])
        resp = self.client.post("/api/concepts/concept-x/shelve", json={})
        self.assertEqual(resp.status_code, 400)

    def test_shelve_stashes_prior_status_and_stamps_reason(self):
        self._write_concepts([{"id": "concept-x", "slug": "x", "name": "X", "status": "researched"}])
        resp = self.client.post("/api/concepts/concept-x/shelve", json={
            "reason": "a day of work, backlog takes priority",
            "revisitCondition": "reasoning-bench gives a real P40 number",
        })
        self.assertEqual(resp.status_code, 200)
        concept = resp.get_json()
        self.assertEqual(concept["status"], "shelved")
        self.assertEqual(concept["statusBeforeShelve"], "researched")
        self.assertEqual(concept["shelvedReason"], "a day of work, backlog takes priority")
        self.assertEqual(concept["revisitCondition"], "reasoning-bench gives a real P40 number")
        self.assertIn("shelvedAt", concept)

    def test_shelve_refuses_an_already_shelved_or_shipped_concept(self):
        self._write_concepts([{"id": "concept-x", "slug": "x", "name": "X", "status": "shipped"}])
        resp = self.client.post("/api/concepts/concept-x/shelve", json={"reason": "x"})
        self.assertEqual(resp.status_code, 409)

    def test_shelve_404s_for_an_unknown_concept(self):
        resp = self.client.post("/api/concepts/concept-does-not-exist/shelve", json={"reason": "x"})
        self.assertEqual(resp.status_code, 404)

    def test_reopen_restores_prior_status_and_clears_shelve_fields(self):
        self._write_concepts([{
            "id": "concept-x", "slug": "x", "name": "X", "status": "shelved",
            "statusBeforeShelve": "in-progress", "shelvedAt": "2026-09-06T00:00:00Z",
            "shelvedReason": "paused", "revisitCondition": "later",
        }])
        resp = self.client.post("/api/concepts/concept-x/reopen")
        self.assertEqual(resp.status_code, 200)
        concept = resp.get_json()
        self.assertEqual(concept["status"], "in-progress")
        self.assertNotIn("statusBeforeShelve", concept)
        self.assertNotIn("shelvedAt", concept)
        self.assertNotIn("shelvedReason", concept)
        self.assertNotIn("revisitCondition", concept)

    def test_reopen_a_shipped_concept_with_no_prior_shelve_defaults_to_researched(self):
        self._write_concepts([{"id": "concept-x", "slug": "x", "name": "X", "status": "shipped"}])
        resp = self.client.post("/api/concepts/concept-x/reopen")
        self.assertEqual(resp.get_json()["status"], "researched")

    def test_reopen_refuses_a_concept_that_is_not_shelved_or_shipped(self):
        self._write_concepts([{"id": "concept-x", "slug": "x", "name": "X", "status": "researched"}])
        resp = self.client.post("/api/concepts/concept-x/reopen")
        self.assertEqual(resp.status_code, 409)

    def test_ship_sets_status_and_stamps_shippedAt(self):
        self._write_concepts([{"id": "concept-x", "slug": "x", "name": "X", "status": "in-progress"}])
        resp = self.client.post("/api/concepts/concept-x/ship")
        self.assertEqual(resp.status_code, 200)
        concept = resp.get_json()
        self.assertEqual(concept["status"], "shipped")
        self.assertIn("shippedAt", concept)

    def test_ship_refuses_an_already_shelved_or_shipped_concept(self):
        self._write_concepts([{"id": "concept-x", "slug": "x", "name": "X", "status": "shelved"}])
        resp = self.client.post("/api/concepts/concept-x/ship")
        self.assertEqual(resp.status_code, 409)

    def test_timeline_truncates_the_slow_scan_under_a_hard_time_budget_and_flags_it(self):
        # Regression test for the real 73s live incident (2026-09-06): an unbounded
        # glob over a large done/ directory must never hang the request. Forces the
        # budget check to trip on the very first file by monkeypatching it to zero.
        self._write_concepts([{"id": "concept-x", "slug": "x", "name": "X"}])
        self._write_brain_dump([])
        done_dir = self.pipeline_dir / "queue" / "done"
        done_dir.mkdir(parents=True, exist_ok=True)
        for i in range(3):
            (done_dir / f"task-{i}.json").write_text(json.dumps({
                "id": f"task-{i}", "conceptId": "concept-x", "completedAt": f"2026-09-06T0{i}:00:00Z", "title": f"Task {i}",
            }), encoding="utf-8")

        orig_budget = app.CONCEPT_TASK_SCAN_BUDGET_SECONDS
        app.CONCEPT_TASK_SCAN_BUDGET_SECONDS = -1  # already-expired deadline
        try:
            resp = self.client.get("/api/concepts/concept-x/timeline")
        finally:
            app.CONCEPT_TASK_SCAN_BUDGET_SECONDS = orig_budget
        data = resp.get_json()
        self.assertEqual(data["truncated"], True)

    # --- ghost-telemetry route (2026-09-09, concept-ghost-in-the-machine-0dbeea) --------

    def _write_requeue_attribution_db(self, rows):
        import sqlite3
        db = sqlite3.connect(self.pipeline_dir / "requeue-attribution.db")
        db.execute(
            "CREATE TABLE requeue_causes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, "
            "signature TEXT NOT NULL, blocked_stage TEXT, requeue_writer TEXT NOT NULL, "
            "actor TEXT NOT NULL DEFAULT 'pipeline-mechanism', at TEXT NOT NULL)"
        )
        db.executemany(
            "INSERT INTO requeue_causes (task_id, signature, requeue_writer, actor, at) VALUES (?,?,?,?,?)",
            rows,
        )
        db.commit()
        db.close()

    def test_ghost_telemetry_404s_for_a_non_ghost_concept(self):
        resp = self.client.get("/api/concepts/concept-something-else/ghost-telemetry")
        self.assertEqual(resp.status_code, 404)

    def test_ghost_telemetry_splits_hand_fixes_from_mechanism_recoveries(self):
        now = datetime.now(timezone.utc).isoformat()
        self._write_requeue_attribution_db([
            ("a", "s", "needs-clarification-triage", "pipeline-mechanism", now),
            ("b", "s", "context-trim-sweep", "pipeline-mechanism", now),
            ("c", "s", "operator-manual", "operator-manual", now),
        ])
        (self.pipeline_dir / "queue").mkdir(parents=True, exist_ok=True)
        (self.pipeline_dir / "queue" / "ghost-debt-state.json").write_text(
            json.dumps({"sig1": now, "sig2": now}), encoding="utf-8")

        resp = self.client.get("/api/concepts/concept-ghost-in-the-machine-0dbeea/ghost-telemetry")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["handFixes"], 1)
        self.assertEqual(data["mechanismRecoveries"], 2)
        self.assertEqual(data["openDebt"], 2)
        self.assertEqual(data["byActor"]["operator-manual"], 1)
        self.assertTrue(data["series"])

    def test_ghost_telemetry_all_zeros_when_no_db_yet(self):
        resp = self.client.get("/api/concepts/concept-ghost-in-the-machine-0dbeea/ghost-telemetry")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["handFixes"], 0)
        self.assertEqual(data["mechanismRecoveries"], 0)
        self.assertEqual(data["openDebt"], 0)


if __name__ == "__main__":
    unittest.main()
