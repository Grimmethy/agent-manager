"""Tests for single_flight_lock.py's acquire()/release() (2026-08-24, Chat panel's
"fully reserve the reasoning model" toggle -- needs a lock that spans multiple separate
HTTP requests, which held()'s contextmanager shape can't do). No extra dependencies,
matching python/test_build_graph.py's own zero-dependency stdlib-unittest convention.

Run: .venv/bin/python -m unittest python.dashboard.test_single_flight_lock -v
"""
import os
import subprocess
import sys
import tempfile
import threading
import time
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

    def test_acquire_with_no_key_uses_the_original_global_lockfile(self):
        d = Path(tempfile.mkdtemp())
        fh = single_flight_lock.acquire(d)
        self.assertTrue((d / single_flight_lock.LOCK_NAME).exists())
        single_flight_lock.release(fh)

    def test_acquire_with_a_key_uses_a_separate_per_model_lockfile(self):
        d = Path(tempfile.mkdtemp())
        fh = single_flight_lock.acquire(d, "qwen2.5:3b")
        expected = d / ".pipeline-single-flight.qwen2.5_3b.lock"
        self.assertTrue(expected.exists())
        self.assertFalse((d / single_flight_lock.LOCK_NAME).exists())
        single_flight_lock.release(fh)

    def test_two_different_keys_do_not_block_each_other(self):
        d = Path(tempfile.mkdtemp())
        fh_a = single_flight_lock.acquire(d, "model-a")
        try:
            # A real bash flock -n against model-b's own lockfile must succeed even while
            # model-a's lock is held -- this is the actual throughput fix: two different
            # models no longer serialize against each other.
            result = subprocess.run(
                ["bash", "-c",
                 f'exec 200>"{d / single_flight_lock._lock_name("model-b")}"; flock -n 200 && echo GOT_IT || echo BLOCKED'],
                capture_output=True, text=True,
            )
            self.assertIn("GOT_IT", result.stdout)
        finally:
            single_flight_lock.release(fh_a)

    def test_the_same_key_still_serializes_against_itself(self):
        d = Path(tempfile.mkdtemp())
        fh_a = single_flight_lock.acquire(d, "model-a")
        try:
            result = subprocess.run(
                ["bash", "-c",
                 f'exec 200>"{d / single_flight_lock._lock_name("model-a")}"; flock -n 200 && echo GOT_IT || echo BLOCKED'],
                capture_output=True, text=True,
            )
            self.assertIn("BLOCKED", result.stdout)
        finally:
            single_flight_lock.release(fh_a)

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

    def test_acquire_is_bounded_and_times_out_when_another_process_holds_the_lock(self):
        # 2026-08-31 parity with single-flight-lock.js / agent-manager-common.sh: acquire()
        # used to be an unbounded fcntl.flock(LOCK_EX), so a stuck holder hung the caller
        # forever. It now honours SINGLE_FLIGHT_LOCK_TIMEOUT_SECS and raises TimeoutError
        # with "timed out" in the message.
        d = Path(tempfile.mkdtemp())
        lockfile = d / single_flight_lock.LOCK_NAME
        holder = subprocess.Popen(["bash", "-c", f'exec 200>"{lockfile}"; flock 200; sleep 30'])
        try:
            time.sleep(0.3)  # let the holder actually acquire
            prev = os.environ.get("SINGLE_FLIGHT_LOCK_TIMEOUT_SECS")
            os.environ["SINGLE_FLIGHT_LOCK_TIMEOUT_SECS"] = "1"
            try:
                start = time.monotonic()
                with self.assertRaises(TimeoutError) as ctx:
                    single_flight_lock.acquire(d)
                elapsed = time.monotonic() - start
                self.assertIn("timed out", str(ctx.exception))
                self.assertLess(elapsed, 5, "must give up near the 1s deadline, not hang")
            finally:
                if prev is None:
                    os.environ.pop("SINGLE_FLIGHT_LOCK_TIMEOUT_SECS", None)
                else:
                    os.environ["SINGLE_FLIGHT_LOCK_TIMEOUT_SECS"] = prev
        finally:
            holder.kill()
            holder.wait()

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


class PriorityMarkerTest(unittest.TestCase):
    def test_marker_present_during_block_and_kept_fresh_then_removed(self):
        d = Path(tempfile.mkdtemp())
        wait_dir = d / single_flight_lock.PRIORITY_WAIT_DIR_NAME
        with single_flight_lock.priority_marker(d):
            markers = list(wait_dir.iterdir())
            self.assertEqual(len(markers), 1, "one marker while the with-block is open")
            m = markers[0]
            # backdate it, then confirm the refresher thread touches it forward
            old = time.time() - 30
            os.utime(m, (old, old))
            time.sleep(6.0)
            self.assertGreater(m.stat().st_mtime, old + 3, "the daemon thread re-touches the marker")
        self.assertEqual(list(wait_dir.iterdir()), [], "marker removed on exit")

    def test_best_effort_when_dir_cannot_be_made(self):
        # A path whose parent is a file -> mkdir fails -> yields anyway, no raise.
        f = Path(tempfile.mktemp())
        f.write_text("x")
        with single_flight_lock.priority_marker(f / "instances"):
            pass  # just must not raise


if __name__ == "__main__":
    unittest.main()
