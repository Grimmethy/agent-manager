import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import app  # noqa: E402


class CapabilityRoute(unittest.TestCase):
    def _get(self, url, pipeline_dir, completed=None):
        with mock.patch.object(app, "get_pipeline_dir", return_value=pipeline_dir), \
                mock.patch("routes.capability.subprocess.run", return_value=completed) as run:
            resp = app.app.test_client().get(url)
        return resp.get_json(), run

    def test_returns_node_scorecard(self):
        rows = [{"source": "brain_dump_sort", "model": "m:8b", "n": 3, "ok": 3, "okRate": 1, "lower": 0.44, "outcomes": {"ok": 3}}]
        done = subprocess.CompletedProcess([], 0, stdout=json.dumps(rows), stderr="")
        body, run = self._get("/api/capability?days=7", Path(tempfile.gettempdir()), done)
        self.assertEqual(body, rows)
        self.assertEqual(run.call_args.args[0][2], "7")

    def test_empty_without_pipeline_dir(self):
        body, run = self._get("/api/capability", None)
        self.assertEqual(body, [])
        run.assert_not_called()

    def test_fails_soft_on_node_error(self):
        bad = subprocess.CompletedProcess([], 1, stdout="", stderr="boom")
        body, _ = self._get("/api/capability", Path(tempfile.gettempdir()), bad)
        self.assertEqual(body, [])


if __name__ == "__main__":
    unittest.main()
