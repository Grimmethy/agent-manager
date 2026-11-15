"""Tests for HUB0325 · 1/6: lane metadata (provider/taskClasses/tierB) on /api/instances.

Run: python -m unittest python.dashboard.test_instances_lane_fields -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from routes.instances import lane_fields_for  # noqa: E402
import app  # noqa: E402


# ---------------------------------------------------------------------------
# Helper tests (no Flask needed)
# ---------------------------------------------------------------------------

class TestLaneFieldsFor(unittest.TestCase):
    """Pure-function behaviour of lane_fields_for()."""

    def test_default_provider_when_no_provider_field(self):
        defs = [{"id": "worker-local", "gpu": "3090"}]
        self.assertEqual(lane_fields_for("worker-local", defs)["provider"], "local")

    def test_provider_cloud_from_provider_field(self):
        defs = [{"id": "worker-cloud", "provider": "cloud"}]
        self.assertEqual(lane_fields_for("worker-cloud", defs)["provider"], "cloud")

    def test_provider_cloud_from_cloud_flag(self):
        defs = [{"id": "worker-cloud", "cloud": True}]
        self.assertEqual(lane_fields_for("worker-cloud", defs)["provider"], "cloud")

    def test_provider_script_from_provider_field(self):
        defs = [{"id": "worker-script", "provider": "script"}]
        self.assertEqual(lane_fields_for("worker-script", defs)["provider"], "script")

    def test_provider_script_from_script_flag(self):
        defs = [{"id": "worker-script", "script": True}]
        self.assertEqual(lane_fields_for("worker-script", defs)["provider"], "script")

    def test_taskClasses_array_passed_through(self):
        defs = [{"id": "w", "taskClasses": ["brain_dump_sort", "change_review"]}]
        self.assertEqual(
            lane_fields_for("w", defs)["taskClasses"],
            ["brain_dump_sort", "change_review"],
        )

    def test_taskClasses_null_when_missing(self):
        defs = [{"id": "w"}]
        self.assertIsNone(lane_fields_for("w", defs)["taskClasses"])

    def test_taskClasses_null_when_not_a_list(self):
        defs = [{"id": "w", "taskClasses": "not-a-list"}]
        self.assertIsNone(lane_fields_for("w", defs)["taskClasses"])

    def test_tierB_number_passed_through(self):
        defs = [{"id": "w", "tier": 70}]
        self.assertEqual(lane_fields_for("w", defs)["tierB"], 70)

    def test_tierB_null_when_missing(self):
        defs = [{"id": "w"}]
        self.assertIsNone(lane_fields_for("w", defs)["tierB"])

    def test_tierB_null_when_string(self):
        defs = [{"id": "w", "tier": "seven"}]
        self.assertIsNone(lane_fields_for("w", defs)["tierB"])

    def test_tierB_null_when_boolean(self):
        defs = [{"id": "w", "tier": True}]
        self.assertIsNone(lane_fields_for("w", defs)["tierB"])

    def test_unknown_instance_id_gives_three_nulls(self):
        defs = [{"id": "worker-local"}]
        result = lane_fields_for("reviewer", defs)
        self.assertEqual(result, {"provider": None, "taskClasses": None, "tierB": None})

    def test_empty_lane_defs_gives_three_nulls(self):
        result = lane_fields_for("worker-local", [])
        self.assertEqual(result, {"provider": None, "taskClasses": None, "tierB": None})

    def test_legacy_worker_p40_when_present(self):
        defs = [{"id": "worker-p40", "provider": "ollama", "tier": 13}]
        result = lane_fields_for("worker-p40", defs)
        self.assertEqual(result["provider"], "local")
        self.assertEqual(result["tierB"], 13)


# ---------------------------------------------------------------------------
# View tests (Flask test client, with app monkey-patched)
# ---------------------------------------------------------------------------

def _make_heartbeat(tmp_dir: Path, instance_id: str, status: str = "working") -> Path:
    hb = tmp_dir / f"{instance_id}.json"
    hb.write_text(json.dumps({
        "instanceId": instance_id,
        "status": status,
        "lastHeartbeat": "2026-01-01T00:00:00Z",
        "pid": 1,
        "model": "qwen3:8b",
        "currentTaskId": None,
        "currentPass": None,
    }))
    return hb


class TestApiInstancesLaneFields(unittest.TestCase):
    """The /api/instances route returns the three lane keys on every entry."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hb_dir = Path(self.tmp.name) / "instances"
        self.hb_dir.mkdir()
        self._q = None

    def tearDown(self):
        # Restore any patches we may have left in place
        for p in getattr(self, "_patches", []):
            p.stop()
        self.tmp.cleanup()

    def _client(self):
        app.app.config["TESTING"] = True
        return app.app.test_client()

    def test_every_entry_carries_the_three_keys(self):
        _make_heartbeat(self.hb_dir, "worker-3090", "working")
        _make_heartbeat(self.hb_dir, "worker-p40", "offline")
        defs = [
            {"id": "worker-3090", "provider": "cloud", "taskClasses": ["a"], "tier": 70},
            {"id": "worker-p40", "tier": 13},
        ]
        patches = [
            patch.object(app, "worker_lane_defs", return_value=defs),
            patch.object(app, "instances_dir", return_value=self.hb_dir),
            patch.object(app, "_expected_instance_ids", return_value=["worker-3090", "worker-p40"]),
        ]
        self._patches = patches
        for p in patches:
            p.start()
        resp = self._client().get("/api/instances")
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        ids = sorted(e["instanceId"] for e in body)
        self.assertEqual(ids, ["worker-3090", "worker-p40"])
        for e in body:
            self.assertIn("provider", e)
            self.assertIn("taskClasses", e)
            self.assertIn("tierB", e)
        by_id = {e["instanceId"]: e for e in body}
        self.assertEqual(by_id["worker-3090"]["provider"], "cloud")
        self.assertEqual(by_id["worker-3090"]["tierB"], 70)
        self.assertEqual(by_id["worker-p40"]["provider"], "local")
        self.assertEqual(by_id["worker-p40"]["tierB"], 13)

    def test_instance_ids_and_order_unchanged_without_the_change(self):
        """The new keys are additive: existing instanceIds and sort order are preserved."""
        _make_heartbeat(self.hb_dir, "worker-b", "working")
        _make_heartbeat(self.hb_dir, "worker-a", "offline")
        defs = [
            {"id": "worker-a", "provider": "script"},
            {"id": "worker-b", "provider": "cloud"},
        ]
        patches = [
            patch.object(app, "worker_lane_defs", return_value=defs),
            patch.object(app, "instances_dir", return_value=self.hb_dir),
            patch.object(app, "_expected_instance_ids", return_value=["worker-a", "worker-b"]),
        ]
        self._patches = patches
        for p in patches:
            p.start()
        resp = self._client().get("/api/instances")
        body = resp.get_json()
        ids = [e["instanceId"] for e in body]
        self.assertEqual(ids, ["worker-a", "worker-b"])  # sorted ascending

    def test_raising_worker_lane_defs_still_returns_200_with_three_nulls(self):
        """A lane-definition failure must not break the route -- every entry gets nulls."""
        _make_heartbeat(self.hb_dir, "worker-3090", "working")
        patches = [
            patch.object(app, "worker_lane_defs", side_effect=RuntimeError("node unavailable")),
            patch.object(app, "instances_dir", return_value=self.hb_dir),
            patch.object(app, "_expected_instance_ids", return_value=["worker-3090"]),
        ]
        self._patches = patches
        for p in patches:
            p.start()
        resp = self._client().get("/api/instances")
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        for e in body:
            self.assertEqual(e["provider"], None)
            self.assertEqual(e["taskClasses"], None)
            self.assertEqual(e["tierB"], None)


if __name__ == "__main__":
    unittest.main()
