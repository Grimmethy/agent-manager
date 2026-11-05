"""The dashboard event channel (event_stream.py, routes/event_stream.py, /api/summary `eventStream`): ADR-0024, 'UI triggers, not polls' piece 1.

Run: .venv/bin/python -m unittest test_event_stream -v   (from python/dashboard)
Real temp pipeline directories; the watcher thread is never started here: poll_once()/reconcile() are called by hand.
"""
import json
import os
import shutil
import sys
import tempfile
import threading
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


class DirFilesFact(Base):
    def setUp(self):
        super().setUp()
        import re as _re
        self.re = _re
        self.d = os.path.join(self.pipe, "ops")
        os.makedirs(os.path.join(self.d, "gateway"))
        self.pat = _re.compile(r"(-ledger\.jsonl|-index\.json|-disabled)$")
        self.db = os.path.join(self.pipe, "stats.db")

    def fact(self, extra=True):
        return es.dir_files_fact(lambda: [(self.d, self.pat), (os.path.join(self.d, "gateway"), self.pat)], (lambda: [self.db, self.db + "-wal", None]) if extra else None)

    def put(self, rel, text="x"):
        Path(self.d, rel).write_text(text)

    def test_only_the_files_a_panel_reads_are_listed_and_nothing_is_read(self):
        for name in ("stalled-ledger.jsonl", "verifier-index.json", "context-map-disabled", "needswork-drain.log", "needswork-trigger.beat", "needswork-trigger.json", "x.lock"):
            self.put(name)
        self.put("gateway/spend-ledger.jsonl")
        self.put("gateway/other.txt")
        out = self.fact()()
        self.assertEqual(sorted(os.path.basename(t[0]) for t in out), ["context-map-disabled", "spend-ledger.jsonl", "stalled-ledger.jsonl", "verifier-index.json"])
        for t in out:
            self.assertEqual(len(t), 4)

    def test_an_append_a_replace_and_a_new_file_each_change_the_value(self):
        self.put("stalled-ledger.jsonl", "a\n")
        fact = self.fact()
        v0 = fact()
        with open(os.path.join(self.d, "stalled-ledger.jsonl"), "a") as f:
            f.write("b\n")
        v1 = fact()
        self.assertNotEqual(v0, v1)
        self.put("verifier-ledger.jsonl")
        v2 = fact()
        self.assertNotEqual(v1, v2)
        self.assertEqual(fact(), v2)

    def test_each_part_of_the_stat_key_alone_is_enough_to_notice_a_change(self):
        path = os.path.join(self.d, "stalled-ledger.jsonl")
        self.put("stalled-ledger.jsonl", "aaaa")
        fixed = os.stat(path).st_mtime_ns
        fact = self.fact()
        base = fact()
        # size alone: same inode, same mtime, longer content
        Path(path).write_text("aaaaaaaa")
        os.utime(path, ns=(fixed, fixed))
        self.assertNotEqual(fact(), base, "size")
        # mtime alone: same inode, same size
        Path(path).write_text("aaaa")
        os.utime(path, ns=(fixed, fixed))
        self.assertEqual(fact(), base)
        os.utime(path, ns=(fixed + 5_000_000_000, fixed + 5_000_000_000))
        self.assertNotEqual(fact(), base, "mtime")
        # inode alone: a rename over the file with the same size and mtime
        os.utime(path, ns=(fixed, fixed))
        before = fact()
        other = os.path.join(self.d, "tmp-new")
        Path(other).write_text("aaaa")
        os.utime(other, ns=(fixed, fixed))
        os.replace(other, path)
        self.assertNotEqual(fact(), before, "inode")

    def test_the_value_does_not_depend_on_the_order_the_directories_are_listed(self):
        self.put("a-ledger.jsonl")
        self.put("gateway/spend-ledger.jsonl")
        forward = [(self.d, self.pat), (os.path.join(self.d, "gateway"), self.pat)]
        order = [forward]
        fact = es.dir_files_fact(lambda: order[0])
        v = fact()
        order[0] = list(reversed(forward))
        self.assertEqual(fact(), v)

    def test_a_noisy_file_does_not_change_the_value(self):
        self.put("stalled-ledger.jsonl")
        fact = self.fact()
        v = fact()
        self.put("needswork-drain.log", "idle\n")
        self.put("needswork-trigger.json", "{}")
        self.assertEqual(fact(), v)

    def test_the_extra_files_are_stat_ed_and_a_missing_one_or_none_contributes_nothing(self):
        fact = self.fact()
        self.assertEqual(fact(), ())
        Path(self.db).write_text("db")
        Path(self.db + "-wal").write_text("w")
        out = fact()
        self.assertEqual([os.path.basename(t[0]) for t in out], ["stats.db", "stats.db-wal"])
        self.assertEqual(len(out[0]), 4)
        Path(self.db + "-wal").write_text("ww")
        self.assertNotEqual(fact(), out)

    def test_a_missing_directory_and_subdirectories_contribute_nothing(self):
        os.makedirs(os.path.join(self.d, "sub-ledger.jsonl"))
        fact = es.dir_files_fact(lambda: [(os.path.join(self.pipe, "nope"), self.pat), (self.d, self.pat)])
        self.assertEqual(fact(), ())

    def test_with_subdirs_a_matching_subdirectory_is_listed_by_its_own_stat_key_without_looking_inside(self):
        sub = os.path.join(self.d, "run-ledger.jsonl")
        os.makedirs(sub)
        fact = es.dir_files_fact(lambda: [(self.d, self.pat)], subdirs=True)
        first = fact()
        self.assertEqual([os.path.basename(t[0]) for t in first], ["run-ledger.jsonl"])
        Path(sub, "inner.txt").write_text("x")                       # a file inside moves the directory's mtime
        os.utime(sub, ns=(time.time_ns() + 6_000_000_000, time.time_ns() + 6_000_000_000))
        self.assertNotEqual(fact(), first)
        os.makedirs(os.path.join(self.d, "other-dir"))               # a subdirectory whose name does not match is ignored
        self.assertEqual([os.path.basename(t[0]) for t in fact()], ["run-ledger.jsonl"])

    def test_without_subdirs_a_matching_directory_name_is_never_listed(self):
        os.makedirs(os.path.join(self.d, "run-ledger.jsonl"))
        self.assertEqual(es.dir_files_fact(lambda: [(self.d, self.pat)])(), ())

    def test_with_subdirs_the_files_are_still_listed_and_nothing_below_a_subdirectory_is(self):
        self.put("a-ledger.jsonl")
        sub = os.path.join(self.d, "b-ledger.jsonl")
        os.makedirs(sub)
        Path(sub, "c-ledger.jsonl").write_text("x")
        out = es.dir_files_fact(lambda: [(self.d, self.pat)], subdirs=True)()
        self.assertEqual(sorted(os.path.basename(t[0]) for t in out), ["a-ledger.jsonl", "b-ledger.jsonl"])

    def test_it_works_as_a_hub_provider_and_announces_a_ledger_append(self):
        self.put("stalled-ledger.jsonl", "a\n")
        hub = es.Hub(lambda: dict(self.paths), watch_s=0, clock=lambda: 0, providers={"worker-panels-changed": self.fact()})
        hub.poll_once()
        self.assertEqual(hub.poll_once(), [])
        with open(os.path.join(self.d, "stalled-ledger.jsonl"), "a") as f:
            f.write("b\n")
        self.assertEqual(hub.poll_once(), ["worker-panels-changed"])


