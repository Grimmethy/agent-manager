"""What the Workers tab reads of a worker's watchdog trigger (routes/worker_trigger.py), 2026-11-02.

Everything lives in a temp HOME; the lock is a real flock held by a real child process. No real state, no systemd.
Run: .venv/bin/python -m unittest python.dashboard.test_worker_trigger -v   (from the repo root)
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from routes import worker_trigger as wt  # noqa: E402

NOW = 1_800_000_000.0
ISO = lambda secs_ago: datetime.fromtimestamp(NOW - secs_ago, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731


class ReadTrigger(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="worker-trigger-tests-")
        self.env = {"HOME": self.home}
        self.dir = Path(self.home) / ".local" / "state" / "pipeline-ops"
        self.dir.mkdir(parents=True)

    def write(self, name, data):
        (self.dir / f"{name}-trigger.json").write_text(json.dumps(data) if not isinstance(data, str) else data)

    def read(self, name="stalled", held=lambda p: False):
        return wt.read_trigger(name, env=self.env, now=NOW, held=held)

    def test_paths_are_the_ones_the_trigger_writes(self):
        self.assertEqual(wt.state_path("verifier", self.env), str(self.dir / "verifier-trigger.json"))
        self.assertEqual(wt.lock_path("verifier", self.env), str(self.dir / "verifier-drain.lock"))

    def test_never_triggered_is_none(self):
        self.assertIsNone(self.read())

    def test_idle_after_a_drain_ended_with_its_age_and_reason(self):
        self.write("stalled", {"sig": "s", "endedAt": ISO(90), "backlog": False, "stopped": "idle", "iterations": 3})
        self.assertEqual(self.read(), {"state": "idle", "checkedAt": None, "checkedAgeS": None, "endedAt": ISO(90), "endedAgeS": 90, "stopped": "idle", "iterations": 3})

    def test_backlog_flag_shows_as_backlog(self):
        self.write("stalled", {"endedAt": ISO(5), "backlog": True, "stopped": "cap", "iterations": 500})
        self.assertEqual(self.read()["state"], "backlog")
        self.write("stalled", {"endedAt": ISO(5), "backlog": "yes"})
        self.assertEqual(self.read()["state"], "idle")

    def test_a_running_drain_wins_over_the_recorded_state_and_works_without_any_state(self):
        self.write("stalled", {"endedAt": ISO(5), "backlog": True})
        self.assertEqual(self.read(held=lambda p: True)["state"], "draining")
        (self.dir / "stalled-trigger.json").unlink()
        r = self.read(held=lambda p: True)
        self.assertEqual((r["state"], r["endedAt"], r["endedAgeS"], r["stopped"], r["iterations"]), ("draining", None, None, None, None))

    def test_the_lock_check_is_asked_about_this_workers_own_lock(self):
        seen = []
        self.read("verifier", held=lambda p: seen.append(p) or False)
        self.assertEqual(seen, [str(self.dir / "verifier-drain.lock")])

    def test_torn_wrong_typed_and_odd_values_are_tolerated(self):
        self.write("stalled", "{torn")
        self.assertIsNone(self.read())
        self.write("stalled", "[1,2]")
        self.assertIsNone(self.read())
        self.write("stalled", {"endedAt": "garbage", "stopped": 5, "iterations": "x", "backlog": False})
        self.assertEqual(self.read(), {"state": "idle", "checkedAt": None, "checkedAgeS": None, "endedAt": None, "endedAgeS": None, "stopped": None, "iterations": None})
        self.write("stalled", {"endedAt": ISO(-100)})
        self.assertEqual(self.read()["endedAgeS"], 0)

    def test_a_lock_check_that_raises_means_not_draining(self):
        def boom(p):
            raise RuntimeError("x")
        self.write("stalled", {"endedAt": ISO(5), "backlog": False})
        self.assertEqual(self.read(held=boom)["state"], "idle")
        (self.dir / "stalled-trigger.json").unlink()
        self.assertIsNone(self.read(held=boom))

    def test_without_an_explicit_clock_the_age_is_measured_against_now(self):
        self.write("stalled", {"endedAt": datetime.fromtimestamp(time.time() - 30, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "backlog": False})
        age = wt.read_trigger("stalled", env=self.env, held=lambda p: False)["endedAgeS"]
        self.assertTrue(25 <= age <= 120, age)

    def write_beat(self, name, text):
        (self.dir / f"{name}-trigger.beat").write_text(text)

    def test_the_heartbeat_gives_the_age_of_the_last_trigger_call_even_without_a_drain_state(self):
        self.write_beat("stalled", ISO(7) + "\n")
        r = self.read()
        self.assertEqual((r["state"], r["checkedAt"], r["checkedAgeS"], r["endedAt"], r["stopped"]), ("idle", ISO(7), 7, None, None))
        self.write("stalled", {"endedAt": ISO(90), "backlog": False, "stopped": "idle", "iterations": 1})
        r = self.read()
        self.assertEqual((r["checkedAgeS"], r["endedAgeS"]), (7, 90))

    def test_no_heartbeat_means_checked_is_none_and_a_garbled_one_too(self):
        self.write("stalled", {"endedAt": ISO(5), "backlog": False})
        self.assertEqual((self.read()["checkedAt"], self.read()["checkedAgeS"]), (None, None))
        self.write_beat("stalled", "not a time\n")
        self.assertIsNone(self.read()["checkedAgeS"])
        self.write_beat("stalled", "")
        self.assertIsNone(self.read()["checkedAgeS"])
        self.write_beat("stalled", ISO(-50) + "\n")
        self.assertEqual(self.read()["checkedAgeS"], 0)

    def test_the_heartbeat_is_per_worker(self):
        self.write_beat("verifier", ISO(3) + "\n")
        self.assertIsNone(self.read("stalled"))
        self.assertEqual(self.read("verifier")["checkedAgeS"], 3)
        self.assertEqual(wt.beat_path("verifier", self.env), str(self.dir / "verifier-trigger.beat"))

    def test_the_other_workers_files_are_not_mixed_up(self):
        self.write("verifier", {"endedAt": ISO(5), "backlog": False})
        self.assertIsNone(self.read("stalled"))
        self.assertEqual(self.read("verifier")["state"], "idle")


class RealLock(unittest.TestCase):
    def test_lock_held_leaks_no_file_descriptors(self):
        d = tempfile.mkdtemp(prefix="worker-trigger-fd-")
        lock = os.path.join(d, "x.lock")
        Path(lock).write_text("")
        before = len(os.listdir("/proc/self/fd"))
        for _ in range(40):
            wt.lock_held(lock)
        self.assertEqual(len(os.listdir("/proc/self/fd")), before)

    def test_lock_held_sees_a_real_flock_and_nothing_else(self):
        d = tempfile.mkdtemp(prefix="worker-trigger-lock-")
        lock = os.path.join(d, "x.lock")
        self.assertFalse(wt.lock_held(lock))                    # no file: nothing running
        Path(lock).write_text("")
        self.assertFalse(wt.lock_held(lock))                    # file, no holder
        code = "import fcntl, os, sys, time; fd = os.open(sys.argv[1], os.O_RDWR); fcntl.flock(fd, fcntl.LOCK_EX); print('locked', flush=True); time.sleep(30)"
        holder = subprocess.Popen([sys.executable, "-c", code, lock], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "locked")
            self.assertTrue(wt.lock_held(lock))
        finally:
            holder.kill()
            holder.wait()
        self.assertFalse(wt.lock_held(lock))                    # released when the holder died
        self.assertFalse(wt.lock_held(d))                       # a directory is not a lock file (EISDIR on flock is not 'held')


if __name__ == "__main__":
    unittest.main()
