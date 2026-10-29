"""Worker lanes are one per GPU and named for it; the dashboard's expected-instance list must match
what scripts/launch.sh starts. src/lanes.js is the single definition; app.worker_lane_ids() shells out
to it.

Run: .venv/bin/python -m unittest python.dashboard.test_expected_instances -v
"""
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


class ExpectedInstancesTest(unittest.TestCase):
    def setUp(self):
        app._LANE_IDS_CACHE.update(at=0.0, ids=[])
        app._LANE_DEFS_CACHE.update(at=0.0, lanes=[])
        self.addCleanup(lambda: app._LANE_IDS_CACHE.update(at=0.0, ids=[]))
        self.addCleanup(lambda: app._LANE_DEFS_CACHE.update(at=0.0, lanes=[]))

    def test_expected_ids_are_lanes_plus_reviewer_and_watchdog(self):
        with mock.patch.object(app, "worker_lane_ids", return_value=["worker-3090", "worker-p40"]):
            with mock.patch.object(app, "worker_lane_defs", return_value=[]):
                self.assertEqual(app._expected_instance_ids(), ["worker-3090", "worker-p40", "reviewer", "watchdog"])

    def test_a_lane_that_opts_in_adds_its_review_daemon(self):
        defs = [{"id": "worker-3090", "reviewer": True, "reviewerId": "reviewer"},
                {"id": "worker-p40", "reviewer": True, "reviewerId": "reviewer-p40"},
                {"id": "worker-rx580", "reviewer": False, "reviewerId": "reviewer-rx580"}]
        with mock.patch.object(app, "worker_lane_ids", return_value=["worker-3090", "worker-p40", "worker-rx580"]), \
             mock.patch.object(app, "worker_lane_defs", return_value=defs):
            self.assertEqual(app.reviewer_instance_ids(), ["reviewer", "reviewer-p40"])
            self.assertEqual(app._expected_instance_ids(), ["worker-3090", "worker-p40", "worker-rx580", "reviewer", "reviewer-p40", "watchdog"])

    def test_p40_reviewer_env_switch_reaches_the_dashboard_through_lanes_js(self):
        env = {**os.environ, "AGENT_MANAGER_LOCAL_GPU": "3090", "AGENT_MANAGER_P40_OLLAMA_URL": "http://p40:11434",
               "AGENT_MANAGER_P40_MODEL": "m", "AGENT_MANAGER_P40_REVIEWER": "true"}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(app, "read_env_file", return_value={}):
            self.assertEqual(app.reviewer_instance_ids(), ["reviewer", "reviewer-p40"])

    def test_worker_lane_ids_matches_the_node_lane_definition(self):
        """Parity: whatever src/lanes.js says, the dashboard says. One P40 configured -> two lanes."""
        env = {**os.environ, "AGENT_MANAGER_LOCAL_GPU": "3090",
               "AGENT_MANAGER_P40_OLLAMA_URL": "http://p40:11434", "AGENT_MANAGER_P40_MODEL": "m"}
        node_ids = subprocess.run(["node", str(REPO / "src" / "lanes.js"), "--ids"], capture_output=True,
                                  text=True, env=env, timeout=10).stdout.split()
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(app, "read_env_file", return_value={}):
            self.assertEqual(app.worker_lane_ids(), node_ids)
        self.assertEqual(node_ids, ["worker-3090", "worker-p40"])

    def test_no_p40_config_means_a_single_lane(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("AGENT_MANAGER_P40")}
        env["AGENT_MANAGER_LOCAL_GPU"] = "3090"
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(app, "read_env_file", return_value={}):
            self.assertEqual(app.worker_lane_ids(), ["worker-3090"])

    def test_falls_back_to_last_good_answer_when_node_is_unavailable(self):
        app._LANE_IDS_CACHE.update(at=-1e9, ids=["worker-3090"])  # stale cache entry
        with mock.patch.object(app.subprocess, "run", side_effect=OSError("no node")):
            self.assertEqual(app.worker_lane_ids(), ["worker-3090"])

    def test_last_resort_when_nothing_is_known(self):
        with mock.patch.object(app.subprocess, "run", side_effect=OSError("no node")):
            self.assertEqual(app.worker_lane_ids(), ["worker-local"])

    def test_worker_lane_defs_matches_the_node_definition_including_a_registry_lane(self):
        """A lane declared only in the lanes registry file shows up, with its preempt/taskClasses, in the dashboard's view too."""
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            reg = Path(td) / "lanes.json"
            reg.write_text(json.dumps([{"gpu": "rx580", "ollamaUrl": "http://100.96.112.78:11434", "model": "qwen3-vl:8b-instruct",
                                        "taskClasses": ["brain_dump_sort"]}]))
            env = {**os.environ, "AGENT_MANAGER_LOCAL_GPU": "3090", "AGENT_MANAGER_LANES_PATH": str(reg)}
            for k in ("AGENT_MANAGER_P40_OLLAMA_URL", "AGENT_MANAGER_P40_MODEL"):
                env.pop(k, None)
            node_lanes = json.loads(subprocess.run(["node", str(REPO / "src" / "lanes.js")], capture_output=True,
                                                   text=True, env=env, timeout=10).stdout)
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(app, "read_env_file", return_value={}):
                self.assertEqual(app.worker_lane_defs(), node_lanes)
        self.assertEqual([l["id"] for l in node_lanes], ["worker-3090", "worker-rx580"])
        self.assertEqual(node_lanes[0]["preempt"], "always")
        self.assertEqual(node_lanes[1]["preempt"], "never")
        self.assertEqual(node_lanes[1]["taskClasses"], ["brain_dump_sort"])

    def test_worker_lane_defs_falls_back_to_last_good_then_empty_when_node_is_unavailable(self):
        with mock.patch.object(app.subprocess, "run", side_effect=OSError("no node")):
            self.assertEqual(app.worker_lane_defs(), [], "nothing known: [] (callers must treat it as unknown, not as no lanes)")
        app._LANE_DEFS_CACHE.update(at=-1e9, lanes=[{"id": "worker-3090", "preempt": "always"}])  # stale cache entry
        with mock.patch.object(app.subprocess, "run", side_effect=OSError("no node")):
            self.assertEqual(app.worker_lane_defs(), [{"id": "worker-3090", "preempt": "always"}])


if __name__ == "__main__":
    unittest.main()