class Announce(Base):
    def test_a_writers_announcement_is_published_with_its_data_under_the_hubs_own_seq(self):
        seq = self.hub.announce("plugin-changed", plugin="books")
        self.assertEqual(seq, 1)
        self.assertEqual(self.hub.generation("plugin-changed"), 1)
        events, resync = self.hub.events_after(0, 0)
        self.assertFalse(resync)
        self.assertEqual(events, [{"id": 1, "event": "plugin-changed", "data": {"plugin": "books", "seq": 1, "why": "announce"}}])
        self.assertEqual(self.hub.announce("plugin-changed", plugin="mail"), 2)
        self.assertEqual(self.hub.generation("plugin-changed"), 2)

    def test_the_data_cannot_overwrite_the_hubs_seq_or_why(self):
        self.hub.announce("plugin-changed", plugin="books", seq=99, why="evil")
        self.assertEqual(self.hub._ring[-1]["data"], {"plugin": "books", "seq": 1, "why": "announce"})

    def test_only_announceable_events_are_accepted_and_a_refusal_publishes_nothing(self):
        for name in ("counts-changed", "snapshot", "", "plugin-changedX", None):
            with self.assertRaises(ValueError):
                self.hub.announce(name, plugin="books")
        self.assertEqual(len(self.hub._ring), 0)
        self.assertEqual(self.hub.generation("plugin-changed"), 0)
        self.assertEqual(es.ANNOUNCE_EVENTS, ("plugin-changed", "project-build-changed"))

    def test_an_announcement_wakes_a_waiting_reader(self):
        seen = []
        t = threading.Thread(target=lambda: seen.append(self.hub.events_after(0, 5)))
        t.start()
        time.sleep(0.1)
        self.hub.announce("plugin-changed", plugin="books")
        t.join(3)
        self.assertFalse(t.is_alive())
        self.assertEqual(seen[0][0][0]["event"], "plugin-changed")


class ModuleAnnounce(Base):
    def test_without_a_hub_a_writers_announcement_does_nothing(self):
        with mock.patch.object(es, "_hub", None):
            self.assertIsNone(es.announce("project-build-changed", path="/p"))

    def test_with_a_hub_it_publishes_and_returns_the_seq(self):
        with mock.patch.object(es, "_hub", self.hub):
            self.assertEqual(es.announce("project-build-changed", path="/p"), 1)
        self.assertEqual(self.hub._ring[-1]["event"], "project-build-changed")
        self.assertEqual(self.hub._ring[-1]["data"], {"path": "/p", "seq": 1, "why": "announce"})

    def test_a_failing_or_refused_announcement_never_raises_into_the_writer(self):
        with mock.patch.object(es, "_hub", self.hub):
            self.assertIsNone(es.announce("counts-changed"))                  # not announceable
            with mock.patch.object(self.hub, "announce", side_effect=RuntimeError("boom")):
                self.assertIsNone(es.announce("project-build-changed", path="/p"))
        self.assertEqual(len(self.hub._ring), 0)


