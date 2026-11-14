"""GET/POST /api/pipeline/forge-mode (python/dashboard/forge_mode.py, routes/pipeline_1_more.py) and the watchdog's forge-mode expire line (scripts/queue-watcher.sh).

Run: .venv/bin/python -B -m unittest python.dashboard.test_forge_mode_route -v   (from the repo root)
Nothing real runs: forge_mode.run_script and forge_mode.start_background are mocked; the watcher line is checked as text and the file as a bash syntax check.
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import forge_mode  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
GOOD = {"paused": False, "memAvailMB": 11000, "ioSome10": 12.0, "vm": {"state": "running"}}


class Refusal(unittest.TestCase):
    def test_a_readable_status_goes_whatever_the_memory_and_io_numbers(self):
        self.assertEqual(forge_mode.refusal(GOOD, "keep"), [])
        self.assertEqual(forge_mode.refusal({**GOOD, "memAvailMB": 2000, "ioSome10": 95}, "keep"), [])
        self.assertEqual(forge_mode.refusal({**GOOD, "memAvailMB": None}, "keep"), [])

    def test_unreadable_status_is_refused(self):
        self.assertEqual(len(forge_mode.refusal({"error": "boom"}, "keep")), 1)

    def test_already_paused_is_refused(self):
        self.assertEqual(forge_mode.refusal({**GOOD, "paused": True}, "keep"), ["already in forge mode"])


class RunScript(unittest.TestCase):
    def test_status_parses_json_and_reports_garbage(self):
        with mock.patch.object(forge_mode, "run_script", return_value=(0, json.dumps(GOOD))):
            self.assertEqual(forge_mode.status(), GOOD)
        with mock.patch.object(forge_mode, "run_script", return_value=(1, "not json")):
            self.assertIn("error", forge_mode.status())

    def test_a_missing_node_is_exit_one_not_a_crash(self):
        with mock.patch.object(forge_mode.subprocess, "run", side_effect=FileNotFoundError("node")):
            self.assertEqual(forge_mode.run_script(["status"]), (1, "node"))
        with mock.patch.object(forge_mode.subprocess, "run", side_effect=subprocess.TimeoutExpired("node", 1)):
            self.assertEqual(forge_mode.run_script(["status"])[0], 1)

    def test_script_path_is_the_real_file(self):
        self.assertTrue(forge_mode.SCRIPT.is_file())


class Routes(unittest.TestCase):
    def setUp(self):
        import app  # noqa: WPS433
        self.client = app.app.test_client()

    def post(self, body, st=GOOD):
        with mock.patch.object(forge_mode, "status", return_value=st), mock.patch.object(forge_mode, "start_background") as bg:
            res = self.client.post("/api/pipeline/forge-mode", json=body)
        return res, bg

    def test_get_returns_the_status_json(self):
        with mock.patch.object(forge_mode, "status", return_value=GOOD):
            res = self.client.get("/api/pipeline/forge-mode")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json(), GOOD)

    def test_get_with_an_unreadable_script_is_502(self):
        with mock.patch.object(forge_mode, "status", return_value={"error": "x"}):
            self.assertEqual(self.client.get("/api/pipeline/forge-mode").status_code, 502)

    def test_on_with_headroom_starts_in_the_background_and_answers_202(self):
        res, bg = self.post({"on": True, "vm": "off"})
        self.assertEqual(res.status_code, 202)
        self.assertTrue(res.get_json()["started"])
        bg.assert_called_once_with(["on", "--vm", "off"])

    def test_on_with_low_memory_and_high_io_still_starts(self):
        res, bg = self.post({"on": True}, st={**GOOD, "memAvailMB": 2000, "ioSome10": 90})
        self.assertEqual(res.status_code, 202)
        bg.assert_called_once_with(["on", "--vm", "keep"])

    def test_vm_defaults_to_keep_and_a_bad_vm_is_400(self):
        res, bg = self.post({"on": True})
        bg.assert_called_once_with(["on", "--vm", "keep"])
        res, bg = self.post({"on": True, "vm": "reboot"})
        self.assertEqual(res.status_code, 400)
        bg.assert_not_called()

    def test_off_is_202_and_runs_off_without_a_status_check(self):
        res, bg = self.post({"on": False}, st={**GOOD, "memAvailMB": 1})
        self.assertEqual(res.status_code, 202)
        bg.assert_called_once_with(["off"])

    def test_stop_route_is_untouched(self):
        import app
        with mock.patch.object(app, "_stop_pipeline", return_value=True) as stop, \
                mock.patch.object(app, "get_active_repo_root", return_value="/repo"):
            res = self.client.post("/api/pipeline/stop", json={})
        self.assertEqual(res.status_code, 200)
        stop.assert_called_once()


class WatcherLine(unittest.TestCase):
    def test_expire_runs_once_after_the_drain_registry_sweep_and_never_fails_the_tick(self):
        sh = (REPO / "scripts" / "queue-watcher.sh").read_text()
        line = 'bash "${SCRIPT_DIR}/forge-mode.sh" expire >/dev/null || true'
        self.assertEqual(sh.count(line), 1)
        self.assertLess(sh.index("drain-registry.js\" sweep"), sh.index(line))
        r = subprocess.run(["bash", "-n", str(REPO / "scripts" / "queue-watcher.sh")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_the_wrapper_it_calls_exists(self):
        self.assertTrue((REPO / "scripts" / "forge-mode.sh").is_file())


if __name__ == "__main__":
    unittest.main()
