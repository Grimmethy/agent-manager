"""_expected_instance_ids must match what scripts/launch.sh actually starts.

Run: .venv/bin/python -m unittest python.dashboard.test_expected_instances -v
"""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

P40 = {"AGENT_MANAGER_P40_OLLAMA_URL": "http://p40:11434", "AGENT_MANAGER_P40_MODEL": "m"}


class ExpectedInstancesTest(unittest.TestCase):
    def _ids(self, env):
        clean = {k: v for k, v in os.environ.items() if not k.startswith("AGENT_MANAGER_P40")}
        with mock.patch.dict(os.environ, {**clean, **env}, clear=True):
            return app._expected_instance_ids()

    def test_worker_reasoning_always_expected(self):
        self.assertIn("worker-reasoning", self._ids({}))

    def test_no_p40_lanes_without_p40_config(self):
        ids = self._ids({})
        self.assertNotIn("worker-p40", ids)
        self.assertNotIn("worker-reasoning-p40", ids)

    def test_both_p40_lanes_by_default(self):
        ids = self._ids(P40)
        self.assertIn("worker-p40", ids)
        self.assertIn("worker-reasoning-p40", ids)

    def test_p40_reasoning_lane_switch(self):
        ids = self._ids({**P40, "AGENT_MANAGER_P40_REASONING_LANE": "off"})
        self.assertIn("worker-p40", ids)
        self.assertNotIn("worker-reasoning-p40", ids)


if __name__ == "__main__":
    unittest.main()
