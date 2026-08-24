"""Tests for single_flight_lock.py's acquire()/release() (2026-08-24, Chat panel's
"fully reserve the reasoning model" toggle -- needs a lock that spans multiple separate
HTTP requests, which held()'s contextmanager shape can't do). No extra dependencies,
matching python/test_build_graph.py's own zero-dependency stdlib-unittest convention.

Run: .venv/bin/python -m unittest python.dashboard.test_single_flight_lock -v
"""
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import single_flight_lock  # noqa: E402


class AcquireReleaseTest(unittest.TestCase):
    def test_held_still_works_unchanged(self):
        d = Path(tempfile.mkdtemp())
        with single_flight_lock.held(d):
            pass  # must not raise

    def test_acquire_returns_an_open_file_handle_release_closes_it(self):
        d = Path(tempfile.mkdtemp())
        fh = single_flight_lock.acquire(d)
        self.assertFalse(fh.closed)
        single_flight_lock.release(fh)
        self.assertTrue(fh.closed)

    def test_release_none_is_a_safe_noop(self):
        single_flight_lock.release(None)  # must not raise

    def test_acquire_spans_multiple_separate_calls_a_real_bash_flock_blocks_until_release(self):
        d = Path(tempfile.mkdtemp())
        fh = single_flight_lock.acquire(d)
        lockfile = d / single_flight_lock.LOCK_NAME
        blocked = subprocess.run(
            ["bash", "-c", f'exec 200>"{lockfile}"; flock -n 200 && echo GOT_IT || echo BLOCKED'],
            capture_output=True, text=True,
        )
        self.assertIn("BLOCKED", blocked.stdout)
        single_flight_lock.release(fh)
        freed = subprocess.run(
            ["bash", "-c", f'exec 200>"{lockfile}"; flock -n 200 && echo GOT_IT || echo BLOCKED'],
            capture_output=True, text=True,
        )
        self.assertIn("GOT_IT", freed.stdout)

    def test_priority_marker_present_only_while_genuinely_blocked_waiting(self):
        d = Path(tempfile.mkdtemp())
        holder_ready = threading.Event()
        release_holder = threading.Event()

        def hold():
            with single_flight_lock.held(d):
                holder_ready.set()
                release_holder.wait(timeout=5)

        t1 = threading.Thread(target=hold)
        t1.start()
        holder_ready.wait(timeout=2)

        waiter_done = threading.Event()

        def wait_then_acquire():
            with single_flight_lock.held(d):
                waiter_done.set()

        t2 = threading.Thread(target=wait_then_acquire)
        t2.start()
        import time
        time.sleep(0.3)  # give t2 time to genuinely block

        wait_dir = d / single_flight_lock.PRIORITY_WAIT_DIR_NAME
        during = list(wait_dir.iterdir()) if wait_dir.exists() else []
        self.assertEqual(len(during), 1, "exactly one marker while t2 is genuinely blocked")

        release_holder.set()
        t1.join(timeout=5)
        t2.join(timeout=5)
        self.assertTrue(waiter_done.is_set())
        after = list(wait_dir.iterdir()) if wait_dir.exists() else []
        self.assertEqual(after, [], "marker cleared once acquired")


if __name__ == "__main__":
    unittest.main()
