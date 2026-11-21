"""Tests for python/dashboard/cloud_dial.py: per-lane dial states and counts from injected inputs. No node, filesystem or network.

Run: .venv/bin/python -m unittest python.dashboard.test_cloud_dial -v
"""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import cloud_dial  # noqa: E402

NOW = datetime(2026, 11, 16, 12, 0, 0, tzinfo=timezone.utc)


def beat(status="idle", pass_=None, age_s=5):
    return {"instanceId": "x", "status": status, "currentPass": pass_, "lastHeartbeat": (NOW - timedelta(seconds=age_s)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}


def lanes(*pairs):
    return [{"id": i, "rank": n, "off": off} for n, (i, off) in enumerate(pairs)]


class LaneStateTest(unittest.TestCase):
    def state(self, hb, off=False, switched=False):
        return cloud_dial.lane_state("worker-cloud", off, hb, switched, NOW)

    def test_working_checking_and_queued_are_active(self):
        for status in ("working", "checking", "queued"):
            self.assertEqual(self.state(beat(status)), "active", status)

    def test_idle_and_other_alive_statuses_are_idle(self):
        for status, p in (("idle", None), ("warming", None), ("paused", "gpu-session"), ("starting", None)):
            self.assertEqual(self.state(beat(status, p)), "idle", status)

    def test_paused_with_pass_ram_is_held_for_ram_but_gpu_session_pause_is_not(self):
        self.assertEqual(self.state(beat("paused", "ram")), "heldForRam")
        self.assertEqual(self.state(beat("paused", "gpu-session")), "idle")
        self.assertEqual(self.state(beat("idle", "ram")), "idle", "pass ram only counts with status paused")

    def test_dial_off_beats_everything_except_the_operator_switch(self):
        self.assertEqual(self.state(beat("working"), off=True), "dialOff")
        self.assertEqual(self.state(beat("disabled", "dial"), off=True), "dialOff")
        self.assertEqual(self.state(None, off=True), "dialOff", "a dial-off lane with no heartbeat is still dialOff, not stale")
        self.assertEqual(self.state(beat("disabled"), off=True, switched=True), "switchedOff")
        self.assertEqual(self.state(beat("idle"), switched=True), "switchedOff")

    def test_missing_unreadable_and_old_heartbeats_are_stale(self):
        for hb in (None, "junk", {}, {"status": "idle"}, {"status": "idle", "lastHeartbeat": "not a time"}):
            self.assertEqual(self.state(hb), "stale", repr(hb))
        self.assertEqual(self.state(beat("idle", age_s=cloud_dial.OTHER_STALE_S + 1)), "stale")
        self.assertEqual(self.state(beat("idle", age_s=cloud_dial.OTHER_STALE_S - 1)), "idle")

    def test_a_working_lane_gets_the_longer_threshold(self):
        self.assertEqual(self.state(beat("working", age_s=cloud_dial.OTHER_STALE_S + 60)), "active")
        self.assertEqual(self.state(beat("working", age_s=cloud_dial.WORKING_STALE_S + 1)), "stale")


    def test_a_timestamp_without_a_zone_is_read_as_utc_not_an_error(self):
        hb = {"status": "idle", "lastHeartbeat": (NOW - timedelta(seconds=5)).strftime("%Y-%m-%dT%H:%M:%S")}
        self.assertEqual(self.state(hb), "idle")


class LaneStatesTest(unittest.TestCase):
    def test_states_follow_the_dial_lanes_in_their_order_with_rank(self):
        dial = lanes(("worker-cloud", False), ("worker-cloud2", False), ("worker-cloud3", True))
        beats = {"worker-cloud": beat("working"), "worker-cloud2": beat("idle"), "worker-cloud3": beat("disabled", "dial")}
        out = cloud_dial.lane_states(dial, beats, set(), NOW)
        self.assertEqual(out, [{"id": "worker-cloud", "rank": 0, "state": "active"}, {"id": "worker-cloud2", "rank": 1, "state": "idle"}, {"id": "worker-cloud3", "rank": 2, "state": "dialOff"}])

    def test_the_disabled_set_marks_a_lane_switched_off(self):
        out = cloud_dial.lane_states(lanes(("worker-cloud", False), ("worker-cloud2", False)), {"worker-cloud": beat(), "worker-cloud2": beat()}, {"worker-cloud2"}, NOW)
        self.assertEqual([l["state"] for l in out], ["idle", "switchedOff"])

    def test_malformed_input_is_skipped_never_raised(self):
        self.assertEqual(cloud_dial.lane_states(None, None, None, NOW), [])
        self.assertEqual(cloud_dial.lane_states("x", {}, set(), NOW), [])
        out = cloud_dial.lane_states([None, {"rank": 1}, {"id": 5}, {"id": "worker-cloud", "rank": True}], None, None, NOW)
        self.assertEqual(out, [{"id": "worker-cloud", "rank": None, "state": "stale"}])

    def test_a_lane_with_no_heartbeat_in_the_map_is_stale(self):
        self.assertEqual(cloud_dial.lane_states(lanes(("worker-cloud", False)), {}, set(), NOW)[0]["state"], "stale")


class CountsTest(unittest.TestCase):
    def test_counts_every_bucket_and_limited_stays_zero(self):
        rows = [{"state": s} for s in ("active", "active", "idle", "dialOff", "dialOff", "dialOff", "switchedOff", "heldForRam", "stale")]
        self.assertEqual(cloud_dial.counts(rows), {"active": 2, "idle": 1, "dialOff": 3, "switchedOff": 1, "heldForRam": 1, "limited": 0, "stale": 1})

    def test_empty_unknown_and_malformed_rows(self):
        zero = {name: 0 for name in cloud_dial.BUCKETS}
        self.assertEqual(cloud_dial.counts([]), zero)
        self.assertEqual(cloud_dial.counts(None), zero)
        self.assertEqual(cloud_dial.counts([None, {}, {"state": "bogus"}, "x"]), zero)

    def test_counts_add_up_to_the_lane_count(self):
        dial = lanes(*[(f"worker-cloud{n}", n >= 5) for n in range(1, 9)])
        beats = {f"worker-cloud{n}": beat("working" if n % 2 else "idle") for n in range(1, 9)}
        c = cloud_dial.counts(cloud_dial.lane_states(dial, beats, {"worker-cloud2"}, NOW))
        self.assertEqual(sum(c.values()), 8)
        self.assertEqual((c["dialOff"], c["switchedOff"]), (4, 1))


if __name__ == "__main__":
    unittest.main()