class PipelineState(Base):
    def _patch(self, **over):
        vals = {"ENV_FILE_PATH": "env", "_pipeline_running": lambda: False, "_pipeline_stoppable": lambda: False, "get_active_repo_root": lambda: "/repo",
                "read_env_file": lambda p: {"AGENT_MANAGER_INCLUDE_APPLY": "true", "AGENT_MANAGER_APPLY_SKIP_PUSH": "false"}}
        vals.update(over)
        ps = [mock.patch.object(app, k, v) for k, v in vals.items()]
        for p in ps:
            p.start()
            self.addCleanup(p.stop)

    def test_the_provider_is_registered_on_a_three_second_clock(self):
        fact, interval = route._providers()["pipeline-state-changed"]
        self.assertEqual(interval, 3.0)
        self.assertEqual(route.PIPELINE_STATE_INTERVAL_S, 3.0)
        self.assertIs(fact, route._pipeline_state)

    def test_the_value_follows_running_stoppable_the_toggles_and_the_repo(self):
        self._patch()
        base = route._pipeline_state()
        self.assertEqual(base, ("/repo", False, False, True, False))
        self.assertEqual(route._pipeline_state(), base)                           # nothing moved: an equal value announces nothing
        self._patch(_pipeline_stoppable=lambda: True)
        self.assertEqual(route._pipeline_state(), ("/repo", False, True, True, False))
        self._patch(_pipeline_running=lambda: True)
        self.assertEqual(route._pipeline_state(), ("/repo", True, True, True, False))   # running implies stoppable
        self._patch(get_active_repo_root=lambda: "/other")
        self.assertEqual(route._pipeline_state()[0], "/other")
        self._patch(read_env_file=lambda p: {})
        self.assertEqual(route._pipeline_state()[3:], (False, True))              # the route's own defaults

    def test_the_value_mirrors_the_status_route_field_for_field(self):
        self._patch(_pipeline_running=lambda: True)
        body = app.app.test_client().get("/api/pipeline/status").get_json()
        self.assertEqual(route._pipeline_state(), (body["activeRepoRoot"], body["running"], body["stoppable"], body["includeApply"], body["skipPush"]))

    def test_an_error_is_the_value_none_not_an_exception(self):
        for exc in (OSError("boom"), ValueError("bad"), KeyError("k"), RuntimeError("x")):
            self._patch(_pipeline_running=mock.Mock(side_effect=exc))
            self.assertIsNone(route._pipeline_state(), repr(exc))


class BuildAnnouncements(Base):
    def _run(self, build):
        cache = {k: Path(self.pipe) / (k + ".json") for k in ("graph", "coverage", "file_cache", "positions", "meta")}
        with mock.patch.object(es, "announce") as ann, mock.patch.object(app, "resolve_writable_cache", return_value=cache), \
                mock.patch.object(app.graph_build, "build_graph_data", side_effect=build), mock.patch.object(app.graph_build, "merge_coverage", return_value={}):
            with app._build_lock:
                app._build_state["/p"] = {"running": True, "log": [], "error": None}
            app._run_build("/p", [])
        return ann.call_args_list, app._build_state["/p"]

    def test_every_log_line_and_the_finish_announce_the_project_path(self):
        def build(path, dirs, url, model, progress=None, **kw):
            progress("one")
            progress("two")
            return {"graph": {"nodes": []}, "coverage": {}}
        calls, state = self._run(build)
        self.assertEqual(calls, [mock.call("project-build-changed", path="/p")] * 3)
        self.assertEqual((state["running"], state["log"]), (False, ["one", "two"]))

    def test_a_failed_build_announces_its_end_too(self):
        def build(path, dirs, url, model, progress=None, **kw):
            progress("start")
            raise RuntimeError("graph failed")
        calls, state = self._run(build)
        self.assertEqual(calls, [mock.call("project-build-changed", path="/p")] * 2)
        self.assertEqual((state["running"], state["error"]), (False, "graph failed"))

    def test_starting_a_build_announces_before_the_thread_runs(self):
        order = []
        with mock.patch.object(es, "announce", side_effect=lambda *a, **k: order.append(("announce", k))), \
                mock.patch.object(app, "_run_build", side_effect=lambda *a: order.append(("run", a))), mock.patch.object(app, "record_project_used"):
            r = app.app.test_client().post("/api/project/build", json={"path": self.pipe})
            time.sleep(0.2)
        self.assertEqual(r.get_json()["started"], True)
        self.assertEqual(order[0], ("announce", {"path": self.pipe}))
        with app._build_lock:
            app._build_state.pop(self.pipe, None)



