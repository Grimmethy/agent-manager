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
