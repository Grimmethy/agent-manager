"""The Windows support retired by HUB0365: the PowerShell loops and launch.bat are gone, nothing still calls them, and the code paths that used to are honest.

Run from python/dashboard: .venv/bin/python -m unittest test_windows_retired
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


class NtOs:
    """The os module as seen by app.py on Windows: only `name` differs (pathlib keeps the real one)."""
    name = "nt"

    def __getattr__(self, attr):
        return getattr(os, attr)


RETIRED = ["launch.bat", "scripts/orchid-worker.sh", "scripts/orc*common*.patch.txt", "src/agent-manager-common.ps1", "src/apply-runner.ps1", "src/load-env.ps1",
           "src/local-worker.ps1", "src/pipeline-doctor.ps1", "src/queue-watchdog.ps1", "src/review-runner.ps1"]


class TestWindowsRetired(unittest.TestCase):
    def test_the_retired_files_are_gone_and_the_live_shell_helper_stays(self):
        for rel in RETIRED:
            self.assertFalse((ROOT / rel).exists(), rel)
        self.assertTrue((ROOT / "scripts" / "orc-common.sh").is_file(), "orc-common.sh is sourced by local-worker.sh, queue-watcher.sh and review-runner.sh")

    def test_no_powershell_script_or_batch_file_remains_in_the_tree(self):
        skip = {".git", ".venv", "node_modules", "vendor"}  # the file system, not the git index: a patched working tree has deleted files that the index still lists
        found = [str(p.relative_to(ROOT)) for p in ROOT.rglob("*") if p.suffix in (".ps1", ".bat") and not skip.intersection(p.relative_to(ROOT).parts)]
        self.assertEqual(found, [])

    def test_the_dashboard_no_longer_names_powershell(self):
        offenders = [str(p.relative_to(ROOT)) for p in (ROOT / "python" / "dashboard").rglob("*.py") if not p.name.startswith("test_") and "powershell.exe" in p.read_text(encoding="utf-8")]
        self.assertEqual(offenders, [])

    def test_the_poll_baseline_has_no_entries_for_deleted_files(self):
        paths = [f["path"] for f in json.loads((ROOT / "docs" / "poll-baseline.json").read_text())["findings"]]
        self.assertEqual([p for p in paths if p.endswith((".ps1", ".bat"))], [])

    def test_the_manual_apply_route_answers_501_for_an_approved_task_and_404_otherwise(self):
        qdir = Path(tempfile.mkdtemp(prefix="windows-retired-"))
        (qdir / "approved").mkdir()
        (qdir / "approved" / "t-1.json").write_text("{}")
        client = app.app.test_client()
        with mock.patch.object(app, "queue_dir", return_value=qdir):
            res = client.post("/api/task/approved/t-1/apply")
            self.assertEqual((res.status_code, res.get_json()["applied"]), (501, False))
            self.assertIn("apply loop", res.get_json()["reason"])
            self.assertEqual(client.post("/api/task/approved/missing/apply").status_code, 404)

    def test_starting_the_pipeline_on_windows_says_it_is_unsupported(self):
        with mock.patch.object(app, "os", NtOs()), mock.patch.object(app, "_resolve_plugin_root", return_value=None), mock.patch.object(app, "_acquire_gpu_lease"):
            result = app._launch_pipeline_subprocess({}, "/tmp/x", False, False)
        self.assertEqual(result["started"], False)
        self.assertIn("Windows is no longer supported", result["reason"])


if __name__ == "__main__":
    unittest.main()