class Coarse(unittest.TestCase):
    def test_numbers_keep_two_significant_figures(self):
        self.assertEqual(es.coarse(12345), 12000)
        self.assertEqual(es.coarse(12600), 13000)
        self.assertEqual(es.coarse(0.123456), 0.12)
        self.assertEqual(es.coarse(0.5712), 0.57)              # not 0.5700000000000001
        self.assertEqual(es.coarse(87.6), 88)
        self.assertEqual(es.coarse(5), 5)
        self.assertEqual(es.coarse(-4567), -4600)
        self.assertEqual(es.coarse(99.9), 100)

    def test_digits_is_the_number_of_significant_figures(self):
        self.assertEqual(es.coarse(12345, digits=3), 12300)
        self.assertEqual(es.coarse(12345, digits=1), 10000)

    def test_zero_non_finite_bool_none_and_text_are_untouched(self):
        self.assertEqual(es.coarse(0), 0)
        self.assertEqual(es.coarse(0.0), 0.0)
        self.assertTrue(es.coarse(float("inf")) == float("inf"))
        self.assertIs(es.coarse(True), True)
        self.assertIs(es.coarse(None), None)
        self.assertEqual(es.coarse("12345"), "12345")

    def test_it_recurses_into_dicts_and_lists_and_sorts_keys(self):
        out = es.coarse({"b": [1234, {"x": 5678}], "a": 0.5555, 3: "t"})
        self.assertEqual(out, {"3": "t", "a": 0.56, "b": [1200, {"x": 5700}]})
        self.assertEqual(list(out), ["3", "a", "b"])
        self.assertEqual(es.coarse((1234, 5678)), [1200, 5700])

    def test_an_unknown_object_becomes_its_text(self):
        self.assertEqual(es.coarse(object).startswith("<class"), True)

    def test_small_wobble_is_the_same_value_and_a_visible_move_is_not(self):
        self.assertEqual(es.coarse(12010), es.coarse(11990))
        self.assertNotEqual(es.coarse(12000), es.coarse(13000))


class HttpJsonFact(unittest.TestCase):
    def opener(self, payload=None, raises=None, seen=None):
        class Resp:
            def __init__(self, data):
                self.data = data

            def read(self):
                return self.data

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fn(url, timeout=None):
            if seen is not None:
                seen.append((url, timeout))
            if raises:
                raise raises
            return Resp(payload if isinstance(payload, bytes) else json.dumps(payload).encode())
        return fn

    def test_returns_a_canonical_json_string_of_the_rounded_data(self):
        seen = []
        fact = es.http_json_fact(lambda: "http://x/y", opener=self.opener({"gpu": {"util": 87.4, "mb": 12345}}, seen=seen), timeout=2.5)
        self.assertEqual(fact(), '{"gpu":{"mb":12000,"util":87}}')
        self.assertEqual(seen, [("http://x/y", 2.5)])

    def test_project_is_applied_before_rounding(self):
        fact = es.http_json_fact(lambda: "u", project=lambda d: d["keep"], opener=self.opener({"keep": [1234], "drop": 1}))
        self.assertEqual(fact(), "[1200]")

    def test_no_url_and_every_failure_are_none(self):
        self.assertIsNone(es.http_json_fact(lambda: None)())
        self.assertIsNone(es.http_json_fact(lambda: "")())
        self.assertIsNone(es.http_json_fact(lambda: "u", opener=self.opener(raises=OSError("refused")))())
        self.assertIsNone(es.http_json_fact(lambda: "u", opener=self.opener(payload=b"not json"))())
        self.assertIsNone(es.http_json_fact(lambda: "u", project=lambda d: d["nope"], opener=self.opener({"a": 1}))())

    def test_wobble_does_not_change_the_value_and_a_visible_move_does(self):
        data = {"v": 12010}
        fact = es.http_json_fact(lambda: "u", opener=lambda url, timeout=None: self.opener(dict(data))(url, timeout))
        a = fact()
        data["v"] = 11990
        self.assertEqual(fact(), a)
        data["v"] = 15000
        self.assertNotEqual(fact(), a)

    def test_digits_is_passed_to_coarse(self):
        fact = es.http_json_fact(lambda: "u", opener=self.opener({"v": 12345}), digits=3)
        self.assertEqual(fact(), '{"v":12300}')

    def test_without_a_url_nothing_is_fetched(self):
        calls = []
        fact = es.http_json_fact(lambda: None, opener=lambda url, timeout=None: calls.append(url))
        self.assertIsNone(fact())
        self.assertEqual(calls, [])

    def test_the_default_opener_is_urllib(self):
        with mock.patch.object(es.urllib.request, "urlopen", self.opener({"v": 1})):
            self.assertEqual(es.http_json_fact(lambda: "u")(), '{"v":1}')


