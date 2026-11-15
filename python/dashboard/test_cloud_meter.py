"""Tests for GET /api/cloud-meter (routes/cloud_meter.py): the Workers tab's Cloud spend panel payload.

The lane definitions and the gateway HTTP call are both injected/mocked, so nothing here touches node, the network or a real gateway.

Run: .venv/bin/python -m unittest python.dashboard.test_cloud_meter -v
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes import cloud_meter  # noqa: E402

CLOUD = {"id": "worker-cloud", "gpu": "cloud", "cloud": True, "provider": "cloud", "env": {"OLLAMA_URL": "http://127.0.0.1:7450/", "LOCAL_MODEL": "claude-haiku-5-5"}}
RX580 = {"id": "worker-rx580", "gpu": "rx580", "env": {"OLLAMA_URL": "http://100.96.112.78:11434"}}
METER = {"monthToDate": {"calls": 3, "inputTokens": 10, "outputTokens": 5, "costUsd": 0.5, "unpriced": False}, "today": {}, "cap": {"usd": None, "mode": "warn", "exceeded": False}, "provider": "anthropic-api", "model": "claude-haiku-5-5"}


class BuildCloudMeterTest(unittest.TestCase):
    def test_no_cloud_lane_means_hidden_panel_and_no_http_call(self):
        calls = []
        out = cloud_meter.build_cloud_meter([RX580], lambda url, t: calls.append(url))
        self.assertEqual(out, {"cloudLane": False, "available": False})
        self.assertEqual(calls, [])

    def test_empty_or_unknown_lanes_count_as_no_cloud_lane(self):
        self.assertEqual(cloud_meter.build_cloud_meter([], None)["cloudLane"], False)
        self.assertEqual(cloud_meter.build_cloud_meter(None, None)["cloudLane"], False)

    def test_reads_the_meter_from_the_cloud_lanes_own_endpoint_with_a_3s_timeout(self):
        seen = []

        def fetch(url, timeout):
            seen.append((url, timeout))
            return dict(METER)

        out = cloud_meter.build_cloud_meter([RX580, CLOUD], fetch)
        self.assertEqual(seen, [("http://127.0.0.1:7450/meter", 3)])
        self.assertTrue(out["available"])
        self.assertTrue(out["cloudLane"])
        self.assertEqual(out["laneId"], "worker-cloud")
        self.assertEqual(out["monthToDate"]["calls"], 3)
        self.assertEqual(out["model"], "claude-haiku-5-5")

    def test_gateway_down_is_a_payload_not_an_exception(self):
        def fetch(url, timeout):
            raise ConnectionRefusedError("[Errno 111] Connection refused")

        out = cloud_meter.build_cloud_meter([CLOUD], fetch)
        self.assertEqual(out["available"], False)
        self.assertEqual(out["cloudLane"], True)
        self.assertIn("refused", out["error"])

    def test_timeout_and_bad_json_are_also_unavailable(self):
        for exc in (TimeoutError("timed out"), ValueError("not json")):
            def fetch(url, timeout, exc=exc):
                raise exc
            self.assertFalse(cloud_meter.build_cloud_meter([CLOUD], fetch)["available"])

    def test_a_non_object_answer_is_unavailable(self):
        out = cloud_meter.build_cloud_meter([CLOUD], lambda url, t: ["not", "a", "meter"])
        self.assertFalse(out["available"])
        self.assertIn("not a meter", out["error"])

    def test_the_gateway_cannot_overwrite_the_lane_fields(self):
        out = cloud_meter.build_cloud_meter([CLOUD], lambda url, t: {**METER, "cloudLane": False, "available": False, "laneId": "evil"})
        self.assertEqual((out["cloudLane"], out["available"], out["laneId"]), (True, True, "worker-cloud"))

    def test_a_cloud_lane_without_an_endpoint_is_unavailable(self):
        out = cloud_meter.build_cloud_meter([{"id": "worker-cloud", "cloud": True, "env": {}}], lambda url, t: METER)
        self.assertFalse(out["available"])


class SwitchedOffTest(unittest.TestCase):
    """2026-11-02: a cloud lane whose worker is switched off (the Workers-tab Turn off button) and whose gateway is stopped on purpose is not an error."""
    def refuse(self, url, timeout):
        raise ConnectionRefusedError("[Errno 111] Connection refused")

    def test_switched_off_and_gateway_down_is_flagged_switched_off_not_just_unreachable(self):
        out = cloud_meter.build_cloud_meter([CLOUD], self.refuse, disabled=lambda: {"worker-cloud"})
        self.assertEqual((out["cloudLane"], out["available"], out["switchedOff"], out["laneId"]), (True, False, True, "worker-cloud"))
        self.assertIn("Connection refused", out["error"])

    def test_not_switched_off_and_gateway_down_keeps_the_plain_error(self):
        for disabled in (lambda: set(), lambda: {"worker-rx580"}, None):
            out = cloud_meter.build_cloud_meter([CLOUD], self.refuse, disabled=disabled)
            self.assertEqual((out["available"], "switchedOff" in out), (False, False))

    def test_switched_off_but_the_gateway_answers_shows_the_real_meter(self):
        out = cloud_meter.build_cloud_meter([CLOUD], lambda url, t: dict(METER), disabled=lambda: {"worker-cloud"})
        self.assertEqual((out["available"], "switchedOff" in out, out["monthToDate"]["calls"]), (True, False, 3))

    def test_the_switch_is_only_looked_up_when_the_meter_could_not_be_read(self):
        calls = []
        cloud_meter.build_cloud_meter([CLOUD], lambda url, t: dict(METER), disabled=lambda: calls.append(1) or set())
        self.assertEqual(calls, [])
        cloud_meter.build_cloud_meter([CLOUD], self.refuse, disabled=lambda: calls.append(1) or set())
        self.assertEqual(calls, [1])

    def test_a_broken_switch_lookup_means_not_switched_off(self):
        def boom():
            raise RuntimeError("node missing")
        out = cloud_meter.build_cloud_meter([CLOUD], self.refuse, disabled=boom)
        self.assertEqual((out["available"], "switchedOff" in out), (False, False))

    def test_the_other_unavailable_cases_are_flagged_too(self):
        off = lambda: {"worker-cloud"}  # noqa: E731
        self.assertTrue(cloud_meter.build_cloud_meter([CLOUD], lambda u, t: ["x"], disabled=off)["switchedOff"])
        no_endpoint = {**CLOUD, "env": {}}
        out = cloud_meter.build_cloud_meter([no_endpoint], self.refuse, disabled=off)
        self.assertEqual((out["switchedOff"], out["error"]), (True, "the cloud lane has no endpoint"))

    def test_a_lane_without_an_id_is_never_switched_off(self):
        out = cloud_meter.build_cloud_meter([{**CLOUD, "id": None}], self.refuse, disabled=lambda: {None, "worker-cloud"})
        self.assertNotIn("switchedOff", out)

    def test_the_route_passes_the_switch_lookup_and_flags_the_payload(self):
        client = app.app.test_client()
        with mock.patch.object(app, "worker_lane_defs", return_value=[CLOUD]), mock.patch.object(cloud_meter, "_http_get_json", side_effect=ConnectionRefusedError("refused")), \
                mock.patch("worker_switch.disabled_workers", return_value={"worker-cloud"}):
            body = client.get("/api/cloud-meter").get_json()
        self.assertEqual((body["available"], body["switchedOff"]), (False, True))
        with mock.patch.object(app, "worker_lane_defs", return_value=[CLOUD]), mock.patch.object(cloud_meter, "_http_get_json", side_effect=ConnectionRefusedError("refused")), \
                mock.patch("worker_switch.disabled_workers", return_value=set()):
            self.assertNotIn("switchedOff", client.get("/api/cloud-meter").get_json())


class CloudMeterRouteTest(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def test_route_with_the_gateway_down_answers_200_with_available_false(self):
        with mock.patch.object(app, "worker_lane_defs", return_value=[CLOUD]), \
                mock.patch.object(cloud_meter, "_http_get_json", side_effect=ConnectionRefusedError("refused")):
            res = self.client.get("/api/cloud-meter")
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertEqual((body["cloudLane"], body["available"]), (True, False))

    def test_route_proxies_the_gateway_meter(self):
        with mock.patch.object(app, "worker_lane_defs", return_value=[CLOUD]), \
                mock.patch.object(cloud_meter, "_http_get_json", return_value=dict(METER)) as get:
            res = self.client.get("/api/cloud-meter")
        get.assert_called_once_with("http://127.0.0.1:7450/meter", 3)
        self.assertEqual(res.get_json()["monthToDate"]["calls"], 3)

    def test_route_without_a_cloud_lane_hides_the_panel(self):
        with mock.patch.object(app, "worker_lane_defs", return_value=[RX580]):
            res = self.client.get("/api/cloud-meter")
        self.assertEqual(res.get_json(), {"cloudLane": False, "available": False})


if __name__ == "__main__":
    unittest.main()
