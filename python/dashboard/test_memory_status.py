"""Host-memory state for the dashboard header chip (memory_status.py, /api/summary `memory`, POST /api/memory/unload-ollama), 2026-11-02.

The marker is the file the gpu-broker's classifier writes; the broker is only asked for pause details while memory is tight or critical. Everything is faked here:
no broker, no real /dev/shm file, no network.

Run: .venv/bin/python -m unittest python.dashboard.test_memory_status -v   (from the repo root)
"""
import json
import os
import sys
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import memory_status as ms  # noqa: E402

NOW = 1_800_000_000.0


def reader(data, age=5.0):
    return lambda path: (data, NOW - age)


def marker(state, **extra):
    return {"state": state, "seq": 3, "at": "2026-11-02T12:00:00Z", "reason": "io stall full 57%", "numbers": {"available_mb": 274, "io_full": 56.62}, **extra}


class Status(unittest.TestCase):
    def test_ok_is_just_ok_and_never_asks_the_broker(self):
        out = ms.memory_status(now=NOW, read=reader(marker("ok")), broker_relief=lambda: self.fail("the broker must not be asked while memory is ok"))
        self.assertEqual(out, {"state": "ok"})

    def test_missing_malformed_unknown_stale_or_future_markers_read_as_unknown(self):
        for read in (lambda p: (None, None), reader({"seq": 1}), reader(marker("banana")), reader(marker("tight"), age=331), reader(marker("tight"), age=-5), lambda p: ([], NOW)):
            self.assertEqual(ms.memory_status(now=NOW, read=read, broker_relief=lambda: None), {"state": "unknown"})

    def test_the_age_limit_is_exact_and_configurable(self):
        self.assertEqual(ms.memory_status(now=NOW, read=reader(marker("tight"), age=330), broker_relief=lambda: None)["state"], "tight")
        self.assertEqual(ms.memory_status(now=NOW, read=reader(marker("tight"), age=330.5), broker_relief=lambda: None)["state"], "unknown")
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_MEM_MARKER_MAX_AGE_S": "60"}):
            self.assertEqual(ms.memory_status(now=NOW, read=reader(marker("tight"), age=61), broker_relief=lambda: None)["state"], "unknown")
            self.assertEqual(ms.memory_status(now=NOW, read=reader(marker("tight"), age=60), broker_relief=lambda: None)["state"], "tight")
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_MEM_MARKER_MAX_AGE_S": "soon"}):
            self.assertEqual(ms.max_age_s(), 330)
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_MEM_MARKER_MAX_AGE_S": "-3"}):
            self.assertEqual(ms.max_age_s(), 330)

    def test_tight_without_a_broker_answer_still_reports_reason_and_numbers(self):
        out = ms.memory_status(now=NOW, read=reader(marker("tight")), broker_relief=lambda: None)
        self.assertEqual(out, {"state": "tight", "reason": "io stall full 57%", "numbers": {"available_mb": 274, "io_full": 56.62}, "ageS": 5, "paused": False,
                               "wouldPause": False, "pauseS": None, "canUnload": False})

    def test_critical_with_the_broker_paused_reports_the_pause_length_and_the_unload_switch(self):
        relief = {"paused": True, "would_pause": False, "since": NOW - 125, "ollama_unload": "owner"}
        out = ms.memory_status(now=NOW, read=reader(marker("critical")), broker_relief=lambda: relief)
        self.assertEqual((out["state"], out["paused"], out["wouldPause"], out["pauseS"], out["canUnload"]), ("critical", True, False, 125, True))

    def test_dry_run_reports_would_pause_and_the_unload_is_off_by_default(self):
        out = ms.memory_status(now=NOW, read=reader(marker("tight")), broker_relief=lambda: {"paused": False, "would_pause": True, "since": NOW - 7, "ollama_unload": "off"})
        self.assertEqual((out["paused"], out["wouldPause"], out["pauseS"], out["canUnload"]), (False, True, 7, False))

    def test_no_pause_means_no_pause_length_and_a_bad_since_is_ignored(self):
        out = ms.memory_status(now=NOW, read=reader(marker("tight")), broker_relief=lambda: {"paused": False, "would_pause": False, "since": NOW - 7})
        self.assertIsNone(out["pauseS"])
        for since in (None, "x", 0, -1):
            self.assertIsNone(ms.memory_status(now=NOW, read=reader(marker("tight")), broker_relief=lambda s=since: {"paused": True, "since": s})["pauseS"])
        self.assertEqual(ms.memory_status(now=NOW, read=reader(marker("tight")), broker_relief=lambda: {"paused": True, "since": NOW + 50})["pauseS"], 0)

    def test_numbers_that_are_not_a_dict_become_empty(self):
        self.assertEqual(ms.memory_status(now=NOW, read=reader(marker("tight", numbers="x")), broker_relief=lambda: None)["numbers"], {})

    def test_it_never_raises_whatever_the_dependencies_do(self):
        def boom(*a):
            raise RuntimeError("x")
        self.assertEqual(ms.memory_status(now=NOW, read=boom), {"state": "unknown"})
        self.assertEqual(ms.memory_status(now=NOW, read=reader(marker("tight")), broker_relief=boom), {"state": "unknown"})

    def test_it_reads_a_real_marker_file_written_the_way_the_broker_writes_it(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "m.json")
            with open(p, "w") as f:
                json.dump(marker("critical"), f)
            with mock.patch.dict(os.environ, {"AGENT_MANAGER_MEM_PRESSURE_MARKER": p}):
                out = ms.memory_status(broker_relief=lambda: None)
            self.assertEqual(out["state"], "critical")
            os.utime(p, (time.time() - 1000, time.time() - 1000))
            with mock.patch.dict(os.environ, {"AGENT_MANAGER_MEM_PRESSURE_MARKER": p}):
                self.assertEqual(ms.memory_status(broker_relief=lambda: None), {"state": "unknown"})
            with mock.patch.dict(os.environ, {"AGENT_MANAGER_MEM_PRESSURE_MARKER": os.path.join(d, "missing.json")}):
                self.assertEqual(ms.memory_status(broker_relief=lambda: None), {"state": "unknown"})

    def test_default_marker_path_is_the_one_the_broker_writes(self):
        env = {k: v for k, v in os.environ.items() if k != "AGENT_MANAGER_MEM_PRESSURE_MARKER"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(ms.marker_path(), "/dev/shm/agent-manager-mem-pressure.json")
            self.assertEqual(ms.broker_url(), "http://127.0.0.1:7449")
        with mock.patch.dict(os.environ, {"GPU_BROKER_URL": "http://h:1/"}):
            self.assertEqual(ms.broker_url(), "http://h:1")


class FakeResp:
    def __init__(self, status, body):
        self.status, self._body = status, body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return json.dumps(self._body).encode()


class Unload(unittest.TestCase):
    def post(self, status=200, body=None, raises=None):
        calls = []

        def fake(req, timeout=None):
            calls.append((req.full_url, req.get_method(), json.loads(req.data), timeout))
            if raises:
                raise raises
            return FakeResp(status, body or {})
        return fake, calls

    def test_it_posts_who_to_the_brokers_owner_route_and_passes_the_answer_through(self):
        with mock.patch("memory_status.json.load", side_effect=lambda r: r._body):
            fake, calls = self.post(200, {"ok": True, "unloaded": ["m1"]})
            self.assertEqual(ms.unload_ollama(post=fake), (200, {"ok": True, "unloaded": ["m1"]}))
        self.assertEqual(calls, [("http://127.0.0.1:7449/api/gpu/memory/unload-ollama", "POST", {"who": "dashboard"}, 10)])

    def test_a_refusal_or_a_missing_route_keeps_its_status_so_the_page_can_hide_the_button(self):
        for code, body in ((403, {"ok": False, "error": "disabled"}), (404, {"error": "not found"})):
            err = urllib.error.HTTPError("u", code, "x", {}, None)
            with mock.patch("memory_status.json.load", return_value=body):
                fake, _ = self.post(raises=err)
                self.assertEqual(ms.unload_ollama(post=fake), (code, body))

    def test_an_unreadable_error_body_gets_a_plain_message_and_an_unreachable_broker_is_502(self):
        err = urllib.error.HTTPError("u", 500, "x", {}, None)
        with mock.patch("memory_status.json.load", side_effect=ValueError("not json")):
            fake, _ = self.post(raises=err)
            self.assertEqual(ms.unload_ollama(post=fake), (500, {"error": "broker answered HTTP 500"}))
        fake, _ = self.post(raises=OSError("refused"))
        status, body = ms.unload_ollama(post=fake)
        self.assertEqual(status, 502)
        self.assertIn("broker not reachable", body["error"])


class Routes(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def test_summary_carries_memory_beside_the_cached_counts_and_recomputes_it_on_every_call(self):
        seq = iter([{"state": "ok"}, {"state": "critical", "reason": "r"}])
        with mock.patch("memory_status.memory_status", side_effect=lambda: next(seq)):
            a = self.client.get("/api/summary").get_json()
            b = self.client.get("/api/summary").get_json()
        self.assertEqual((a["memory"], b["memory"]["state"]), ({"state": "ok"}, "critical"))
        self.assertIn("blocked", a)           # the queue counts are still there

    def test_the_unload_route_passes_the_brokers_status_and_body_through(self):
        with mock.patch("memory_status.unload_ollama", return_value=(403, {"ok": False, "error": "disabled"})) as un:
            r = self.client.post("/api/memory/unload-ollama")
        self.assertEqual((r.status_code, r.get_json()), (403, {"ok": False, "error": "disabled"}))
        un.assert_called_once_with(who="dashboard")

    def test_the_unload_route_is_post_only(self):
        self.assertEqual(self.client.get("/api/memory/unload-ollama").status_code, 405)


if __name__ == "__main__":
    unittest.main()


class BrokerReliefFetch(unittest.TestCase):
    def test_it_asks_the_brokers_status_route_with_a_get_and_a_short_timeout_and_returns_memory_relief(self):
        seen = []

        def fake(url, timeout=None, data=None):
            seen.append((url, timeout, data))
            return FakeResp(200, {"memory": {"relief": {"paused": True}}})
        with mock.patch("memory_status.urllib.request.urlopen", side_effect=fake), mock.patch("memory_status.json.load", side_effect=lambda r: r._body):
            self.assertEqual(ms._broker_relief(), {"paused": True})
        self.assertEqual(seen, [("http://127.0.0.1:7449/api/gpu/status", 1.5, None)])

    def test_an_unreachable_or_odd_broker_answer_is_none(self):
        with mock.patch("memory_status.urllib.request.urlopen", side_effect=OSError("refused")):
            self.assertIsNone(ms._broker_relief())
        with mock.patch("memory_status.urllib.request.urlopen", return_value=FakeResp(200, {})), mock.patch("memory_status.json.load", side_effect=ValueError("bad")):
            self.assertIsNone(ms._broker_relief())
        for body in ({}, {"memory": {}}, {"memory": {"relief": "x"}}, {"memory": {"relief": None}}):
            with mock.patch("memory_status.urllib.request.urlopen", return_value=FakeResp(200, body)), mock.patch("memory_status.json.load", side_effect=lambda r: r._body):
                self.assertIsNone(ms._broker_relief(), body)


class UnloadSwitch(unittest.TestCase):
    def test_only_the_exact_owner_setting_offers_the_button(self):
        for value, expect in (("owner", True), ("off", False), ("auto", False), ("on", False), ("", False), (None, False)):
            relief = {"paused": True, "since": NOW - 1}
            if value is not None:
                relief["ollama_unload"] = value
            out = ms.memory_status(now=NOW, read=reader(marker("tight")), broker_relief=lambda r=relief: r)
            self.assertIs(out["canUnload"], expect, value)
