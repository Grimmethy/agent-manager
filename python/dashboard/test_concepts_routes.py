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
        rows = resp.get_json()
        self.assertEqual([r["ref"] for r in rows], ["bd-1", "bd-2"])
        self.assertEqual(rows[0]["kind"], "research-finding")

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
        rows = resp.get_json()
        self.assertEqual([r["ref"] for r in rows], ["task-1"])
        self.assertEqual(rows[0]["kind"], "task")
        self.assertEqual(rows[0]["summary"], "Implement thing")


if __name__ == "__main__":
    unittest.main()
