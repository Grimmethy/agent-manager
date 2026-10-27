"""Tests for app_proactive_sweep.py -- the --force start of the proactive decompose sweep shares scripts/lib/start-singleton-bg.sh's flock lock.

Run: .venv/bin/python -m unittest python.dashboard.test_proactive_sweep_argv -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app_proactive_sweep as m  # noqa: E402


class ProactiveSweepArgvTest(unittest.TestCase):
    def test_prefixes_flock_on_the_shared_lock_when_flock_exists(self):
        with mock.patch.object(m.shutil, "which", return_value="/usr/bin/flock"), mock.patch.object(m.os, "name", "posix"):
            argv = m.proactive_sweep_argv("/h/src/proactive-file-decompose-sweep.js", "/p/proactive-file-decompose.lock")
        self.assertEqual(argv, ["flock", "-n", "/p/proactive-file-decompose.lock", "node", "/h/src/proactive-file-decompose-sweep.js", "--force"])

    def test_plain_node_when_flock_is_missing(self):
        with mock.patch.object(m.shutil, "which", return_value=None), mock.patch.object(m.os, "name", "posix"):
            argv = m.proactive_sweep_argv("/h/s.js", "/p/x.lock")
        self.assertEqual(argv, ["node", "/h/s.js", "--force"])

    def test_plain_node_on_windows_even_if_a_flock_exists(self):
        with mock.patch.object(m.shutil, "which", return_value="C:/tools/flock.exe"), mock.patch.object(m.os, "name", "nt"):
            argv = m.proactive_sweep_argv("C:/h/s.js", "C:/p/x.lock")
        self.assertEqual(argv, ["node", "C:/h/s.js", "--force"])

    def test_lock_path_is_the_name_queue_watcher_uses_in_the_pids_dir(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"HOME": home}):
            p = m.proactive_sweep_lock_path()
            self.assertEqual(p, Path(home) / ".local/state/agent-manager/pids/proactive-file-decompose.lock")
            self.assertTrue(p.parent.is_dir(), "the pids directory is created")
        watcher = (Path(__file__).resolve().parents[2] / "scripts" / "queue-watcher.sh").read_text(encoding="utf-8")
        self.assertIn('PROACTIVE_LOCK="${PID_DIR}/proactive-file-decompose.lock"', watcher)

    def test_the_real_lock_excludes_a_second_force_start(self):
        # Behavioural check with the real flock: while one holder has the lock, the argv this module builds exits at once without running node.
        import subprocess
        import shutil
        if not shutil.which("flock"):
            self.skipTest("flock not installed")
        with tempfile.TemporaryDirectory() as d:
            lock = Path(d) / "x.lock"
            holder = subprocess.Popen(["flock", "-n", str(lock), "sleep", "3"])
            try:
                import time
                time.sleep(0.4)
                marker = Path(d) / "ran"
                argv = m.proactive_sweep_argv(Path(d) / "fake.js", lock)
                (Path(d) / "fake.js").write_text(f"require('fs').writeFileSync({str(marker)!r}, 'x')", encoding="utf-8")
                r = subprocess.run(argv[:-1], capture_output=True, text=True, timeout=10)  # drop --force: node would treat it as a script arg anyway
                self.assertNotEqual(r.returncode, 0, "flock -n returns non-zero when the lock is held")
                self.assertFalse(marker.exists(), "the sweep command must not run while the lock is held")
            finally:
                holder.terminate()
                holder.wait()


if __name__ == "__main__":
    unittest.main()
