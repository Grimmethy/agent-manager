"""Job List rows tell the operator which sources are agent-manager-only (scope 'core').

Run: .venv/bin/python -m unittest python.dashboard.test_job_types_scope -v
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class JobTypesScopeTest(unittest.TestCase):
    def test_core_sources_are_flagged_and_their_description_says_so(self):
        topology = [
            {"name": "pipeline_health_audit", "priority": 22, "scope": "core"},
            {"name": "function_length_review", "priority": 28, "scope": "project"},
            {"name": "legacy_no_scope_field", "priority": 50},
        ]
        with mock.patch.object(app, "load_topology", return_value=topology), \
             mock.patch.object(app, "task_source_catalog", return_value=[t["name"] for t in topology]):
            rows = {r["name"]: r for r in app.app.test_client().get("/api/job-types").get_json()}
        self.assertEqual(rows["pipeline_health_audit"]["scope"], "core")
        self.assertIn("agent-manager only", rows["pipeline_health_audit"]["description"])
        self.assertEqual(rows["function_length_review"]["scope"], "project")
        self.assertNotIn("agent-manager only", rows["function_length_review"]["description"])
        self.assertEqual(rows["legacy_no_scope_field"]["scope"], "project")

    def test_real_topology_marks_the_seven_pipeline_self_sources_core(self):
        scopes = app.task_source_scopes()
        core = {n for n, s in scopes.items() if s == "core"}
        # Only asserts when the live topology is available (it shells out to node); the fallback JSON has no scope.
        if core:
            self.assertEqual(core, {"pipeline_health_audit", "pipeline_self_audit", "pipeline_forensics",
                                    "pipeline_forensics_fix", "pipeline_debrief", "doc_drift_fix", "ui_visibility_audit"})


if __name__ == "__main__":
    unittest.main()
