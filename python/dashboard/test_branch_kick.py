import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import branch_kick as bk  # noqa: E402


class FakeTimer:
    """Records the delay and the callback; start() only marks it started, fire() runs it."""
    made = []

    def __init__(self, delay, fn):
        self.delay, self.fn, self.started, self.daemon, self.cancelled = delay, fn, False, False, False
        FakeTimer.made.append(self)

    def start(self):
        self.started = True

    def cancel(self):
        self.cancelled = True

    def fire(self):
        self.fn()


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


class BranchKick(unittest.TestCase):
    def setUp(self):
        FakeTimer.made = []
        bk.reset()
        self.addCleanup(bk.reset)
        env = mock.patch.dict(os.environ, {"AGENT_MANAGER_BRANCH_KICK_MIN_SECONDS": "60"})
        env.start()
        self.addCleanup(env.stop)
        self.clock, self.inv, self.exp = Clock(), mock.Mock(), mock.Mock()

    def kick(self, others=True):
        return bk.kick(self.inv, self.exp if others else None, now=self.clock, timer_factory=FakeTimer)

    def test_the_first_kick_is_honoured_at_once(self):
        self.assertEqual(self.kick(), "now")
        self.inv.assert_called_once_with()
        self.exp.assert_called_once_with()
        self.assertEqual(FakeTimer.made, [])

    def test_a_kick_inside_the_window_is_not_honoured_now_but_scheduled_for_the_end_of_it(self):
        self.kick()
        self.clock.t += 20
        self.assertEqual(self.kick(), "scheduled")
        self.assertEqual(self.inv.call_count, 1)
        timer = FakeTimer.made[0]
        self.assertEqual((timer.delay, timer.started, timer.daemon), (40.0, True, True))

    def test_every_further_kick_in_the_window_joins_the_one_trailing_honour(self):
        self.kick()
        self.clock.t += 5
        self.assertEqual(self.kick(), "scheduled")
        for _ in range(5):
            self.clock.t += 5
            self.assertEqual(self.kick(), "merged")
        self.assertEqual(len(FakeTimer.made), 1)
        FakeTimer.made[0].fire()
        self.assertEqual(self.inv.call_count, 2)
        self.assertEqual(self.exp.call_count, 2)

    def test_after_the_window_the_next_kick_is_honoured_again(self):
        self.kick()
        self.clock.t += 60
        self.assertEqual(self.kick(), "now")
        self.assertEqual(self.inv.call_count, 2)

    def test_the_trailing_honour_opens_a_new_window(self):
        self.kick()
        self.clock.t += 10
        self.kick()
        self.clock.t += 50
        FakeTimer.made[0].fire()
        self.clock.t += 10
        self.assertEqual(self.kick(), "scheduled")          # 10 s after the trailing honour: inside its window
        self.assertEqual(len(FakeTimer.made), 2)

    def test_expiring_the_other_projects_is_remembered_across_coalesced_kicks(self):
        self.kick(others=False)
        self.clock.t += 10
        self.kick(others=False)                              # active project only, coalesced
        self.clock.t += 10
        self.kick(others=True)                               # asks for all projects, coalesced
        FakeTimer.made[0].fire()
        self.exp.assert_called_once_with()

    def test_a_trailing_honour_of_active_only_kicks_leaves_the_other_projects_alone(self):
        self.kick(others=False)
        self.clock.t += 10
        self.kick(others=False)
        FakeTimer.made[0].fire()
        self.assertEqual(self.inv.call_count, 2)
        self.exp.assert_not_called()

    def test_a_wish_for_all_projects_from_a_coalesced_kick_is_not_kept_for_the_next_window(self):
        self.kick()
        self.clock.t += 10
        self.kick()
        FakeTimer.made[0].fire()
        self.exp.reset_mock()
        self.clock.t += 100
        self.kick(others=False)
        self.exp.assert_not_called()

    def test_window_zero_turns_the_throttle_off(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_BRANCH_KICK_MIN_SECONDS": "0"}):
            for _ in range(3):
                self.assertEqual(self.kick(), "now")
        self.assertEqual(self.inv.call_count, 3)
        self.assertEqual(FakeTimer.made, [])

    def test_a_bad_setting_falls_back_to_sixty_seconds(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_BRANCH_KICK_MIN_SECONDS": "soon"}):
            self.assertEqual(bk.min_seconds(), 60.0)
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_BRANCH_KICK_MIN_SECONDS": "-5"}):
            self.assertEqual(bk.min_seconds(), 0.0)

    def test_reset_cancels_a_pending_trailing_honour_and_forgets_the_window(self):
        self.kick()
        self.clock.t += 5
        self.kick()
        bk.reset()
        self.assertTrue(FakeTimer.made[0].cancelled)
        self.assertEqual(self.kick(), "now")

    def test_a_real_timer_runs_the_trailing_honour(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_BRANCH_KICK_MIN_SECONDS": "0.2"}):
            bk.reset()
            done = __import__("threading").Event()
            self.inv.side_effect = lambda: done.set() if self.inv.call_count >= 2 else None
            bk.kick(self.inv, None)
            bk.kick(self.inv, None)
            self.assertTrue(done.wait(2.0))
        self.assertEqual(self.inv.call_count, 2)


if __name__ == "__main__":
    unittest.main()
