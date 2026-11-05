"""The dashboard event channel (event_stream.py, routes/event_stream.py, /api/summary `eventStream`): ADR-0024, 'UI triggers, not polls' piece 1.

Run: .venv/bin/python -m unittest test_event_stream -v   (from python/dashboard)
Real temp pipeline directories; the watcher thread is never started here: poll_once()/reconcile() are called by hand.
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import event_stream as es  # noqa: E402
from routes import event_stream as route  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.pipe = tempfile.mkdtemp(prefix="evstream-")
        self.addCleanup(shutil.rmtree, self.pipe, True)
        self.q = os.path.join(self.pipe, "queue")
        self.inst = os.path.join(self.pipe, "instances")
        self.plugins = os.path.join(self.pipe, "plugins.json")
        for d in ("pending", "done", "blocked"):
            os.makedirs(os.path.join(self.q, d))
        os.makedirs(self.inst)
        self.paths = {"queue": self.q, "instances": self.inst, "plugins": self.plugins}
        self.hub = es.Hub(lambda: dict(self.paths), watch_s=0, clock=lambda: 0)

    def beat(self, name, **kw):
        data = {"instanceId": name, "status": "idle", "currentPass": None, "currentTaskId": None, "stateSince": "t0", "lastHeartbeat": "h0"}
        data.update(kw)
        path = os.path.join(self.inst, name + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.utime(path, ns=(time.time_ns() + self.tick, time.time_ns() + self.tick))   # a guaranteed-different mtime even on a coarse clock
        self.tick += 10_000_000

    tick = 1_000_000_000

    def names(self, full=False):
        return self.hub.poll_once(full=full)


class Enabled(unittest.TestCase):
    def test_default_on_and_kill_switch(self):
        self.assertTrue(es.enabled({}))
        self.assertTrue(es.enabled({"AGENT_MANAGER_EVENT_STREAM": "on"}))
        self.assertFalse(es.enabled({"AGENT_MANAGER_EVENT_STREAM": "off"}))
        self.assertFalse(es.enabled({"AGENT_MANAGER_EVENT_STREAM": " OFF "}))


class Counts(Base):
    def test_first_pass_is_baseline_then_a_new_record_fires_counts_only(self):
        self.assertEqual(self.names(), [])
        Path(self.q, "pending", "a.json").write_text("{}")
        os.utime(os.path.join(self.q, "pending"), ns=(time.time_ns() + 5_000_000_000, time.time_ns() + 5_000_000_000))
        self.assertEqual(self.names(), ["counts-changed"])
        self.assertEqual(self.names(), [])

    def test_a_new_state_directory_fires(self):
        self.names()
        os.makedirs(os.path.join(self.q, "coordinating"))
        self.assertEqual(self.names(), ["counts-changed"])

    def test_hidden_directories_are_not_state_directories(self):
        os.makedirs(os.path.join(self.q, ".cache"))
        self.names()
        Path(self.q, ".cache", "x").write_text("1")
        os.utime(os.path.join(self.q, ".cache"), ns=(time.time_ns() + 7_000_000_000, time.time_ns() + 7_000_000_000))
        self.assertEqual(self.names(), [])
        self.assertNotIn(".cache", [x[0] for x in es.counts_signature(self.q)])

    def test_missing_queue_is_empty_not_an_error(self):
        self.assertEqual(es.counts_signature(None), ())
        self.assertEqual(es.counts_signature(os.path.join(self.pipe, "nope")), ())

    def test_full_signature_counts_entries(self):
        Path(self.q, "pending", "a.json").write_text("{}")
        fast = dict((x[0], x) for x in es.counts_signature(self.q))
        full = dict((x[0], x) for x in es.counts_signature(self.q, full=True))
        self.assertEqual(len(fast["pending"]), 2)
        self.assertEqual(full["pending"][2], 1)
        self.assertEqual(len(full[""]), 2)      # the queue directory itself carries no count


class Workers(Base):
    def test_a_new_heartbeat_file_fires(self):
        self.names()
        self.beat("worker-a")
        self.assertEqual(self.names(), ["workers-changed"])

    def test_only_the_heartbeat_time_changing_does_not_fire(self):
        self.beat("worker-a")
        self.names()
        self.beat("worker-a", lastHeartbeat="h1")
        self.assertEqual(self.names(), [])

    def test_each_edge_key_fires(self):
        for key, value in (("status", "working"), ("currentPass", "draft"), ("currentTaskId", "T1"), ("stateSince", "t9")):
            with self.subTest(key=key):
                self.setUp()
                self.beat("worker-a")
                self.names()
                self.beat("worker-a", **{key: value})
                self.assertEqual(self.names(), ["workers-changed"])

    def test_a_removed_heartbeat_fires_and_forgets_the_cache(self):
        self.beat("worker-a")
        self.names()
        os.remove(os.path.join(self.inst, "worker-a.json"))
        self.assertEqual(self.names(), ["workers-changed"])
        self.assertEqual(self.hub._wcache, {})

    def test_non_instance_json_and_broken_files_are_ignored(self):
        self.names()
        Path(self.inst, "lane-health.x.json").write_text(json.dumps({"ok": True}))
        Path(self.inst, "broken.json").write_text("{nope")
        self.assertEqual(self.names(), [])

    def test_only_json_files_are_read(self):
        self.names()
        Path(self.inst, "pipeline-history.log").write_text("x")
        with mock.patch.object(es, "_read_edge", side_effect=AssertionError("read a non-json file")):
            self.assertEqual(self.names(), [])

    def test_an_unchanged_file_is_not_read_again(self):
        self.beat("worker-a")
        self.names()
        with mock.patch.object(es, "_read_edge", side_effect=AssertionError("re-read")):
            self.assertEqual(self.names(), [])


class OtherSources(Base):
    def test_journal_growth_fires_branches(self):
        self.names()
        d = os.path.join(self.pipe, "queue-events")
        os.makedirs(d)
        Path(d, "journal.jsonl").write_text('{"type":"verdict_recorded"}\n')
        self.assertEqual(self.names(), ["branches-changed"])
        with open(os.path.join(d, "journal.jsonl"), "a") as f:
            f.write('{"type":"branch_merged"}\n')
        self.assertEqual(self.names(), ["branches-changed"])

    def test_plugins_json_change_fires_plugins(self):
        Path(self.plugins).write_text("[]")
        self.names()
        Path(self.plugins).write_text('[{"name":"x"}]')
        self.assertEqual(self.names(), ["plugins-changed"])

    def test_switching_the_pipeline_fires_project_changed_only(self):
        self.names()
        other = tempfile.mkdtemp(prefix="evstream-other-")
        self.addCleanup(shutil.rmtree, other, True)
        os.makedirs(os.path.join(other, "queue", "pending"))
        self.paths = {"queue": os.path.join(other, "queue"), "instances": os.path.join(other, "instances"), "plugins": self.plugins}
        self.assertEqual(self.names(), ["project-changed"])
        self.assertEqual(self.names(), [])

    def test_several_sources_in_one_pass_publish_in_a_stable_order(self):
        self.names()
        self.beat("worker-a")
        Path(self.plugins).write_text("[]")
        self.assertEqual(self.names(), ["workers-changed", "plugins-changed"])
        self.assertEqual([e["id"] for e in self.hub._ring], [1, 2])


class Reconcile(Base):
    def test_a_change_the_cheap_pass_cannot_see_is_found_announced_and_counted(self):
        self.beat("worker-a")
        self.names()
        # same size and same mtime, different content: the stat key cannot tell, only a real re-read can
        path = os.path.join(self.inst, "worker-a.json")
        st = st_ = os.stat(path)
        text = Path(path).read_text().replace('"idle"', '"busy"')
        Path(path).write_text(text)
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertEqual(self.names(), [])
        self.assertEqual(self.hub.reconcile(), ["workers-changed"])
        st = self.hub.status()
        self.assertEqual(st["corrections"], {"total": 1, "byEvent": {"workers-changed": 1}})
        self.assertIsNotNone(st["lastReconcileAt"])
        self.assertEqual(self.hub._ring[-1]["data"]["why"], "reconcile")
        # a second one for the same event adds to its count
        Path(path).write_text(Path(path).read_text().replace('"busy"', '"idle"'))
        os.utime(path, ns=(st_.st_atime_ns, st_.st_mtime_ns))
        self.assertEqual(self.hub.reconcile(), ["workers-changed"])
        self.assertEqual(self.hub.status()["corrections"], {"total": 2, "byEvent": {"workers-changed": 2}})

    def test_a_quiet_reconcile_counts_nothing(self):
        self.beat("worker-a")
        self.names()
        self.assertEqual(self.hub.reconcile(), [])
        self.assertEqual(self.hub.status()["corrections"], {"total": 0, "byEvent": {}})

    def test_an_entry_count_change_that_left_the_directory_mtime_alone_is_found_by_reconcile(self):
        self.names()
        self.hub.reconcile()                       # the first full pass records the counts
        pend = os.path.join(self.q, "pending")
        st = os.stat(pend)
        Path(pend, "a.json").write_text("{}")
        os.utime(pend, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertEqual(self.names(), [])
        self.assertEqual(self.hub.reconcile(), ["counts-changed"])
        self.assertEqual(self.hub.status()["corrections"]["byEvent"], {"counts-changed": 1})
        self.assertEqual(self.hub.reconcile(), [])

    def test_a_pipeline_switch_found_by_reconcile_is_not_a_correction(self):
        self.names()
        self.paths = {"queue": None, "instances": None, "plugins": None}
        self.assertEqual(self.hub.reconcile(), ["project-changed"])
        self.assertEqual(self.hub.status()["corrections"]["total"], 0)


class Clients(Base):
    def test_events_after_returns_news_in_order_and_resyncs_when_ahead_or_too_old(self):
        self.names()
        self.beat("worker-a")
        self.names()
        events, resync = self.hub.events_after(0, 0)
        self.assertEqual([(e["id"], e["event"]) for e in events], [(1, "workers-changed")])
        self.assertFalse(resync)
        self.assertEqual(self.hub.events_after(5, 0), ([], True))          # a restart reset the counter: the client is ahead
        for i in range(es.RING_SIZE + 5):
            self.hub._publish(["counts-changed"], "t")
        self.assertEqual(self.hub.events_after(1, 0), ([], True))          # older than the ring holds

    def test_events_after_does_not_wait_when_news_is_already_there(self):
        self.hub._publish(["counts-changed"], "t")
        with mock.patch.object(self.hub._cond, "wait", side_effect=AssertionError("waited with news pending")):
            events, resync = self.hub.events_after(0, 30)
        self.assertEqual(len(events), 1)

    def test_events_after_waits_and_wakes_on_publish(self):
        import threading
        out = []
        t = threading.Thread(target=lambda: out.append(self.hub.events_after(0, 5)))
        t.start()
        time.sleep(0.1)
        self.hub._publish(["counts-changed"], "t")
        t.join(3)
        self.assertEqual(out[0][0][0]["event"], "counts-changed")

    def test_subscribe_takes_the_baseline_before_returning(self):
        self.hub._thread = mock.Mock(is_alive=lambda: True)     # no real watcher thread in this test
        self.hub.subscribe()
        self.assertIsNotNone(self.hub._last)
        self.beat("worker-a")
        self.assertEqual(self.names(), ["workers-changed"])
        self.assertEqual(self.hub.status()["clients"], 1)
        self.hub.unsubscribe()
        self.hub.unsubscribe()
        self.assertEqual(self.hub.status()["clients"], 0)

    def test_the_watcher_stops_after_the_idle_exit_and_forgets_its_baseline(self):
        now = [0.0]
        hub = es.Hub(lambda: dict(self.paths), watch_s=0, clock=lambda: now[0], idle_exit_s=30)
        hub._last = hub._facts(False)
        hub._last_counts_full = ("x",)
        with mock.patch.object(es.time, "sleep", side_effect=lambda s: now.__setitem__(0, now[0] + 20)):
            hub._run()
        self.assertGreaterEqual(now[0], 30)
        self.assertIsNone(hub._last)
        self.assertIsNone(hub._last_counts_full)


class Providers(Base):
    def make(self, fact):
        return es.Hub(lambda: dict(self.paths), watch_s=0, clock=lambda: 0, providers={"memory-changed": fact})

    def test_a_provider_value_change_fires_its_own_event_after_the_built_in_ones(self):
        value = ["ok"]
        hub = self.make(lambda full=False: value[0])
        hub.poll_once()
        self.assertEqual(hub.poll_once(), [])
        value[0] = "tight"
        self.beat("worker-a")
        self.assertEqual(hub.poll_once(), ["workers-changed", "memory-changed"])
        self.assertEqual(hub.poll_once(), [])

    def test_event_names_lists_the_providers_between_the_built_ins_and_project_changed(self):
        hub = self.make(lambda full=False: 1)
        self.assertEqual(hub.event_names(), ["counts-changed", "workers-changed", "branches-changed", "plugins-changed", "memory-changed", "project-changed"])
        self.assertEqual(self.hub.event_names(), list(es.EVENT_NAMES))

    def test_a_raising_provider_is_none_and_does_not_silence_the_others(self):
        calls = []
        def boom(full=False):
            raise RuntimeError("x")
        hub = es.Hub(lambda: dict(self.paths), watch_s=0, clock=lambda: 0, providers={"a-changed": boom, "b-changed": lambda full=False: calls.append(1) or len(calls)})
        hub.poll_once()
        self.assertEqual(hub.poll_once(), ["b-changed"])

    def test_provider_names_are_validated(self):
        for bad in ("memory", "counts-changed", "project-changed", ""):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    es.Hub(lambda: {}, providers={bad: lambda full=False: 1})

    def test_the_reconcile_pass_asks_providers_for_a_full_read_and_counts_what_it_finds(self):
        seen = []
        state = {"v": 1}
        def fact(full=False):
            seen.append(full)
            return state["v"] if full else 1          # the cheap read cannot see the change
        hub = self.make(fact)
        hub.poll_once()
        state["v"] = 2
        self.assertEqual(hub.poll_once(), [])
        self.assertEqual(hub.reconcile(), ["memory-changed"])
        self.assertEqual(seen[-1], True)
        self.assertEqual(hub.status()["corrections"]["byEvent"], {"memory-changed": 1})


class JsonFileFact(Base):
    def write(self, data, name="m.json"):
        path = os.path.join(self.pipe, name)
        Path(path).write_text(data if isinstance(data, str) else json.dumps(data))
        return path

    def test_projects_the_parsed_object(self):
        path = self.write({"state": "tight", "reason": "io", "numbers": {"x": 1}})
        fact = es.json_file_fact(lambda: path, lambda d: (d.get("state"), d.get("reason")))
        self.assertEqual(fact(), ("tight", "io"))

    def test_missing_broken_and_non_object_files_are_none(self):
        project = lambda d: "x"
        self.assertIsNone(es.json_file_fact(lambda: os.path.join(self.pipe, "nope.json"), project)())
        self.assertIsNone(es.json_file_fact(lambda: self.write("{bad"), project)())
        self.assertIsNone(es.json_file_fact(lambda: self.write("[1]"), project)())
        self.assertIsNone(es.json_file_fact(lambda: None, project)())

    def test_an_unchanged_stat_key_is_not_read_again_but_full_always_is(self):
        path = self.write({"state": "ok"})
        reads = []
        fact = es.json_file_fact(lambda: path, lambda d: reads.append(1) or d["state"])
        self.assertEqual(fact(), "ok")
        self.assertEqual(fact(), "ok")
        self.assertEqual(len(reads), 1)
        self.assertEqual(fact(full=True), "ok")
        self.assertEqual(len(reads), 2)

    def test_a_changed_file_and_a_changed_path_are_read_again(self):
        path = self.write({"state": "ok"})
        cur = [path]
        fact = es.json_file_fact(lambda: cur[0], lambda d: d["state"])
        self.assertEqual(fact(), "ok")
        Path(path).write_text(json.dumps({"state": "critical", "pad": "xxxx"}))
        self.assertEqual(fact(), "critical")
        other = self.write({"state": "tight"}, "o.json")
        cur[0] = other
        self.assertEqual(fact(), "tight")


class Generation(Base):
    def test_each_announcement_bumps_its_event_generation(self):
        self.assertEqual(self.hub.generation("counts-changed"), 0)
        self.hub._publish(["counts-changed", "workers-changed"], "t")
        self.hub._publish(["counts-changed"], "t")
        self.assertEqual(self.hub.generation("counts-changed"), 2)
        self.assertEqual(self.hub.generation("workers-changed"), 1)
        self.assertEqual(self.hub.generation("plugins-changed"), 0)

    def test_module_generation_is_zero_without_a_hub_and_when_the_hub_raises(self):
        with mock.patch.object(es, "_hub", None):
            self.assertEqual(es.generation("counts-changed"), 0)
        with mock.patch.object(es, "_hub", mock.Mock(generation=mock.Mock(side_effect=RuntimeError("x")))):
            self.assertEqual(es.generation("counts-changed"), 0)
        with mock.patch.object(es, "_hub", self.hub):
            self.hub._publish(["counts-changed"], "t")
            self.assertEqual(es.generation("counts-changed"), 1)


class SummaryInvalidation(Base):
    def setUp(self):
        super().setUp()
        from routes import shared_misc
        self.sm = shared_misc
        self.n = [0]
        self.client = app.app.test_client()

        def compute(qdir):
            self.n[0] += 1
            if self.mid_compute:
                self.hub._publish(["counts-changed"], "mid")
            return {"n": self.n[0]}
        self.mid_compute = False
        for p in (mock.patch.object(es, "_hub", self.hub), mock.patch.object(self.sm, "_SUMMARY_TTL_S", 1000.0), mock.patch.object(app, "queue_dir", lambda: Path(self.q)),
                  mock.patch.object(self.sm, "_compute_summary_counts", compute)):
            p.start()
            self.addCleanup(p.stop)
        self.sm._summary_state["entry"] = None
        self.sm._summary_state.pop("gen", None)

    def get(self):
        return self.client.get("/api/summary").get_json()["n"]

    def test_the_cache_serves_until_the_stream_announces_a_queue_change(self):
        self.assertEqual(self.get(), 1)
        self.assertEqual(self.get(), 1)
        self.hub._publish(["workers-changed"], "t")
        self.assertEqual(self.get(), 1)               # another event does not matter to the counts
        self.hub._publish(["counts-changed"], "t")
        self.assertEqual(self.get(), 2)
        self.assertEqual(self.get(), 2)

    def test_a_change_announced_while_computing_still_invalidates_that_payload(self):
        self.mid_compute = True
        self.assertEqual(self.get(), 1)
        self.mid_compute = False
        self.assertEqual(self.get(), 2)
        self.assertEqual(self.get(), 2)


class Status(unittest.TestCase):
    def test_hub_status_shapes(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_EVENT_STREAM": "off"}):
            self.assertEqual(es.hub_status(), {"enabled": False})
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_EVENT_STREAM": "on"}), mock.patch.object(es, "_hub", None):
            self.assertEqual(es.hub_status(), {"enabled": True, "clients": 0, "seq": 0, "corrections": {"total": 0, "byEvent": {}}, "lastReconcileAt": None})
        broken = mock.Mock(status=mock.Mock(side_effect=RuntimeError("x")))
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_EVENT_STREAM": "on"}), mock.patch.object(es, "_hub", broken):
            self.assertTrue(es.hub_status()["enabled"])

    def test_sse_framing(self):
        self.assertEqual(es.sse("counts-changed", {"seq": 3}, 3), 'id: 3\nevent: counts-changed\ndata: {"seq":3}\n\n')
        self.assertEqual(es.sse("snapshot", {}), "event: snapshot\ndata: {}\n\n")

    def test_summary_carries_the_event_stream_field(self):
        from routes import shared_misc
        out = shared_misc._with_memory({"pending": 1}, None)
        self.assertIn("eventStream", out)
        self.assertEqual(out["pending"], 1)


class Route(Base):
    def setUp(self):
        super().setUp()
        self.client = app.app.test_client()
        p = mock.patch.object(route, "_resolve", lambda: dict(self.paths))
        p.start()
        self.addCleanup(p.stop)
        k = mock.patch.object(route, "KEEPALIVE_S", 0.05)
        k.start()
        self.addCleanup(k.stop)
        h = mock.patch.object(es, "_hub", self.hub)
        h.start()
        self.addCleanup(h.stop)
        self.hub._thread = mock.Mock(is_alive=lambda: True)

    def test_off_switch_answers_404(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_EVENT_STREAM": "off"}):
            r = self.client.get("/api/stream")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.get_json(), {"enabled": False})

    def test_the_snapshot_names_the_providers_events_too(self):
        self.hub._providers = {"memory-changed": lambda full=False: 1}
        r = self.client.get("/api/stream", buffered=False)
        it = iter(r.response)
        take = lambda: (lambda c: c.decode() if isinstance(c, bytes) else c)(next(it))
        take()
        self.assertIn('"memory-changed"', take())
        r.close()

    def test_the_route_builds_the_hub_with_its_providers(self):
        with mock.patch.object(es, "_hub", None):
            r = self.client.get("/api/stream", buffered=False)
            it = iter(r.response)
            next(it)
            self.assertIn("memory-changed", es._hub.event_names())
            r.close()
            es._hub._thread = None

    def test_the_route_registers_a_memory_provider_reading_the_broker_marker(self):
        marker = os.path.join(self.pipe, "mem.json")
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_MEM_PRESSURE_MARKER": marker}):
            fact = route._providers()["memory-changed"]
            self.assertIsNone(fact())
            Path(marker).write_text(json.dumps({"state": "tight", "reason": "io stall", "numbers": {"io_full": 40}}))
            self.assertEqual(fact(), ("tight", "io stall"))
            Path(marker).write_text(json.dumps({"state": "tight", "reason": "io stall", "numbers": {"io_full": 41}, "pad": 1}))
            self.assertEqual(fact(), ("tight", "io stall"))      # the numbers moved; the chip's state did not, so no announcement

    def test_a_number_inside_the_reason_does_not_announce_but_new_wording_does(self):
        marker = os.path.join(self.pipe, "mem2.json")
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_MEM_PRESSURE_MARKER": marker}):
            fact = route._providers()["memory-changed"]
            Path(marker).write_text(json.dumps({"state": "tight", "reason": "memory stall 11.64%"}))
            first = fact()
            Path(marker).write_text(json.dumps({"state": "tight", "reason": "memory stall 12.01% and more"}))
            self.assertNotEqual(fact(), first)
            Path(marker).write_text(json.dumps({"state": "tight", "reason": "memory stall 99.5%"}))
            self.assertEqual(fact(), first)
            Path(marker).write_text(json.dumps({"state": "tight", "reason": "holding until pressure eases"}))
            self.assertNotEqual(fact(), first)

    def test_connect_sends_retry_then_a_snapshot_then_named_events_then_a_keepalive(self):
        r = self.client.get("/api/stream", buffered=False)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.mimetype.startswith("text/event-stream"))
        self.assertEqual(r.headers.get("Cache-Control"), "no-cache")
        it = iter(r.response)
        take = lambda: (lambda c: c.decode() if isinstance(c, bytes) else c)(next(it))
        self.assertEqual(take(), "retry: 3000\n\n")
        snap = take()
        self.assertTrue(snap.startswith("id: 0\nevent: snapshot\ndata: "))
        self.assertEqual(json.loads(snap.split("data: ")[1])["events"], list(es.EVENT_NAMES))
        self.assertEqual(self.hub.status()["clients"], 1)
        self.beat("worker-a")
        self.hub.poll_once()
        self.assertEqual(take(), 'id: 1\nevent: workers-changed\ndata: {"seq":1,"why":"watch"}\n\n')
        self.assertEqual(take(), ": keepalive\n\n")
        r.close()
        self.assertEqual(self.hub.status()["clients"], 0)

    def test_reconnect_with_last_event_id_replays_only_what_was_missed(self):
        self.hub.poll_once()
        self.hub._publish(["counts-changed"], "t")
        self.hub._publish(["plugins-changed"], "t")
        r = self.client.get("/api/stream", headers={"Last-Event-ID": "1"}, buffered=False)
        it = iter(r.response)
        take = lambda: (lambda c: c.decode() if isinstance(c, bytes) else c)(next(it))
        self.assertEqual(take(), "retry: 3000\n\n")
        self.assertEqual(take(), 'id: 2\nevent: plugins-changed\ndata: {"seq":2,"why":"t"}\n\n')
        r.close()

    def test_reconnecting_at_the_newest_id_does_not_replay_the_ring(self):
        self.hub._publish(["counts-changed"], "t")
        self.hub._publish(["plugins-changed"], "t")
        r = self.client.get("/api/stream", headers={"Last-Event-ID": "2"}, buffered=False)
        it = iter(r.response)
        take = lambda: (lambda c: c.decode() if isinstance(c, bytes) else c)(next(it))
        take()
        self.assertEqual(take(), ": keepalive\n\n")
        r.close()

    def test_a_restart_mid_stream_sends_a_snapshot_and_continues_from_the_new_counter(self):
        self.hub._providers = {"memory-changed": lambda full=False: 1}
        self.hub._publish(["counts-changed"], "t")
        self.hub._publish(["plugins-changed"], "t")
        r = self.client.get("/api/stream", headers={"Last-Event-ID": "2"}, buffered=False)
        it = iter(r.response)
        take = lambda: (lambda c: c.decode() if isinstance(c, bytes) else c)(next(it))
        take()
        self.assertEqual(take(), ": keepalive\n\n")
        self.hub._seq = 1                                  # the counter went backwards: a restarted process
        self.hub._ring = type(self.hub._ring)([self.hub._ring[0]], maxlen=es.RING_SIZE)
        snap = take()
        self.assertTrue(snap.startswith("id: 1\nevent: snapshot"))
        self.assertIn('"memory-changed"', snap)
        self.hub._publish(["workers-changed"], "t")
        self.assertEqual(take(), 'id: 2\nevent: workers-changed\ndata: {"seq":2,"why":"t"}\n\n')
        r.close()

    def test_a_client_ahead_of_the_server_gets_a_snapshot(self):
        r = self.client.get("/api/stream", headers={"Last-Event-ID": "999"}, buffered=False)
        it = iter(r.response)
        next(it)
        self.assertIn("event: snapshot", (lambda c: c.decode() if isinstance(c, bytes) else c)(next(it)))
        r.close()

    def test_a_garbage_last_event_id_is_a_fresh_connect(self):
        r = self.client.get("/api/stream", headers={"Last-Event-ID": "abc"}, buffered=False)
        it = iter(r.response)
        next(it)
        self.assertIn("event: snapshot", (lambda c: c.decode() if isinstance(c, bytes) else c)(next(it)))
        r.close()


if __name__ == "__main__":
    unittest.main()