class ProviderIntervals(Base):
    def make(self, fact, interval, now):
        return es.Hub(lambda: dict(self.paths), watch_s=0, clock=lambda: now[0], providers={"sample-changed": (fact, interval)})

    def test_an_interval_provider_is_evaluated_at_most_once_per_interval(self):
        calls = []
        now = [100.0]
        hub = self.make(lambda full=False: calls.append(1) or len(calls), 5.0, now)
        hub.poll_once()
        for t in (101.0, 102.0, 104.9):
            now[0] = t
            self.assertEqual(hub.poll_once(), [])
        self.assertEqual(len(calls), 1)
        now[0] = 105.0
        self.assertEqual(hub.poll_once(), ["sample-changed"])
        self.assertEqual(len(calls), 2)

    def test_the_cached_value_is_what_the_pass_compares_between_samples(self):
        values = iter([1, 2, 2, 3])
        now = [0.0]
        hub = self.make(lambda full=False: next(values), 10.0, now)
        hub.poll_once()
        now[0] = 3.0
        self.assertEqual(hub.poll_once(), [])
        now[0] = 10.0
        self.assertEqual(hub.poll_once(), ["sample-changed"])
        now[0] = 20.0
        self.assertEqual(hub.poll_once(), [])
        now[0] = 30.0
        self.assertEqual(hub.poll_once(), ["sample-changed"])

    def test_the_reconcile_pass_always_samples(self):
        calls = []
        now = [0.0]
        hub = self.make(lambda full=False: calls.append(full) or 1, 100.0, now)
        hub.poll_once()
        hub.reconcile()
        self.assertEqual(calls, [False, True])

    def test_a_raising_sampler_is_none_and_is_still_cached_for_its_interval(self):
        calls = []
        now = [0.0]

        def boom(full=False):
            calls.append(1)
            raise RuntimeError("x")
        hub = self.make(boom, 5.0, now)
        hub.poll_once()
        now[0] = 1.0
        hub.poll_once()
        self.assertEqual(len(calls), 1)

    def test_a_provider_without_an_interval_is_evaluated_every_pass(self):
        calls = []
        hub = es.Hub(lambda: dict(self.paths), watch_s=0, clock=lambda: 0, providers={"plain-changed": lambda full=False: calls.append(1)})
        hub.poll_once()
        hub.poll_once()
        hub.poll_once()
        self.assertEqual(len(calls), 3)

    def test_invalid_intervals_are_refused(self):
        for bad in (0, -1, "5", True, [1]):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    es.Hub(lambda: {}, providers={"x-changed": (lambda full=False: 1, bad)})

    def test_an_int_interval_is_accepted(self):
        hub = es.Hub(lambda: {}, providers={"x-changed": (lambda full=False: 1, 3)})
        self.assertEqual(hub._intervals, {"x-changed": 3})


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

    def test_a_known_plugin_can_announce_and_the_open_stream_receives_it(self):
        with mock.patch.object(app, "_read_plugins_manifest", lambda: ["junk", {"name": "books"}, {"name": "mail"}]):
            r = self.client.get("/api/stream", buffered=False)
            it = iter(r.response)
            take = lambda: (lambda c: c.decode() if isinstance(c, bytes) else c)(next(it))
            take()
            take()                                                           # the retry line and the snapshot
            a = self.client.post("/api/plugins/books/announce")
            self.assertEqual(a.status_code, 200)
            self.assertEqual(a.get_json(), {"ok": True, "plugin": "books", "seq": self.hub._seq})
            got = ""
            for _ in range(40):
                got += take()
                if "plugin-changed" in got:
                    break
            r.close()
        self.assertIn("event: plugin-changed", got)
        self.assertIn('"plugin":"books"', got)

    def test_an_unknown_plugin_or_an_unreadable_manifest_publishes_nothing(self):
        with mock.patch.object(app, "_read_plugins_manifest", lambda: [{"name": "books"}, 7, None]):
            for name in ("nope", "boo", "Books", "7", "None"):
                r = self.client.post("/api/plugins/%s/announce" % name)
                self.assertEqual((r.status_code, r.get_json()), (404, {"ok": False, "error": "unknown plugin"}), name)
        with mock.patch.object(app, "_read_plugins_manifest", mock.Mock(side_effect=ValueError("boom"))):
            self.assertEqual(self.client.post("/api/plugins/books/announce").status_code, 404)
        self.assertEqual(self.hub._seq, 0)

    def test_announce_follows_the_off_switch_and_accepts_post_only(self):
        with mock.patch.object(app, "_read_plugins_manifest", lambda: [{"name": "books"}]):
            with mock.patch.dict(os.environ, {"AGENT_MANAGER_EVENT_STREAM": "off"}):
                r = self.client.post("/api/plugins/books/announce")
            self.assertEqual((r.status_code, r.get_json()), (404, {"enabled": False}))
            self.assertEqual(self.client.get("/api/plugins/books/announce").status_code, 405)
        self.assertEqual(self.hub._seq, 0)

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

    def test_the_route_registers_the_worker_panels_provider_over_the_real_panel_files(self):
        ops = os.path.join(self.pipe, "opsstate")
        os.makedirs(os.path.join(ops, "gateway"))
        switches = os.path.join(self.pipe, "switches")
        os.makedirs(switches)
        db = os.path.join(self.pipe, "model-stats.db")
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_CONTEXT_OPS_STATE_DIR": ops, "AGENT_MANAGER_DISABLED_WORKERS_DIR": switches, "AGENT_MANAGER_MODEL_STATS_DB_PATH": db}):
            fact = route._providers()["worker-panels-changed"]
            self.assertEqual(fact(), ())
            for rel in ("needswork-ledger.jsonl", "gateway/spend-ledger.jsonl", "stalled-index.json", "context-map-disabled"):
                Path(ops, rel).write_text("x")
            Path(switches, "worker-cloud").write_text("{}")
            Path(switches, "reviewer").write_text("{}")
            Path(db).write_text("db")
            Path(db + "-wal").write_text("wal")
            names = sorted(os.path.basename(t[0]) for t in fact())
            self.assertEqual(names, ["context-map-disabled", "model-stats.db", "model-stats.db-wal", "needswork-ledger.jsonl", "spend-ledger.jsonl", "stalled-index.json", "worker-cloud"])
            Path(ops, "needswork-drain.log").write_text("idle")
            self.assertEqual(sorted(os.path.basename(t[0]) for t in fact()), names)

    def test_the_route_registers_a_settings_provider_over_the_env_file_and_the_dashboard_settings(self):
        env_file = Path(self.pipe) / "agent-manager.env"
        settings = Path(self.pipe) / "dashboard-settings.json"
        with mock.patch.object(app, "ENV_FILE_PATH", env_file), mock.patch("app_settings_helpers.DASHBOARD_SETTINGS_PATH", settings):
            fact = route._providers()["settings-changed"]
            self.assertEqual(fact(), ())
            env_file.write_text("A=1\n")
            settings.write_text("{}")
            first = fact()
            self.assertEqual(sorted(os.path.basename(t[0]) for t in first), ["agent-manager.env", "dashboard-settings.json"])
            env_file.write_text("A=22\n")
            self.assertNotEqual(fact(), first)
            Path(self.pipe, "unrelated.json").write_text("x")
            self.assertEqual(fact(), fact())

    def test_the_settings_provider_also_covers_the_lanes_registry(self):
        env_file = Path(self.pipe) / "agent-manager.env"
        registry = Path(self.pipe) / "lanes.json"
        with mock.patch.object(app, "ENV_FILE_PATH", env_file), mock.patch.dict(os.environ, {"AGENT_MANAGER_LANES_PATH": str(registry)}):
            fact = route._providers()["settings-changed"]
            self.assertEqual(fact(), ())
            registry.write_text("[]")
            first = fact()
            self.assertEqual([os.path.basename(t[0]) for t in first], ["lanes.json"])
            registry.write_text('[{"gpu": "x"}]')
            self.assertNotEqual(fact(), first)
        with mock.patch.object(app, "ENV_FILE_PATH", env_file), mock.patch.dict(os.environ, {}):
            os.environ.pop("AGENT_MANAGER_LANES_PATH", None)
            self.assertIn(str(app.SRC_DIR.parent / "lanes.json"), [str(x) for x in route._settings_files()])

    def test_the_route_registers_a_discovery_provider_over_the_four_files_of_the_active_project(self):
        d = Path(self.pipe) / "disc"
        d.mkdir()
        paths = {"idx": d / "INDEX.md", "dd": d / "deep-dive.json", "cc": d / "community-coverage.json", "ac": d / "ARCH_REVIEW_CANDIDATES.md"}
        with mock.patch.object(app, "project_search_index_path", lambda: paths["idx"]), mock.patch("routes.deep_dive.deep_dive_coverage_path", lambda: paths["dd"]), \
                mock.patch.object(app, "community_coverage_path", lambda: paths["cc"]), mock.patch.object(app, "arch_candidates_path", lambda: paths["ac"]):
            fact = route._providers()["discovery-changed"]
            self.assertEqual(fact(), ())
            for key, p in paths.items():
                before = fact()
                p.write_text("x")
                self.assertNotEqual(fact(), before, key)
            self.assertEqual(sorted(os.path.basename(t[0]) for t in fact()), sorted(p.name for p in paths.values()))
            before = fact()
            paths["cc"].write_text("changed contents, longer")
            self.assertNotEqual(fact(), before)
        with mock.patch.object(app, "project_search_index_path", lambda: None), mock.patch("routes.deep_dive.deep_dive_coverage_path", lambda: None), \
                mock.patch.object(app, "community_coverage_path", lambda: None), mock.patch.object(app, "arch_candidates_path", lambda: None):
            self.assertEqual(route._providers()["discovery-changed"](), ())

    def _plugin_fixture(self):
        """A fake plugin pid directory, a fake manifest and a fake checkout whose reflog we can touch. Returns (pid_dir, repo, manifest list)."""
        import plugin_process_manager as ppm
        pid_dir = Path(self.pipe) / "pids"
        pid_dir.mkdir()
        repo = Path(self.pipe) / "plugin-repo"
        (repo / ".git" / "logs").mkdir(parents=True)
        (repo / ".git" / "logs" / "HEAD").write_text("one\n")
        manifest = [{"name": "alpha", "slot": "hardware-tab", "cwd": str(repo)}, {"name": "beta-tab", "processName": "beta", "cwd": str(repo)}, {"name": "plain", "tab": True}]
        return ppm, pid_dir, repo, manifest

    def test_the_route_registers_a_plugin_states_provider_on_a_five_second_clock(self):
        fact, interval = route._providers()["plugin-states-changed"]
        self.assertEqual(interval, 5.0)
        self.assertEqual(route.PLUGIN_STATES_INTERVAL_S, 5.0)
        self.assertIs(fact, route._plugin_states)

    def test_plugin_states_change_when_a_plugin_starts_stops_restarts_or_its_checkout_moves(self):
        ppm, pid_dir, repo, manifest = self._plugin_fixture()
        with mock.patch.object(ppm, "PID_DIR", pid_dir), mock.patch.object(app, "_read_plugins_manifest", lambda: manifest):
            first = route._plugin_states()
            self.assertEqual([r[0] for r in first], ["alpha", "beta-tab"])            # the entry with neither slot nor processName owns no process
            self.assertEqual([r[1] for r in first], [False, False])
            self.assertEqual(route._plugin_states(), first)                            # nothing moved: the same value, so no announcement
            (pid_dir / "plugin-alpha.pid").write_text(str(os.getpid()))
            started = route._plugin_states()
            self.assertNotEqual(started, first)
            self.assertEqual([r[1] for r in started], [True, False])
            os.utime(pid_dir / "plugin-alpha.pid", ns=(1_000_000_000, 2_000_000_000))  # a restart rewrites the pid file
            restarted = route._plugin_states()
            self.assertNotEqual(restarted, started)
            self.assertEqual([r[1] for r in restarted], [True, False])
            os.utime(repo / ".git" / "logs" / "HEAD", ns=(1_000_000_000, 3_000_000_000))  # a commit or pull moves the reflog: "restart needed" may flip
            self.assertNotEqual(route._plugin_states(), restarted)
            (pid_dir / "plugin-alpha.pid").write_text("2147483646")                    # a dead pid is "not running"
            self.assertEqual([r[1] for r in route._plugin_states()], [False, False])
            (pid_dir / "plugin-beta.pid").write_text(str(os.getpid()))                 # beta-tab is tracked under its processName
            self.assertEqual([r[1] for r in route._plugin_states()], [False, True])

    def test_a_plugin_entry_without_a_cwd_follows_the_reflog_of_the_dashboards_own_directory(self):
        ppm, pid_dir, repo, manifest = self._plugin_fixture()
        bare = [{"name": "alpha", "slot": "hardware-tab"}]                           # the live manifest has no top-level cwd: behind_checkout runs git in os.getcwd()
        sub = repo / "python" / "dashboard"
        sub.mkdir(parents=True)
        with mock.patch.object(ppm, "PID_DIR", pid_dir), mock.patch.object(app, "_read_plugins_manifest", lambda: bare), mock.patch.object(os, "getcwd", lambda: str(sub)):
            before = route._plugin_states()
            self.assertIsNotNone(before[0][3])
            os.utime(repo / ".git" / "logs" / "HEAD", ns=(1_000_000_000, 5_000_000_000))
            self.assertNotEqual(route._plugin_states(), before)

    def test_plugin_states_survive_a_broken_manifest_a_missing_checkout_and_odd_entries(self):
        ppm, pid_dir, repo, manifest = self._plugin_fixture()
        with mock.patch.object(ppm, "PID_DIR", pid_dir):
            for bad in (lambda: (_ for _ in ()).throw(ValueError("boom")), lambda: {"not": "a list"}, lambda: [], lambda: ["str", 3, None, {"slot": "x", "name": "s", "cwd": 7}]):
                with mock.patch.object(app, "_read_plugins_manifest", bad):
                    value = route._plugin_states()
                    self.assertIsInstance(value, tuple)
            with mock.patch.object(app, "_read_plugins_manifest", lambda: [{"name": "gone", "slot": "s", "cwd": str(Path(self.pipe) / "no-such-dir")}]):
                self.assertEqual(route._plugin_states(), (["gone", False, None, None],))

    def test_the_head_log_is_found_like_gits_own_upward_search(self):
        root = Path(self.pipe) / "r"
        (root / ".git" / "logs").mkdir(parents=True)
        (root / "a" / "b").mkdir(parents=True)
        self.assertEqual(route._head_log_path(str(root / "a" / "b")), str(root / ".git" / "logs" / "HEAD"))
        wt = Path(self.pipe) / "wt"
        wt.mkdir()
        (wt / ".git").write_text("gitdir: " + str(root / ".git") + "\n")
        self.assertEqual(route._head_log_path(str(wt)), str(root / ".git" / "logs" / "HEAD"))
        (wt / ".git").write_text("not a gitdir line\n")
        self.assertIsNone(route._head_log_path(str(wt)))
        bare = Path(tempfile.mkdtemp(dir="/dev/shm" if os.path.isdir("/dev/shm") else None))
        self.addCleanup(shutil.rmtree, bare, True)
        self.assertIsNone(route._head_log_path(str(bare)))

    def test_the_route_registers_a_brain_dump_provider_over_the_active_projects_file(self):
        f = Path(self.pipe) / "brain-dump.json"
        with mock.patch.object(app, "brain_dump_path", lambda: f):
            fact = route._providers()["brain-dump-changed"]
            self.assertEqual(fact(), ())                                           # no file yet: nothing
            f.write_text("[]")
            first = fact()
            self.assertEqual([os.path.basename(t[0]) for t in first], ["brain-dump.json"])
            self.assertEqual(fact(), first)                                        # unchanged: an equal value announces nothing
            f.write_text('[{"id": 1}]')                                            # an entry written: size and mtime move
            self.assertNotEqual(fact(), first)
            other = Path(self.pipe) / "other.json"
            other.write_text("x")                                                  # a neighbouring file is not the Brain Dump file
            before = fact()
            other.write_text("changed")
            self.assertEqual(fact(), before)
        with mock.patch.object(app, "brain_dump_path", lambda: None):
            self.assertEqual(route._providers()["brain-dump-changed"](), ())      # no active project

    def test_the_route_registers_a_benchmark_provider_over_the_runs_directory(self):
        base = Path(self.pipe) / "benchmarks"
        with mock.patch.object(app, "BENCHMARK_STATE_DIR", base):
            fact = route._providers()["benchmark-changed"]
            self.assertEqual(fact(), ())
            (base / "run-1").mkdir(parents=True)
            (base / "current-run-id.txt").write_text("run-1")
            first = fact()
            self.assertEqual(sorted(os.path.basename(t[0]) for t in first), ["current-run-id.txt", "run-1"])
            (base / "run-1" / "status.json").write_text("{}")
            os.utime(base / "run-1", ns=(time.time_ns() + 9_000_000_000, time.time_ns() + 9_000_000_000))
            self.assertNotEqual(fact(), first)

    def test_the_route_registers_sampled_hardware_and_tokenfold_providers_with_their_intervals(self):
        providers = route._providers()
        self.assertEqual(providers["hardware-changed"][1], route.HARDWARE_INTERVAL_S)
        self.assertEqual(providers["tokenfold-changed"][1], route.TOKENFOLD_INTERVAL_S)
        self.assertEqual((route.HARDWARE_INTERVAL_S, route.TOKENFOLD_INTERVAL_S), (5.0, 10.0))

    def test_the_tokenfold_url_follows_its_port_and_the_hardware_url_follows_the_active_plugin(self):
        with mock.patch.dict(os.environ, {"TOKENFOLD_PORT": "9999"}):
            self.assertEqual(route._tokenfold_url(), "http://localhost:9999/tokenfold/stats")
        os.environ.pop("TOKENFOLD_PORT", None)
        self.assertEqual(route._tokenfold_url(), "http://localhost:9339/tokenfold/stats")
        with mock.patch("routes.hardware._active_hardware_plugin", return_value={"url": "http://h:1", "name": "p"}):
            self.assertEqual(route._hardware_url(), "http://h:1/api/hardware/stats")
        with mock.patch("routes.hardware._active_hardware_plugin", return_value=None):
            self.assertIsNone(route._hardware_url())
        with mock.patch("routes.hardware._active_hardware_plugin", return_value={"name": "p"}):
            self.assertIsNone(route._hardware_url())

    def test_the_sampled_providers_read_through_urlopen_and_round_what_they_get(self):
        class Resp:
            def read(self):
                return json.dumps({"gpu": 12345, "util": 87.4}).encode()

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        providers = route._providers()
        with mock.patch.object(route.urllib.request, "urlopen", return_value=Resp()) as urlopen:
            self.assertEqual(providers["tokenfold-changed"][0](), '{"gpu":12000,"util":87}')
        self.assertEqual(urlopen.call_args.args[0], route._tokenfold_url())
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 3.0)
        with mock.patch.object(route.urllib.request, "urlopen", side_effect=OSError("down")):
            self.assertIsNone(providers["tokenfold-changed"][0]())

    def test_the_route_registers_a_reports_provider_over_every_period_directory(self):
        root = Path(self.pipe) / "sb" / "Agent Manager Reports"
        for period in ("hourly", "daily", "weekly"):
            (root / period).mkdir(parents=True)
        (root / "hourly" / "2026-11-05T05h.md").write_text("r")
        (root / "daily" / "notes.txt").write_text("not a report")
        with mock.patch("routes.reports._reports_root", return_value=root):
            fact = route._providers()["reports-changed"]
            first = fact()
            self.assertEqual([os.path.basename(t[0]) for t in first], ["2026-11-05T05h.md"])
            (root / "weekly" / "2026-W45.md").write_text("w")
            self.assertEqual(sorted(os.path.basename(t[0]) for t in fact()), ["2026-11-05T05h.md", "2026-W45.md"])
        with mock.patch("routes.reports._reports_root", return_value=None):
            self.assertEqual(route._providers()["reports-changed"](), ())

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
