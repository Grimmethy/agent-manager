"""Plugin drains in the dashboard's pipeline stop and status routes (python/dashboard/drain_registry.py, routes/pipeline_1_more.py, static/js/project-tab.js).

Run: .venv/bin/python -B -m unittest python.dashboard.test_drain_registry -v   (from the repo root)
Nothing real is stopped: _stop_pipeline and the running checks are mocked, the pids folder is a temp folder and the 'live' pids are this test process or a dead pid.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import drain_registry  # noqa: E402


def dead_pid():
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


class RunningDrains(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = Path(self.tmp.name)

    def pidfile(self, name, text):
        (self.d / name).write_text(f"{text}\n")

    def test_only_live_drain_pidfiles_sorted_by_name(self):
        self.pidfile("drain-verify.pid", os.getpid())
        self.pidfile("drain-hub.pid", os.getpid())
        self.pidfile("drain-dead.pid", dead_pid())
        self.pidfile("drain-junk.pid", "abc")
        self.pidfile("drain-zero.pid", 0)
        self.pidfile("plugin-promptforge.pid", os.getpid())
        self.pidfile("worker-1.pid", os.getpid())
        self.pidfile("dashboard.pid", os.getpid())
        self.assertEqual(drain_registry.running_drains(self.d), [{"name": "hub", "pid": os.getpid()}, {"name": "verify", "pid": os.getpid()}])

    def test_a_missing_folder_is_no_drains(self):
        self.assertEqual(drain_registry.running_drains(self.d / "nothing"), [])

    def test_the_default_folder_is_the_plugin_managers_pids_folder(self):
        import plugin_process_manager
        self.assertEqual(drain_registry.default_pid_dir(), plugin_process_manager.PID_DIR)
        with mock.patch.object(drain_registry, "default_pid_dir", return_value=self.d):
            self.pidfile("drain-x.pid", os.getpid())
            self.assertEqual([d["name"] for d in drain_registry.running_drains()], ["x"])


class Routes(unittest.TestCase):
    def setUp(self):
        import app  # noqa: WPS433
        self.app = app
        self.client = app.app.test_client()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = Path(self.tmp.name)
        for p in (mock.patch.object(drain_registry, "default_pid_dir", return_value=self.d),
                  mock.patch.object(app, "get_active_repo_root", return_value="/repo")):
            p.start()
            self.addCleanup(p.stop)

    def drain(self, name):
        (self.d / f"drain-{name}.pid").write_text(f"{os.getpid()}\n")

    def stop(self, body=None, stopped=("worker-1",)):
        calls = []

        def fake_stop(force=False):
            calls.append((force, sorted(p.name for p in self.d.iterdir())))     # what was on disk when stop.sh would have been launched
            return list(stopped)
        with mock.patch.object(self.app, "_stop_pipeline", side_effect=fake_stop):
            r = self.client.post("/api/pipeline/stop", json=body or {})
        return r, calls

    def status(self, running=False, stoppable=False):
        with mock.patch.object(self.app, "_pipeline_running", return_value=running), mock.patch.object(self.app, "_pipeline_stoppable", return_value=stoppable), \
                mock.patch.object(self.app, "read_env_file", return_value={}):
            return self.client.get("/api/pipeline/status")

    def test_the_stop_route_lists_the_running_drains_next_to_the_workers_and_keeps_its_old_keys(self):
        self.drain("hub")
        self.drain("verify")
        r, calls = self.stop()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json(), {"stopped": ["worker-1"], "drains_stopped": ["hub", "verify"]})
        self.assertEqual(calls, [(False, ["drain-hub.pid", "drain-verify.pid"])])      # read before the stop ran: the files were still there

    def test_the_drain_names_are_read_before_stop_sh_removes_the_pidfiles(self):
        self.drain("hub")

        def stop_removes_files(force=False):
            for p in self.d.iterdir():
                p.unlink()
            return []
        with mock.patch.object(self.app, "_stop_pipeline", side_effect=stop_removes_files):
            r = self.client.post("/api/pipeline/stop", json={"force": True})
        self.assertEqual(r.get_json()["drains_stopped"], ["hub"])

    def test_no_drains_gives_an_empty_list_and_unchanged_behaviour(self):
        r, _ = self.stop()
        self.assertEqual(r.get_json(), {"stopped": ["worker-1"], "drains_stopped": []})
        s = self.status(running=False, stoppable=False)
        self.assertEqual((s.get_json()["drains"], s.get_json()["running"], s.get_json()["stoppable"]), ([], False, False))

    def test_force_is_passed_through(self):
        _, calls = self.stop({"force": True})
        self.assertTrue(calls[0][0])

    def test_status_lists_the_running_drains_and_stays_stoppable_while_one_is_alive_but_running_is_untouched(self):
        self.drain("nw")
        s = self.status(running=False, stoppable=False).get_json()
        self.assertEqual(s["drains"], [{"name": "nw", "pid": os.getpid()}])
        self.assertIs(s["running"], False)                    # the start guard (_pipeline_running) must not change meaning
        self.assertIs(s["stoppable"], True)                   # but the UI keeps offering Stop while a drain is alive
        for k in ("activeRepoRoot", "includeApply", "skipPush"):
            self.assertIn(k, s)

    def test_status_running_stays_true_and_plugin_pidfiles_are_not_reported(self):
        (self.d / "plugin-promptforge.pid").write_text(f"{os.getpid()}\n")
        s = self.status(running=True).get_json()
        self.assertEqual((s["running"], s["stoppable"], s["drains"]), (True, True, []))

    def test_the_start_guard_still_reads_only_the_real_running_check(self):
        self.drain("hub")
        with mock.patch.object(self.app, "_pipeline_running", return_value=False), mock.patch.object(self.app, "_start_pipeline", return_value={"started": True}) as start:
            r = self.client.post("/api/pipeline/start", json={"path": str(self.d)})
        self.assertEqual(r.status_code, 200)                  # a living drain does not block a start
        start.assert_called_once()


class ProjectTab(unittest.TestCase):
    def test_the_stoppable_branch_names_the_drains_still_running(self):
        src = (Path(__file__).parent / "static" / "js" / "project-tab.js").read_text()
        self.assertIn("Drains still running:", src)
        self.assertIn("status.drains.map((d) => escapeHtml(d.name))", src)
        self.assertIn("</div>${drainsNoteHtml(status)}", src)                     # the note sits in the stoppable branch's markup
        self.assertLess(src.index("DAEMONS DETECTED"), src.index("${drainsNoteHtml(status)}"))
        self.assertLess(src.index("${drainsNoteHtml(status)}"), src.index("confirmed not running"))
        self.assertEqual(src.count("${drainsNoteHtml(status)}"), 1)


if __name__ == "__main__":
    unittest.main()
