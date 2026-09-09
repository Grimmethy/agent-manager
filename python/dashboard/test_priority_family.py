"""Tests for the Job List tab's source-family priority grouping (UI-only).

`task_source_family_key` / `task_source_families` derive the grouping from source names;
POST /api/job-types/priority-family shifts every member of a family by one delta so the
internal offsets (arch's deliberate 70/71 consumer vs 80/81 generator ordering) are
preserved. Purely a convenience over the per-source /api/job-types/priority endpoint --
nothing about the registry or the running pipeline changes.

Run: .venv/bin/python -m unittest python.dashboard.test_priority_family -v
"""
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

# A fixed stand-in for `node task-sources.js --dump-topology` so the grouping is
# deterministic and offline. Priorities mirror the real registry defaults.
FAKE_TOPOLOGY = [
    {"name": "adhoc", "priority": 10, "workerType": "reasoning"},
    {"name": "arch_review", "priority": 70, "workerType": "reasoning"},
    {"name": "arch_import_review", "priority": 71, "workerType": "reasoning"},
    {"name": "arch_discovery", "priority": 80, "workerType": "ornith"},
    {"name": "arch_import", "priority": 81, "workerType": "ornith"},
    {"name": "deep_dive", "priority": 82, "workerType": "ornith"},
    {"name": "observability_review", "priority": 80, "workerType": "ornith"},
    {"name": "observability_review_digest", "priority": 78, "workerType": "ornith"},
    {"name": "observability_fix", "priority": 72, "workerType": "ornith"},
    {"name": "doc_drift_fix", "priority": 68, "workerType": "ornith"},
    {"name": "staleness_audit", "priority": 91, "workerType": "ornith"},
    {"name": "pipeline_self_audit", "priority": 65, "workerType": "ornith"},
]


class FamilyKeyTests(unittest.TestCase):
    def setUp(self):
        self._p = mock.patch.object(app, "load_topology", return_value=FAKE_TOPOLOGY)
        self._p.start()

    def tearDown(self):
        self._p.stop()

    def test_recursive_suffix_strip(self):
        self.assertEqual(app.task_source_family_key("arch_import_review"), "arch")
        self.assertEqual(app.task_source_family_key("arch_import"), "arch")
        self.assertEqual(app.task_source_family_key("arch_review"), "arch")
        self.assertEqual(app.task_source_family_key("arch_discovery"), "arch")
        self.assertEqual(app.task_source_family_key("observability_review_digest"), "observability")

    def test_standalone_source_is_its_own_key(self):
        self.assertEqual(app.task_source_family_key("adhoc"), "adhoc")
        self.assertEqual(app.task_source_family_key("deep_dive"), "deep_dive")
        # "audit" is deliberately NOT a family suffix
        self.assertEqual(app.task_source_family_key("staleness_audit"), "staleness_audit")
        self.assertEqual(app.task_source_family_key("pipeline_self_audit"), "pipeline_self_audit")

    def test_families_need_two_or_more_members(self):
        fams = app.task_source_families()
        self.assertEqual(sorted(fams["arch"]), ["arch_discovery", "arch_import", "arch_import_review", "arch_review"])
        self.assertCountEqual(fams["observability"], ["observability_review", "observability_review_digest", "observability_fix"])
        # doc_drift_fix strips to doc_drift but is the only member -> not a family
        self.assertNotIn("doc_drift", fams)
        self.assertNotIn("adhoc", fams)
        self.assertNotIn("deep_dive", fams)

    def test_family_of_maps_only_real_family_members(self):
        fof = app.task_source_family_of()
        self.assertEqual(fof["arch_discovery"], "arch")
        self.assertNotIn("doc_drift_fix", fof)
        self.assertNotIn("adhoc", fof)

    def test_family_label(self):
        self.assertEqual(app.task_source_family_label("arch"), "Architecture review")
        self.assertEqual(app.task_source_family_label("something_new"), "Something new")


class PriorityFamilyEndpointTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.env = Path(self._tmp.name) / "agent-manager.env"
        self.env.write_text("LOCAL_MODEL=qwen\n", encoding="utf-8")
        self._patches = [
            mock.patch.object(app, "load_topology", return_value=FAKE_TOPOLOGY),
            mock.patch.object(app, "ENV_FILE_PATH", self.env),
        ]
        for p in self._patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _priorities_line(self) -> str:
        for line in self.env.read_text(encoding="utf-8").splitlines():
            if line.startswith("AGENT_MANAGER_TASK_PRIORITIES="):
                return line.partition("=")[2]
        return ""

    def test_shift_preserves_internal_offsets(self):
        res = self.client.post("/api/job-types/priority-family", json={"family": "arch", "base": 50})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(
            res.get_json()["members"],
            {"arch_review": 50, "arch_import_review": 51, "arch_discovery": 60, "arch_import": 61},
        )
        # every member written to the override string, offsets 0/1/10/11 intact
        self.assertEqual(
            self._priorities_line(),
            "arch_discovery:60,arch_import:61,arch_import_review:51,arch_review:50",
        )

    def test_shift_up_then_back_to_default_clears_overrides(self):
        self.client.post("/api/job-types/priority-family", json={"family": "arch", "base": 40})
        self.assertIn("arch_review:40", self._priorities_line())
        # back to the family's default base (min default = 70) -> all four land on default -> dropped
        res = self.client.post("/api/job-types/priority-family", json={"family": "arch", "base": 70})
        self.assertEqual(
            res.get_json()["members"],
            {"arch_review": 70, "arch_import_review": 71, "arch_discovery": 80, "arch_import": 81},
        )
        self.assertEqual(self._priorities_line(), "")

    def test_preserves_a_manual_per_member_tweak(self):
        # operator nudged one member off its canonical offset first
        self.client.post("/api/job-types/priority", json={"name": "arch_discovery", "priority": 75})
        self.client.post("/api/job-types/priority-family", json={"family": "arch", "base": 50})
        members = self.client.post(
            "/api/job-types/priority-family", json={"family": "arch", "base": 50}
        ).get_json()["members"]
        # arch_discovery kept its tweaked position relative to the others (75 - 70 = +5 from base)
        self.assertEqual(members["arch_review"], 50)
        self.assertEqual(members["arch_discovery"], 55)

    def test_does_not_touch_other_families_or_singletons(self):
        self.client.post("/api/job-types/priority-family", json={"family": "arch", "base": 50})
        line = self._priorities_line()
        self.assertNotIn("observability", line)
        self.assertNotIn("adhoc", line)
        self.assertNotIn("deep_dive", line)

    def test_unknown_family_is_400(self):
        self.assertEqual(
            self.client.post("/api/job-types/priority-family", json={"family": "doc_drift", "base": 10}).status_code,
            400,
        )
        self.assertEqual(
            self.client.post("/api/job-types/priority-family", json={"family": "nope", "base": 10}).status_code,
            400,
        )

    def test_non_integer_base_is_400(self):
        self.assertEqual(
            self.client.post("/api/job-types/priority-family", json={"family": "arch", "base": "high"}).status_code,
            400,
        )

    def test_job_types_get_exposes_family_fields(self):
        with mock.patch.object(app, "read_job_type_counters", return_value={}), \
             mock.patch.object(app, "available_candidate_counts", return_value={}):
            rows = self.client.get("/api/job-types").get_json()
        by_name = {r["name"]: r for r in rows}
        self.assertEqual(by_name["arch_discovery"]["family"], "arch")
        self.assertEqual(by_name["arch_discovery"]["familyLabel"], "Architecture review")
        self.assertEqual(by_name["arch_discovery"]["defaultPriority"], 80)
        self.assertIsNone(by_name["adhoc"]["family"])
        self.assertIsNone(by_name["doc_drift_fix"]["family"])


if __name__ == "__main__":
    unittest.main()
