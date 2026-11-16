"""Tests for python/dashboard/cloud_dial_rates.py: gateway readings and the 10-minute rate ring. Fetches are fakes and the clock is a number; nothing touches a gateway.

Run: .venv/bin/python -m unittest python.dashboard.test_cloud_dial_rates -v
"""
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import cloud_dial_rates as rates  # noqa: E402


def lane(n, port=None, cloud=True):
    return {"id": "worker-cloud" if n == 1 else f"worker-cloud{n}", "cloud": cloud, "env": {"OLLAMA_URL": f"http://127.0.0.1:{port or 7400 + n}/"}}


def meter(calls, tin=0, tout=0):
    return {"monthToDate": {"calls": calls, "inputTokens": tin, "outputTokens": tout}, "today": {"calls": 1}}


class MeterTotalsTest(unittest.TestCase):
    def test_reads_month_to_date_calls_and_tokens(self):
        self.assertEqual(rates.meter_totals(meter(7, 100, 20)), (7, 100, 20))

    def test_anything_else_is_none(self):
        for bad in (None, "x", [], {}, {"monthToDate": None}, {"monthToDate": {"calls": 1}}, meter(-1), meter(1.5), meter(True), {"monthToDate": {"calls": "3", "inputTokens": 0, "outputTokens": 0}}):
            self.assertIsNone(rates.meter_totals(bad), repr(bad))


class ReadGatewaysTest(unittest.TestCase):
    def test_sums_separate_ledgers_one_reading_per_endpoint_with_tokens_added(self):
        answers = {"http://127.0.0.1:7401/meter": meter(10, 100, 10), "http://127.0.0.1:7402/meter": meter(5, 50, 5)}
        out = rates.read_gateways([lane(1), lane(2)], lambda url, t: answers[url])
        self.assertEqual(out["readings"], {"http://127.0.0.1:7401": (10, 110), "http://127.0.0.1:7402": (5, 55)})
        self.assertEqual((out["unavailable"], out["sharedLedgers"]), ([], 0))

    def test_a_down_slow_or_garbled_gateway_is_unavailable_never_an_exception(self):
        def fetch(url, t):
            if url.endswith("7401/meter"):
                raise TimeoutError("slow")
            if url.endswith("7402/meter"):
                return {"not": "a meter"}
            return meter(3, 1, 1)
        out = rates.read_gateways([lane(1), lane(2), lane(3)], fetch)
        self.assertEqual(sorted(out["unavailable"]), ["worker-cloud", "worker-cloud2"])
        self.assertEqual(list(out["readings"]), ["http://127.0.0.1:7403"])

    def test_two_lanes_on_one_endpoint_are_fetched_once(self):
        seen = []
        rates.read_gateways([lane(1, 7450), lane(2, 7450)], lambda url, t: seen.append(url) or meter(1))
        self.assertEqual(seen, ["http://127.0.0.1:7450/meter"])

    def test_when_a_shared_endpoint_is_down_every_lane_on_it_is_listed_unavailable(self):
        def fetch(url, t):
            raise OSError("refused")
        out = rates.read_gateways([lane(1, 7450), lane(2, 7450), lane(3)], fetch)
        self.assertEqual(out["unavailable"], ["worker-cloud", "worker-cloud2", "worker-cloud3"])

    def test_identical_non_zero_totals_on_two_endpoints_count_as_one_shared_ledger(self):
        out = rates.read_gateways([lane(1), lane(2)], lambda url, t: meter(9, 90, 9))
        self.assertEqual(list(out["readings"]), ["http://127.0.0.1:7401"])
        self.assertEqual(out["sharedLedgers"], 1)

    def test_two_idle_gateways_that_both_read_zero_are_not_merged(self):
        out = rates.read_gateways([lane(1), lane(2)], lambda url, t: meter(0))
        self.assertEqual(len(out["readings"]), 2)
        self.assertEqual(out["sharedLedgers"], 0)

    def test_non_cloud_lanes_and_bad_input_are_ignored(self):
        calls = []
        out = rates.read_gateways([lane(1, cloud=False), None, {"id": "x", "cloud": True, "env": {}}, "junk"], lambda u, t: calls.append(u))
        self.assertEqual((calls, out["readings"]), ([], {}))
        self.assertEqual(rates.read_gateways(None, None), {"readings": {}, "unavailable": [], "sharedLedgers": 0})

    def test_gateways_are_fetched_in_parallel_with_the_short_timeout(self):
        barrier = threading.Barrier(4, timeout=5)
        timeouts = []

        def fetch(url, t):
            timeouts.append(t)
            barrier.wait()          # only passes when four fetches are in flight at once
            return meter(int(url.split(':')[2].split('/')[0]))      # a distinct total per gateway, so none is merged as a shared ledger
        out = rates.read_gateways([lane(n) for n in range(1, 5)], fetch)
        self.assertEqual(len(out["readings"]), 4)
        self.assertEqual(out["unavailable"], [], "a serial implementation would have broken the barrier and marked lanes unavailable")
        self.assertEqual(set(timeouts), {rates.METER_TIMEOUT_S})


class RateRingTest(unittest.TestCase):
    A, B = "http://a", "http://b"

    def test_none_until_two_readings_exist(self):
        ring = rates.RateRing()
        self.assertIsNone(ring.rates(0)["callsPerHour"])
        ring.add(0, {self.A: (10, 100)})
        self.assertEqual(ring.rates(0), {"callsPerHour": None, "tokensPerHour": None, "windowS": None})

    def test_rate_per_hour_from_the_oldest_and_newest_reading(self):
        ring = rates.RateRing()
        ring.add(0, {self.A: (100, 1000), self.B: (50, 500)})
        ring.add(300, {self.A: (130, 1600), self.B: (60, 800)})     # +40 calls, +900 tokens in 5 minutes
        r = ring.rates(300)
        self.assertEqual((r["callsPerHour"], r["tokensPerHour"], r["windowS"]), (480.0, 10800.0, 300))

    def test_readings_older_than_the_window_are_dropped(self):
        ring = rates.RateRing(600)
        ring.add(0, {self.A: (0, 0)})
        ring.add(300, {self.A: (50, 500)})
        ring.add(900, {self.A: (150, 1500)})                         # the t=0 row is now 900 s old and leaves; oldest is t=300
        r = ring.rates(900)
        self.assertEqual((r["callsPerHour"], r["windowS"]), (600.0, 600))

    def test_a_gateway_missing_from_one_end_or_reset_is_left_out_not_negative(self):
        ring = rates.RateRing()
        ring.add(0, {self.A: (100, 1000), self.B: (50, 500)})
        ring.add(600, {self.A: (160, 1600), self.B: (3, 30)})        # B was reset: skipped
        self.assertEqual(ring.rates(600)["callsPerHour"], 360.0)
        ring2 = rates.RateRing()
        ring2.add(0, {self.A: (10, 10)})
        ring2.add(60, {self.B: (99, 99)})                            # no endpoint in both
        self.assertIsNone(ring2.rates(60)["callsPerHour"])

    def test_same_instant_and_bad_readings_give_none(self):
        ring = rates.RateRing()
        ring.add(10, {self.A: (1, 1)})
        ring.add(10, {self.A: (9, 9)})
        self.assertIsNone(ring.rates(10)["callsPerHour"])
        ring.add(20, "junk")
        self.assertEqual(len(ring._rows), 2)


if __name__ == "__main__":
    unittest.main()
