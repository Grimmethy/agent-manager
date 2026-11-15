"""The lane caches' stale-while-revalidate rule (swr_cache.py, app.worker_lane_ids/worker_lane_defs), ADR-0024, 'UI triggers, not polls' piece 4.

Run: .venv/bin/python -m unittest test_swr_cache -v   (from python/dashboard)
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import swr_cache  # noqa: E402


class Cached(unittest.TestCase):
    def setUp(self):
        self.cache = {"at": 0.0, "v": []}
        self.clock = [100.0]
        self.key = ["k1"]
        self.computes = []
        self.queue = []
        swr_cache._inflight.clear()
        self.addCleanup(swr_cache._inflight.clear)

    def compute(self, result=None):
        def fn():
            self.computes.append(1)
            return result if result is not None else ["new%d" % len(self.computes)]
        return fn

    def get(self, compute=None, ttl=600.0):
        return swr_cache.cached_value(self.cache, "v", lambda: self.key[0], compute or self.compute(), ttl, now=lambda: self.clock[0], background=self.queue.append)

    def run_queue(self):
        jobs, self.queue = self.queue, []
        for j in jobs:
            j()

    def test_an_empty_cache_computes_inline_once_and_then_serves_it(self):
        self.assertEqual(self.get(), ["new1"])
        self.assertEqual(self.get(), ["new1"])
        self.assertEqual(len(self.computes), 1)
        self.assertEqual(self.queue, [])
        self.assertEqual(self.cache["key"], "k1")
        self.assertEqual(self.cache["at"], 100.0)

    def test_an_empty_compute_result_leaves_the_cache_empty_and_is_retried_next_call(self):
        self.assertEqual(self.get(self.compute([])), [])
        self.assertEqual(self.get(self.compute([])), [])
        self.assertEqual(len(self.computes), 2)

    def test_a_changed_key_serves_the_old_value_at_once_and_refreshes_in_the_background(self):
        self.get()
        self.key[0] = "k2"
        self.clock[0] = 101.0
        self.assertEqual(self.get(), ["new1"])             # no waiting: the old value
        self.assertEqual(len(self.computes), 1)
        self.assertEqual(len(self.queue), 1)
        self.run_queue()
        self.assertEqual(self.get(), ["new2"])
        self.assertEqual(self.cache["key"], "k2")
        self.assertEqual(self.cache["at"], 101.0)

    def test_the_slow_reconcile_age_also_makes_it_stale(self):
        self.get()
        self.clock[0] = 100.0 + 599.0
        self.get()
        self.assertEqual(self.queue, [])
        self.clock[0] = 100.0 + 600.0
        self.assertEqual(self.get(), ["new1"])
        self.assertEqual(len(self.queue), 1)

    def test_only_one_refresh_runs_at_a_time(self):
        self.get()
        self.key[0] = "k2"
        self.get()
        self.get()
        self.get()
        self.assertEqual(len(self.queue), 1)
        self.run_queue()
        self.key[0] = "k3"
        self.get()
        self.assertEqual(len(self.queue), 1)               # the in-flight mark was released, so a new change starts a new refresh

    def test_a_failed_refresh_keeps_the_last_good_value_and_releases_the_in_flight_mark(self):
        self.get()
        self.key[0] = "k2"
        self.get(self.compute([]))
        self.run_queue()
        self.assertEqual(self.cache["v"], ["new1"])
        self.assertEqual(self.cache["key"], "k1")
        self.get(self.compute([]))
        self.assertEqual(len(self.queue), 1)

    def test_a_raising_compute_is_a_failed_refresh_not_an_error(self):
        self.get()
        self.key[0] = "k2"
        def boom():
            raise RuntimeError("x")
        self.assertEqual(self.get(boom), ["new1"])
        self.run_queue()
        self.assertEqual(self.cache["v"], ["new1"])
        self.assertEqual(self.get(boom), ["new1"])
        self.assertEqual(len(self.queue), 1)

    def test_a_raising_compute_with_nothing_cached_gives_an_empty_list(self):
        def boom():
            raise RuntimeError("x")
        self.assertEqual(self.get(boom), [])

    def test_an_unreadable_key_counts_as_changed(self):
        self.get()
        def bad():
            raise OSError("x")
        out = swr_cache.cached_value(self.cache, "v", bad, self.compute(), 600.0, now=lambda: self.clock[0], background=self.queue.append)
        self.assertEqual(out, ["new1"])
        self.assertEqual(len(self.queue), 1)

    def test_a_thread_that_cannot_start_serves_the_stale_value_and_tries_again_next_call(self):
        self.get()
        self.key[0] = "k2"
        def nope(fn):
            raise RuntimeError("no threads")
        out = swr_cache.cached_value(self.cache, "v", lambda: self.key[0], self.compute(), 600.0, now=lambda: self.clock[0], background=nope)
        self.assertEqual(out, ["new1"])
        self.get()
        self.assertEqual(len(self.queue), 1)

    def test_an_empty_value_is_never_served_as_valid_even_when_the_key_and_age_match(self):
        self.cache.update(at=100.0, key="k1", v=[])
        self.assertEqual(self.get(), ["new1"])
        self.assertEqual(len(self.computes), 1)

    def test_a_key_that_keeps_failing_never_counts_as_unchanged(self):
        def bad():
            raise OSError("x")
        def call():
            return swr_cache.cached_value(self.cache, "v", bad, self.compute(), 600.0, now=lambda: self.clock[0], background=self.queue.append)
        call()
        call()
        self.assertEqual(len(self.queue), 1)

    def test_the_returned_list_is_a_copy(self):
        out = self.get()
        out.append("x")
        self.assertEqual(self.get(), ["new1"])

    def test_the_default_runner_starts_a_daemon_thread(self):
        seen = []
        with mock.patch.object(swr_cache.threading, "Thread") as T:
            swr_cache.run_background(lambda: seen.append(1))
        T.assert_called_once()
        self.assertEqual(T.call_args.kwargs["daemon"], True)
        T.return_value.start.assert_called_once()


class LaneFunctions(unittest.TestCase):
    def setUp(self):
        app._LANE_IDS_CACHE.update(at=0.0, ids=[])
        app._LANE_DEFS_CACHE.update(at=0.0, lanes=[])
        app._LANE_IDS_CACHE.pop("key", None)
        app._LANE_DEFS_CACHE.pop("key", None)
        swr_cache._inflight.clear()
        self.jobs = []
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.registry = Path(self.td.name) / "lanes.json"
        self.registry.write_text("[]")
        env = {k: v for k, v in os.environ.items() if not k.startswith("AGENT_MANAGER_")}
        env.update(AGENT_MANAGER_LOCAL_GPU="3090", AGENT_MANAGER_LANES_PATH=str(self.registry))
        for p in (mock.patch.dict(os.environ, env, clear=True), mock.patch.object(app, "read_env_file", return_value={}),
                  mock.patch.object(swr_cache, "run_background", self.jobs.append)):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(lambda: app._LANE_IDS_CACHE.update(at=0.0, ids=[]))
        self.addCleanup(lambda: app._LANE_DEFS_CACHE.update(at=0.0, lanes=[]))
        self.addCleanup(swr_cache._inflight.clear)

    def run_jobs(self):
        jobs, self.jobs[:] = list(self.jobs), []
        for j in jobs:
            j()

    def test_node_runs_once_while_nothing_it_reads_changes(self):
        real = app.subprocess.run
        with mock.patch.object(app.subprocess, "run", wraps=real) as run:
            first = app.worker_lane_defs()
            for _ in range(5):
                self.assertEqual(app.worker_lane_defs(), first)
                app.worker_lane_ids()
            ids_calls = [c for c in run.call_args_list if "--ids" in c.args[0]]
            defs_calls = [c for c in run.call_args_list if "--ids" not in c.args[0]]
        self.assertEqual(len(defs_calls), 1)
        self.assertEqual(len(ids_calls), 1)
        self.assertEqual(self.jobs, [])
        self.assertEqual([l["id"] for l in first], ["worker-3090"])

    def test_editing_the_lanes_registry_serves_the_old_answer_at_once_and_the_new_one_after_the_background_refresh(self):
        self.assertEqual([l["id"] for l in app.worker_lane_defs()], ["worker-3090"])
        self.registry.write_text(json.dumps([{"gpu": "rx580", "ollamaUrl": "http://100.96.112.78:11434", "model": "m", "taskClasses": ["brain_dump_sort"]}]))
        with mock.patch.object(app.subprocess, "run", side_effect=AssertionError("a request must not wait for node")):
            self.assertEqual([l["id"] for l in app.worker_lane_defs()], ["worker-3090"])
        self.assertEqual(len(self.jobs), 1)
        self.run_jobs()
        self.assertEqual([l["id"] for l in app.worker_lane_defs()], ["worker-3090", "worker-rx580"])
        self.assertEqual(self.jobs, [])

    def test_a_changed_agent_manager_environment_makes_the_cache_stale(self):
        app.worker_lane_ids()
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_LOCAL_GPU": "p40"}):
            self.assertEqual(app.worker_lane_ids(), ["worker-3090"])
            self.assertEqual(len(self.jobs), 1)
            self.run_jobs()
            self.assertEqual(app.worker_lane_ids(), ["worker-p40"])

    def test_a_changed_env_file_makes_the_cache_stale(self):
        env_file = Path(self.td.name) / "agent-manager.env"
        env_file.write_text("A=1\n")
        with mock.patch.object(app, "ENV_FILE_PATH", env_file):
            app.worker_lane_ids()
            env_file.write_text("A=22\n")
            app.worker_lane_ids()
        self.assertEqual(len(self.jobs), 1)

    def test_an_unrelated_environment_variable_does_not_make_the_cache_stale(self):
        app.worker_lane_ids()
        with mock.patch.dict(os.environ, {"SOME_UNRELATED_VARIABLE": "1"}):
            app.worker_lane_ids()
        self.assertEqual(self.jobs, [])

    def test_lane_definitions_without_an_id_and_non_objects_are_dropped(self):
        out = json.dumps([{"id": "worker-a", "gpu": "a"}, {"gpu": "no-id"}, "junk", 3, {"id": ""}])
        with mock.patch.object(app.subprocess, "run", return_value=mock.Mock(stdout=out)):
            self.assertEqual(app.worker_lane_defs(), [{"id": "worker-a", "gpu": "a"}])

    def test_the_inputs_key_survives_a_missing_registry_and_env_file(self):
        self.registry.unlink()
        with mock.patch.object(app, "ENV_FILE_PATH", Path(self.td.name) / "nope.env"):
            key = app._lane_inputs_key()
        self.assertEqual(key[0], None)
        self.assertEqual(key[1], None)

    def test_the_default_registry_is_lanes_json_next_to_src(self):
        env = dict(os.environ)
        env.pop("AGENT_MANAGER_LANES_PATH")
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(app.os, "stat", wraps=app.os.stat) as st:
            app._lane_inputs_key()
        self.assertIn(str(app.SRC_DIR.parent / "lanes.json"), [str(c.args[0]) for c in st.call_args_list])

    def test_node_unavailable_still_answers_worker_local_and_empty_defs(self):
        with mock.patch.object(app.subprocess, "run", side_effect=OSError("no node")):
            self.assertEqual(app.worker_lane_ids(), ["worker-local"])
            self.assertEqual(app.worker_lane_defs(), [])

    def test_ttl_is_the_slow_reconcile_not_a_minute(self):
        self.assertEqual(app._LANE_IDS_TTL_S, 600.0)


if __name__ == "__main__":
    unittest.main()
