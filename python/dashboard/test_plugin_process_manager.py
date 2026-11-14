"""Tests for plugin_process_manager.py -- particularly the port-guard fix
(2026-09-15) for a real incident confirmed live twice in one session: an untracked
process already serving a plugin's configured port made start() falsely report
"started"/"healthy" while the new child silently failed to bind and the OLD, stale
process kept answering health checks.

Run: .venv/bin/python -m unittest test_plugin_process_manager -v
"""
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import plugin_process_manager as ppm  # noqa: E402


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class TmpStateDirTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._patches = [
            mock.patch.object(ppm, "PID_DIR", self.tmp / "pids"),
            mock.patch.object(ppm, "LOG_DIR", self.tmp / "logs"),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)


class PortHelpersTest(unittest.TestCase):
    def test_port_from_url_parses_a_real_url(self):
        self.assertEqual(ppm._port_from_url("http://localhost:7442"), 7442)

    def test_port_from_url_returns_none_for_garbage(self):
        self.assertIsNone(ppm._port_from_url(""))
        self.assertIsNone(ppm._port_from_url("not a url"))

    def test_port_in_use_true_for_a_real_bound_port(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as srv:
            srv.bind(("127.0.0.1", 0))
            srv.listen(1)
            port = srv.getsockname()[1]
            self.assertTrue(ppm._port_in_use(port))

    def test_port_in_use_false_for_a_free_port(self):
        port = free_port()
        self.assertFalse(ppm._port_in_use(port))


class StartPortGuardTest(TmpStateDirTest):
    def test_start_refuses_when_port_is_answering_but_untracked(self):
        """The exact incident: something is on the port, our pidfile has never heard
        of it. start() must refuse loudly, not spawn a duplicate."""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as orphan:
            orphan.bind(("127.0.0.1", 0))
            orphan.listen(1)
            port = orphan.getsockname()[1]
            entry = {
                "name": "test-plugin", "url": f"http://localhost:{port}",
                "process": {"command": "/bin/sleep", "args": ["30"]},
            }
            result = ppm.start(entry)
            self.assertFalse(result)
            self.assertFalse(ppm._pidfile("test-plugin").exists(), "must not have written a pidfile for a refused start")

    def test_start_succeeds_normally_when_the_port_is_genuinely_free(self):
        port = free_port()
        entry = {
            "name": "test-plugin", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        try:
            result = ppm.start(entry)
            self.assertTrue(result)
            self.assertTrue(ppm.is_running("test-plugin"))
        finally:
            ppm.stop("test-plugin")

    def test_start_with_no_url_skips_the_port_guard_entirely(self):
        # A malformed/incomplete entry (no url) must not crash the guard -- falls
        # through to the normal spawn path unaffected.
        entry = {"name": "test-plugin", "process": {"command": "/bin/sleep", "args": ["30"]}}
        try:
            result = ppm.start(entry)
            self.assertTrue(result)
        finally:
            ppm.stop("test-plugin")

    def test_is_running_already_true_short_circuits_before_the_port_guard(self):
        # Idempotent-start path: if OUR OWN tracked pid is genuinely alive, start()
        # returns True immediately without even consulting the port guard.
        port = free_port()
        entry = {
            "name": "test-plugin", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        try:
            self.assertTrue(ppm.start(entry))
            with mock.patch.object(ppm, "_port_in_use") as spy:
                self.assertTrue(ppm.start(entry))
                spy.assert_not_called()
        finally:
            ppm.stop("test-plugin")


class StartEnvPassthroughTest(TmpStateDirTest):
    def test_start_passes_the_entry_own_process_env_to_the_child(self):
        """Real live bug (2026-09-28): the child's env was built purely from the
        dashboard's own inherited os.environ -- an entry's own process.env block
        (e.g. wikiforge-*'s WIKIFORGE_SECOND_BRAIN_ROOT) never actually reached the
        child process at all. Confirmed live: starting wikiforge this way registered
        zero spaces despite a fully correct process.env block."""
        outfile = self.tmp / "env-out.txt"
        port = free_port()
        entry = {
            "name": "test-plugin", "url": f"http://localhost:{port}",
            "process": {
                "command": "/bin/sh",
                "args": ["-c", f'echo "$WIKIFORGE_TEST_ROOT" > {outfile}'],
                "env": {"WIKIFORGE_TEST_ROOT": "/some/real/path"},
            },
        }
        try:
            self.assertTrue(ppm.start(entry))
            for _ in range(20):
                if outfile.exists() and outfile.read_text().strip():
                    break
                time.sleep(0.1)
            self.assertEqual(outfile.read_text().strip(), "/some/real/path")
        finally:
            ppm.stop("test-plugin")

    def test_start_entry_env_overrides_an_inherited_value_of_the_same_name(self):
        outfile = self.tmp / "env-override-out.txt"
        port = free_port()
        entry = {
            "name": "test-plugin", "url": f"http://localhost:{port}",
            "process": {
                "command": "/bin/sh",
                "args": ["-c", f'echo "$WIKIFORGE_TEST_OVERRIDE" > {outfile}'],
                "env": {"WIKIFORGE_TEST_OVERRIDE": "entry-value"},
            },
        }
        try:
            with mock.patch.dict("os.environ", {"WIKIFORGE_TEST_OVERRIDE": "inherited-value"}):
                self.assertTrue(ppm.start(entry))
            for _ in range(20):
                if outfile.exists() and outfile.read_text().strip():
                    break
                time.sleep(0.1)
            self.assertEqual(outfile.read_text().strip(), "entry-value", "the entry's own value must win over an inherited one")
        finally:
            ppm.stop("test-plugin")


class ProcessKeyTest(unittest.TestCase):
    def test_process_key_returns_processName_when_present(self):
        self.assertEqual(ppm.process_key({"name": "wikiforge-secondbrain", "processName": "wikiforge"}), "wikiforge")

    def test_process_key_falls_back_to_name_when_processName_absent(self):
        self.assertEqual(ppm.process_key({"name": "promptforge"}), "promptforge")


class SharedProcessKeyTest(TmpStateDirTest):
    def test_starting_a_second_entry_sharing_processName_recognizes_the_first_as_already_running(self):
        """The exact live incident (2026-09-28): 4 real plugins.json entries
        (wikiforge-secondbrain/wikiforge-agent-manager/wikiforge-wikiforge/
        wikiforge-propertyforager) all declare processName: "wikiforge" and share one
        real node server.js on one port -- starting the SECOND one while the first is
        still running used to hit the port-guard and refuse, because is_running()
        checked a pidfile keyed by the second entry's own name, which never existed."""
        port = free_port()
        entry_a = {
            "name": "wikiforge-secondbrain", "processName": "wikiforge", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        entry_b = {
            "name": "wikiforge-propertyforager", "processName": "wikiforge", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        try:
            self.assertTrue(ppm.start(entry_a), "starting the first entry must succeed")
            self.assertTrue(ppm.is_running(ppm.process_key(entry_a)))
            # The real bug: starting a DIFFERENT entry sharing the same processName,
            # while the first is still alive, used to return False (port-guard refusal).
            self.assertTrue(ppm.start(entry_b), "starting the second entry must recognize the shared process, not refuse")
            self.assertTrue(ppm.is_running(ppm.process_key(entry_b)))
            # Exactly one pidfile exists -- under the shared key, not two separate ones.
            self.assertTrue(ppm._pidfile("wikiforge").exists())
            self.assertFalse(ppm._pidfile("wikiforge-secondbrain").exists())
            self.assertFalse(ppm._pidfile("wikiforge-propertyforager").exists())
        finally:
            ppm.stop(ppm.process_key(entry_a))

    def test_api_plugins_live_status_logic_reflects_a_processName_entry_not_just_slotted(self):
        """Direct check of the exact logic routes/plugins.py's api_plugins() now runs
        (process_key + is_running) -- no existing Flask-route test file covers this
        endpoint to extend, so this reproduces its updated condition/call directly."""
        port = free_port()
        entry = {
            "name": "wikiforge-secondbrain", "processName": "wikiforge", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        try:
            ppm.start(entry)
            # This is the exact updated api_plugins() condition + call:
            self.assertTrue(entry.get("slot") or entry.get("processName"))
            self.assertTrue(ppm.is_running(ppm.process_key(entry)))
        finally:
            ppm.stop(ppm.process_key(entry))


class StopTest(TmpStateDirTest):
    def test_stop_kills_a_real_process_and_removes_the_pidfile(self):
        port = free_port()
        entry = {
            "name": "test-plugin", "url": f"http://localhost:{port}",
            "process": {"command": "/bin/sleep", "args": ["30"]},
        }
        ppm.start(entry)
        self.assertTrue(ppm.is_running("test-plugin"))
        self.assertTrue(ppm.stop("test-plugin"))
        self.assertFalse(ppm.is_running("test-plugin"))
        self.assertFalse(ppm._pidfile("test-plugin").exists())

    def test_stop_on_an_already_gone_process_is_a_harmless_no_op(self):
        self.assertTrue(ppm.stop("never-started-plugin"))


def _wait_for_state(pid: int, state: str, timeout: float = 3.0) -> bool:
    """True once /proc/<pid>/stat reports `state` (e.g. 'Z' for a zombie)."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            raw = Path(f"/proc/{pid}/stat").read_text()
        except OSError:
            return False
        if raw.rsplit(")", 1)[1].split()[0] == state:
            return True
        time.sleep(0.02)
    return False


@unittest.skipUnless(Path("/proc/self/stat").exists(), "needs /proc")
class ZombieLivenessTest(TmpStateDirTest):
    """2026-10-24: a plugin that exited but was never reaped stays a zombie of the dashboard; os.kill(pid, 0)
    succeeds for it, so is_running() said True and ensure-started never relaunched the chat plugin."""

    def _zombie(self, key="zombie-plugin"):
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        self.assertTrue(_wait_for_state(child.pid, "Z"), "child did not become a zombie")
        ppm.PID_DIR.mkdir(parents=True, exist_ok=True)
        ppm._pidfile(key).write_text(str(child.pid))
        return key, child

    def test_zombie_is_not_running_and_gets_reaped(self):
        key, child = self._zombie()
        self.assertFalse(ppm.is_running(key))
        self.assertFalse(Path(f"/proc/{child.pid}").exists(), "the zombie was not reaped")

    def test_stop_of_a_zombie_returns_true_quickly(self):
        key, child = self._zombie()
        started = time.time()
        self.assertTrue(ppm.stop(key, wait_s=3.0))
        self.assertLess(time.time() - started, 1.0)
        self.assertFalse(ppm._pidfile(key).exists())

    def test_a_live_child_still_reports_running(self):
        child = subprocess.Popen(["sleep", "30"])
        self.addCleanup(lambda: (child.kill(), child.wait()))
        ppm.PID_DIR.mkdir(parents=True, exist_ok=True)
        ppm._pidfile("live-plugin").write_text(str(child.pid))
        self.assertTrue(ppm.is_running("live-plugin"))

    def test_missing_pidfile_is_not_running(self):
        self.assertFalse(ppm.is_running("no-such-plugin"))


if __name__ == "__main__":
    unittest.main()


class BehindCheckoutTest(TmpStateDirTest):
    """Tests for PluginProcessManager.behind_checkout() -- the behind-checkout detection
    that flags plugins running from a stale checkout (started before the current HEAD)."""

    def _create_throwaway_repo(self, tmpdir: Path) -> Path:
        """Create a fresh git repo with one initial commit, return its path."""
        repo = tmpdir / "plugin-repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=str(repo), capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=str(repo), capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=str(repo), capture_output=True, check=True)
        (repo / "README.md").write_text("initial")
        subprocess.run(["git", "add", "README.md"], cwd=str(repo), capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=str(repo), capture_output=True, check=True)
        return repo

    def _setup_fake_pidfile(self, repo: Path, mtime_offset: int) -> Path:
        """Create a fake pidfile with a specific mtime offset from now (seconds).
        Returns the pidfile path."""
        pidfile = ppm._pidfile("test-plugin")
        pidfile.parent.mkdir(parents=True, exist_ok=True)
        pidfile.write_text("99999")  # fake pid
        
        # Calculate the target mtime: now + offset
        now = time.time()
        target_mtime = now + mtime_offset
        os.utime(pidfile, (target_mtime, target_mtime))
        
        return pidfile

    def test_behind_after_a_later_commit(self):
        """Plugin started BEFORE the latest commit should be flagged as behind."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            repo = self._create_throwaway_repo(tmp)
            
            # Create a pidfile with mtime BEFORE the initial commit (1 hour ago)
            pidfile = self._setup_fake_pidfile(repo, -3600)
            
            # Make a new commit (HEAD is now newer than pidfile mtime)
            (repo / "new-file.txt").write_text("updated")
            subprocess.run(["git", "add", "new-file.txt"], cwd=str(repo), capture_output=True, check=True)
            subprocess.run(["git", "commit", "-m", "second commit"], cwd=str(repo), capture_output=True, check=True)
            
            # Verify git log shows the new commit
            result = subprocess.run(["git", "log", "-1", "--format=%ct"], cwd=str(repo), capture_output=True, text=True, check=True)
            new_commit_time = int(result.stdout.strip())
            self.assertGreater(new_commit_time, pidfile.stat().st_mtime)
            
            # Now test behind_checkout
            # We need to mock is_running to return True (since pid 99999 doesn't exist)
            entry = {"name": "test-plugin", "cwd": str(repo)}
            
            with mock.patch.object(ppm, "is_running", return_value=True):
                result = ppm.PluginProcessManager().behind_checkout(entry)
            
            self.assertTrue(result["behind"], "should detect being behind")
            self.assertIsNotNone(result["startedAt"])
            self.assertIsNotNone(result["headCommittedAt"])
            self.assertIsInstance(result["files"], list)

    def test_not_behind_after_a_restart(self):
        """Plugin restarted AFTER the latest commit should NOT be flagged as behind."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            repo = self._create_throwaway_repo(tmp)
            
            # Create a pidfile with mtime AFTER the initial commit (1 hour from now)
            pidfile = self._setup_fake_pidfile(repo, 3600)
            
            # Verify git log still shows the same commit (no new commits)
            result = subprocess.run(["git", "log", "-1", "--format=%ct"], cwd=str(repo), capture_output=True, text=True, check=True)
            current_commit_time = int(result.stdout.strip())
            self.assertLess(current_commit_time, pidfile.stat().st_mtime)
            
            # Now test behind_checkout
            entry = {"name": "test-plugin", "cwd": str(repo)}
            
            with mock.patch.object(ppm, "is_running", return_value=True):
                result = ppm.PluginProcessManager().behind_checkout(entry)
            
            self.assertFalse(result["behind"], "should NOT detect being behind")
            self.assertIsNotNone(result["startedAt"])
            self.assertIsNotNone(result["headCommittedAt"])

    def test_not_running_gives_behind_false(self):
        """A plugin that is not running should report behind=False with no side effects."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            repo = self._create_throwaway_repo(tmp)
            
            # Test behind_checkout on a non-running plugin
            entry = {"name": "test-plugin", "cwd": str(repo)}
            
            with mock.patch.object(ppm, "is_running", return_value=False):
                result = ppm.PluginProcessManager().behind_checkout(entry)
            
            self.assertFalse(result["behind"], "should be False when not running")
            self.assertIsNone(result["startedAt"])
            self.assertIsNone(result["headCommittedAt"])
            self.assertEqual(result["files"], [])

    def test_merge_response_includes_restart_needed_for_behind_plugin(self):
        """When a plugin is behind, the merge response should include restartNeeded: true."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            repo = self._create_throwaway_repo(tmp)
            
            # Create a pidfile with mtime BEFORE the initial commit
            pidfile = self._setup_fake_pidfile(repo, -3600)
            
            # Make a new commit
            (repo / "new-file.txt").write_text("updated")
            subprocess.run(["git", "add", "new-file.txt"], cwd=str(repo), capture_output=True, check=True)
            subprocess.run(["git", "commit", "-m", "second commit"], cwd=str(repo), capture_output=True, check=True)
            
            # Test behind_checkout
            entry = {"name": "test-plugin", "cwd": str(repo)}
            
            with mock.patch.object(ppm, "is_running", return_value=True):
                result = ppm.PluginProcessManager().behind_checkout(entry)
            
            # Verify the result structure matches what routes/plugins.py expects
            self.assertTrue(result["behind"])
            self.assertIn("startedAt", result)
            self.assertIn("headCommittedAt", result)
            self.assertIn("files", result)
            
            # Simulate what routes/plugins.py does: set restartNeeded based on behind
            entry_with_restart = dict(entry)
            entry_with_restart["restartNeeded"] = bool(result.get("behind"))
            
            self.assertTrue(entry_with_restart["restartNeeded"], "restartNeeded should be True for behind plugin")
