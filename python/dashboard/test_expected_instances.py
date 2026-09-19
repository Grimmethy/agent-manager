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
        self.addCleanup(lambda: app._LANE_IDS_CACHE.update(at=0.0, ids=[]))

    def test_expected_ids_are_lanes_plus_reviewer_and_watchdog(self):
        with mock.patch.object(app, "worker_lane_ids", return_value=["worker-3090", "worker-p40"]):
            self.assertEqual(app._expected_instance_ids(), ["worker-3090", "worker-p40", "reviewer", "watchdog"])

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


if __name__ == "__main__":
    unittest.main()
