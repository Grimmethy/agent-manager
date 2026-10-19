"""_stop_pipeline must tell stop.sh to leave the plugin servers alone.

Live incident 2026-10-14 (three times): POST /api/pipeline/stop ran `scripts/stop.sh --keep-dashboard`, which
killed every pidfile in the pids folder -- including the plugin servers' plugin-<name>.pid (promptforge,
characterforge, storyforge, videoforge). A Forge render job died mid-run. The dashboard now passes
--keep-plugins on BOTH the graceful and the --force path.

subprocess and instances_dir are mocked: nothing real is stopped and no real heartbeat file is touched.

Run: .venv/bin/python -m unittest python.dashboard.test_stop_pipeline_keeps_plugins -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


@unittest.skipIf(os.name == "nt", "Linux path: shells out to stop.sh")
class StopPipelineKeepsPluginsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        patcher = mock.patch.object(app, "instances_dir", return_value=Path(self._tmp.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_graceful_stop_passes_keep_plugins_and_keep_dashboard(self):
        with mock.patch.object(app.subprocess, "Popen") as popen, mock.patch.object(app.subprocess, "run") as run:
            app._stop_pipeline(force=False)
        run.assert_not_called()
        args = popen.call_args[0][0]
        self.assertIn("--keep-plugins", args)
        self.assertIn("--keep-dashboard", args)
        self.assertNotIn("--force", args)

    def test_force_stop_passes_keep_plugins_and_force(self):
        with mock.patch.object(app.subprocess, "Popen") as popen, mock.patch.object(app.subprocess, "run") as run:
            app._stop_pipeline(force=True)
        popen.assert_not_called()
        args = run.call_args[0][0]
        self.assertIn("--keep-plugins", args)
        self.assertIn("--keep-dashboard", args)
        self.assertIn("--force", args)


if __name__ == "__main__":
    unittest.main()
