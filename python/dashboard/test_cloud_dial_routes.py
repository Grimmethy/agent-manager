"""Tests for GET and POST /api/cloud-dial (routes/cloud_dial.py). The dial command, the instances directory, the lane definitions and the gateway fetch are all injected or patched,
so nothing here starts node, reads the real queue or calls a gateway, and no test can change the real dial.

Run: .venv/bin/python -m unittest python.dashboard.test_cloud_dial_routes -v
"""
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import cloud_dial_rates  # noqa: E402
from routes import cloud_dial as route  # noqa: E402

IMPORTED_RING = route.RING            # the process-wide ring as the module created it, before any test replaces it
NOW = datetime(2026, 11, 16, 12, 0, 0, tzinfo=timezone.utc)
STATUS = {"count": 2, "mode": "manual", "setAt": "2026-11-16T11:00:00.000Z", "setBy": "operator",
          "lanes": [{"id": "worker-cloud", "rank": 0, "off": False}, {"id": "worker-cloud2", "rank": 1, "off": False}, {"id": "worker-cloud3", "rank": 2, "off": True}]}


def beat(status="idle", pass_=None, age_s=5):
    return {"instanceId": "x", "status": status, "currentPass": pass_, "lastHeartbeat": (NOW - timedelta(seconds=age_s)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}


def defs(*ports):
    return [{"id": "worker-cloud" if i == 0 else f"worker-cloud{i + 1}", "cloud": True, "env": {"OLLAMA_URL": f"http://127.0.0.1:{p}"}} for i, p in enumerate(ports)]


def meter(calls, tin=0, tout=0):
    return {"monthToDate": {"calls": calls, "inputTokens": tin, "outputTokens": tout}}


def fake_run(stdout="", returncode=0, stderr=""):
    return lambda *args: subprocess.CompletedProcess(["node", *args], returncode, stdout, stderr)


class BuildPayloadTest(unittest.TestCase):
    def build(self, status=STATUS, error=None, beats=None, disabled=(), lanes=None, fetch=None, ring=None, now_s=1000.0):
        beats = {"worker-cloud": beat("working"), "worker-cloud2": beat("paused", "ram"), "worker-cloud3": beat("disabled", "dial")} if beats is None else beats
        return route.build_payload(status, error, beats, set(disabled), defs(7401, 7402, 7403) if lanes is None else lanes,
                                   fetch or (lambda url, t: meter(1)), ring or cloud_dial_rates.RateRing(), now_s, NOW)

    def test_payload_shape_and_values(self):
        out = self.build(fetch=lambda url, t: meter(int(url[-10:-6])))
        self.assertTrue(out["available"])
        self.assertEqual((out["requested"], out["mode"], out["setBy"]), (2, "manual", "operator"))
        self.assertEqual([(l["id"], l["rank"], l["state"]) for l in out["lanes"]], [("worker-cloud", 0, "active"), ("worker-cloud2", 1, "heldForRam"), ("worker-cloud3", 2, "dialOff")])
        self.assertEqual(out["counts"], {"active": 1, "idle": 0, "dialOff": 1, "switchedOff": 0, "heldForRam": 1, "limited": 0, "stale": 0})
        self.assertEqual(out["rates"], {"callsPerHour": None, "tokensPerHour": None})
        self.assertIsNone(out["limit"])
        self.assertEqual(out["unavailable"], [])

    def test_unset_dial_reports_requested_none(self):
        out = self.build(status={**STATUS, "count": None, "lanes": [{"id": "worker-cloud", "rank": 0, "off": False}]}, beats={"worker-cloud": beat()})
        self.assertIsNone(out["requested"])
        self.assertEqual(out["counts"]["idle"], 1)

    def test_switched_off_lanes_come_from_the_disabled_set(self):
        out = self.build(disabled={"worker-cloud"})
        self.assertEqual(out["lanes"][0]["state"], "switchedOff")
        self.assertEqual(out["counts"]["switchedOff"], 1)

    def test_rates_appear_from_the_second_reading_with_a_fake_clock(self):
        ring = cloud_dial_rates.RateRing()
        base = {7401: 100, 7402: 200, 7403: 300}
        at = lambda extra: (lambda url, t: meter(base[int(url.split(":")[2].split("/")[0])] + extra, (base[int(url.split(":")[2].split("/")[0])] + extra) * 10))
        first = self.build(ring=ring, now_s=0.0, fetch=at(0))
        self.assertIsNone(first["rates"]["callsPerHour"])
        second = self.build(ring=ring, now_s=600.0, fetch=at(60))
        self.assertEqual(second["rates"], {"callsPerHour": 1080.0, "tokensPerHour": 10800.0})   # three separate ledgers, +60 calls and +600 tokens each, in 600 s

    def test_gateways_reporting_one_shared_ledger_are_counted_once(self):
        ring = cloud_dial_rates.RateRing()
        self.build(ring=ring, now_s=0.0, fetch=lambda url, t: meter(100, 1000, 0))
        out = self.build(ring=ring, now_s=600.0, fetch=lambda url, t: meter(160, 1600, 0))
        self.assertEqual(out["rates"], {"callsPerHour": 360.0, "tokensPerHour": 3600.0})        # three identical meters are ONE ledger: +60 calls in 600 s

    def test_a_down_gateway_is_listed_and_never_raises(self):
        def fetch(url, t):
            if url.startswith("http://127.0.0.1:7402"):
                raise OSError("refused")
            return meter(int(url[-10:-6]))
        out = self.build(fetch=fetch)
        self.assertTrue(out["available"])
        self.assertEqual(out["unavailable"], ["worker-cloud2"])

    def test_unreadable_dial_status_gives_available_false_with_the_error(self):
        out = self.build(status=None, error="node is not installed")
        self.assertEqual(out, {"available": False, "error": "node is not installed"})
        self.assertEqual(self.build(status=None)["available"], False)


class ReadStatusTest(unittest.TestCase):
    def test_parses_the_node_answer(self):
        data, err = route.read_status(fake_run(json.dumps(STATUS)))
        self.assertEqual((data["count"], err), (2, None))

    def test_every_failure_is_a_none_and_a_message(self):
        for run in (fake_run(json.dumps(STATUS), 1, "valid json but node exited non-zero"), fake_run("", 1, "boom"), fake_run("not json"), fake_run("[]"), fake_run('{"count": 1}'), mock.Mock(side_effect=FileNotFoundError("node"))):
            data, err = route.read_status(run)
            self.assertIsNone(data)
            self.assertTrue(err)


class ReadHeartbeatsTest(unittest.TestCase):
    def test_reads_by_instance_id_and_skips_junk(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "a.json").write_text(json.dumps({"instanceId": "worker-cloud", "status": "idle"}))
            (Path(d) / "b.json").write_text("{broken")
            (Path(d) / "c.json").write_text(json.dumps({"status": "idle"}))
            out = route.read_heartbeats(d, app.read_json_safe)
        self.assertEqual(list(out), ["worker-cloud"])

    def test_a_missing_directory_or_none_is_empty(self):
        self.assertEqual(route.read_heartbeats("/nonexistent/dir", app.read_json_safe), {})
        self.assertEqual(route.read_heartbeats(None, app.read_json_safe), {})


class RoutesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.inst = Path(self.tmp.name)
        (self.inst / "w.json").write_text(json.dumps({"instanceId": "worker-cloud", "status": "working", "lastHeartbeat": datetime.now(timezone.utc).isoformat()}))
        self.ran = []

        def run(*args):
            self.ran.append(args)
            if args == ("status",):
                return subprocess.CompletedProcess(["node", *args], 0, json.dumps(STATUS), "")
            return subprocess.CompletedProcess(["node", *args], self.fail_code, "{}", self.fail_err)
        self.fail_code, self.fail_err = 0, ""
        self.patches = [
            mock.patch.object(route, "_run_node", side_effect=run),
            mock.patch.object(app, "instances_dir", return_value=self.inst),
            mock.patch.object(app, "worker_lane_defs", return_value=defs(7401)),
            mock.patch.object(route, "_http_get_json", side_effect=lambda url, t: meter(5)),
            mock.patch("worker_switch.disabled_workers", return_value=set()),
        ]
        for p in self.patches:
            p.start()
        route.RING = cloud_dial_rates.RateRing()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_get_returns_the_payload(self):
        r = self.client.get("/api/cloud-dial")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertTrue(body["available"])
        self.assertEqual(body["requested"], 2)
        self.assertEqual(body["lanes"][0]["state"], "active")
        self.assertEqual(self.ran, [("status",)])

    def test_two_gets_in_one_process_build_the_rate_in_the_shared_ring(self):
        self.assertIsInstance(IMPORTED_RING, cloud_dial_rates.RateRing)
        calls = {"n": 100}
        clock = iter([0.0, 600.0])
        with mock.patch.object(route, "_http_get_json", side_effect=lambda url, t: meter(calls["n"], calls["n"] * 10)), mock.patch.object(route.time, "time", side_effect=lambda: next(clock)):
            first = self.client.get("/api/cloud-dial").get_json()
            calls["n"] = 160
            second = self.client.get("/api/cloud-dial").get_json()
        self.assertIsNone(first["rates"]["callsPerHour"])
        self.assertEqual(second["rates"], {"callsPerHour": 360.0, "tokensPerHour": 3600.0})

    def test_post_count_runs_set_and_answers_with_the_payload(self):
        for body, expected in (({"count": 5}, ("set", "5")), ({"count": 0}, ("set", "0")), ({"count": 1000000}, ("set", "1000000")), ({"count": None}, ("unset",)), ({"mode": "auto"}, ("mode", "auto")), ({"mode": "manual"}, ("mode", "manual"))):
            self.ran.clear()
            r = self.client.post("/api/cloud-dial", json=body)
            self.assertEqual(r.status_code, 200, body)
            self.assertEqual(self.ran[0], expected, body)
            self.assertTrue(r.get_json()["available"])

    def test_post_rejects_bad_bodies_with_400_and_runs_nothing(self):
        bad = [{"count": -1}, {"count": 1.5}, {"count": "3"}, {"count": True}, {"count": False}, {"count": []}, {"mode": "turbo"}, {"mode": None}, {"mode": 1},
               {}, {"count": 1, "mode": "auto"}, {"count": 1, "extra": 1}, {"mode": "auto", "x": 1}, [], "x", 3]
        for body in bad:
            self.ran.clear()
            r = self.client.post("/api/cloud-dial", json=body)
            self.assertEqual(r.status_code, 400, repr(body))
            self.assertEqual(self.ran, [], repr(body))
        self.assertEqual(self.client.post("/api/cloud-dial", data="not json", content_type="text/plain").status_code, 400)
        self.assertEqual(self.client.post("/api/cloud-dial").status_code, 400)

    def test_a_failing_dial_command_is_a_500_with_the_reason(self):
        self.fail_code, self.fail_err = 1, "invalid dial count"
        r = self.client.post("/api/cloud-dial", json={"count": 3})
        self.assertEqual(r.status_code, 500)
        self.assertIn("invalid dial count", r.get_data(as_text=True))

    def test_the_route_never_touches_the_pipeline(self):
        with mock.patch.object(app, "_restart_pipeline", side_effect=AssertionError("restart")), mock.patch.object(app, "_stop_pipeline", side_effect=AssertionError("stop")), \
                mock.patch.object(app, "_start_pipeline", side_effect=AssertionError("start")):
            self.assertEqual(self.client.post("/api/cloud-dial", json={"count": 4}).status_code, 200)
            self.assertEqual(self.client.get("/api/cloud-dial").status_code, 200)


if __name__ == "__main__":
    unittest.main()
