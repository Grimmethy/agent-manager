"""Tests for GET /api/workflow-graph (HUB0323 piece W-A2).

Every external call is an injected fake: nothing here starts node, reads the queue or calls a mutating route.

Run: .venv/bin/python -m unittest python.dashboard.test_workflow_graph_route -v
"""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

from flask import Response

sys.path.insert(0, str(Path(__file__).resolve().parent))

import app  # noqa: E402
from routes import workflow_graph as wg  # noqa: E402

GRAPH = {"schemaVersion": 1, "generatedAt": "2026-11-02T00:00:00.000Z", "nodes": [{"id": "reviewer"}], "edges": [], "groups": [], "warnings": []}


def _ok(value):
    return lambda: value


def _boom(message):
    def fail():
        raise RuntimeError(message)
    return fail


class Recorder:
    def __init__(self, result=None):
        self.payload = None
        self.result = GRAPH if result is None else result

    def __call__(self, payload):
        self.payload = payload
        return json.loads(json.dumps(self.result))


def _assemble(**over):
    parts = dict(run_lanes=_ok([{"id": "worker-3090"}]), get_instances=_ok([{"instanceId": "reviewer"}]),
                 get_topology=_ok([{"name": "x"}]), get_models=_ok({"overrides": {}}), run_builder=Recorder())
    parts.update(over)
    return wg.assemble_graph(**parts), parts["run_builder"]


class TestAssembleGraph(unittest.TestCase):
    def test_happy_path_returns_the_builder_output_unchanged(self):
        out, builder = _assemble()
        self.assertEqual(out, GRAPH)
        self.assertEqual(out["schemaVersion"], 1)
        self.assertEqual(set(builder.payload), {"lanes", "instances", "topology", "models"})
        self.assertEqual(builder.payload["lanes"], [{"id": "worker-3090"}])
        self.assertEqual(builder.payload["topology"], [{"name": "x"}])

    def test_each_failing_input_still_returns_the_graph_with_a_warning_naming_it(self):
        defaults = {"run_lanes": ("lanes", []), "get_instances": ("instances", []), "get_topology": ("topology", []), "get_models": ("models", {})}
        for param, (name, default) in defaults.items():
            with self.subTest(param=param):
                out, builder = _assemble(**{param: _boom("kaput")})
                self.assertEqual(out["schemaVersion"], 1)
                self.assertEqual(out["warnings"], [f"{name}: kaput"])
                self.assertEqual(builder.payload[name], default)

    def test_two_failures_add_two_warnings_in_input_order(self):
        out, _ = _assemble(run_lanes=_boom("a"), get_models=_boom("b"))
        self.assertEqual(out["warnings"], ["lanes: a", "models: b"])

    def test_input_warnings_are_appended_after_the_builders_own(self):
        builder = Recorder(dict(GRAPH, warnings=["from builder"]))
        out, _ = _assemble(run_builder=builder, get_instances=_boom("x"))
        self.assertEqual(out["warnings"], ["from builder", "instances: x"])

    def test_builder_failure_returns_available_false_with_a_truncated_reason(self):
        def broken(_payload):
            raise RuntimeError("e" * 500)
        out, _ = _assemble(run_builder=broken)
        self.assertEqual(out["available"], False)
        self.assertEqual(out["reason"], "e" * 300)
        self.assertNotIn("schemaVersion", out)

    def test_the_inputs_are_gathered_even_when_the_builder_then_fails(self):
        calls = []
        def fetch(name):
            return lambda: calls.append(name) or []
        def broken(_payload):
            raise RuntimeError("no")
        wg.assemble_graph(fetch("l"), fetch("i"), fetch("t"), fetch("m"), broken)
        self.assertEqual(calls, ["l", "i", "t", "m"])


class TestOptionalInputs(unittest.TestCase):
    CONFIG = {"schemaVersion": 1, "groups": [], "edges": [], "labels": {"a": "A"}}

    def _assemble(self, **over):
        recorder = Recorder()
        parts = dict(run_lanes=_ok([]), get_instances=_ok([]), get_topology=_ok([]), get_models=_ok({}), run_builder=recorder)
        parts.update(over)
        return wg.assemble_graph(**parts), recorder

    def test_without_the_optional_getters_the_payload_has_exactly_the_four_inputs(self):
        out, builder = self._assemble()
        self.assertEqual(set(builder.payload), {"lanes", "instances", "topology", "models"})
        self.assertEqual(out, GRAPH)

    def test_the_workflow_config_reaches_the_builder_and_its_warnings_follow_the_input_warnings(self):
        out, builder = self._assemble(get_workflow=_ok({"config": self.CONFIG, "warnings": ["file: dropped a group"]}), get_instances=_boom("kaput"), run_builder=Recorder(dict(GRAPH, warnings=["from builder"])))
        self.assertEqual(out["warnings"], ["from builder", "instances: kaput", "file: dropped a group"])

    def test_the_workflow_config_is_passed_as_workflow(self):
        _, builder = self._assemble(get_workflow=_ok({"config": self.CONFIG, "warnings": []}))
        self.assertEqual(builder.payload["workflow"], self.CONFIG)
        self.assertNotIn("watchdogScripts", builder.payload)

    def test_the_watchdog_scripts_are_passed_as_watchdog_scripts(self):
        scripts = [{"plugin": "p", "script": "a.js"}]
        _, builder = self._assemble(get_watchdog_scripts=_ok(scripts))
        self.assertEqual(builder.payload["watchdogScripts"], scripts)
        self.assertNotIn("workflow", builder.payload)
        _, empty = self._assemble(get_watchdog_scripts=_ok([]))
        self.assertEqual(empty.payload["watchdogScripts"], [])

    def test_a_failing_getter_adds_one_warning_naming_it_and_leaves_its_key_out(self):
        out, builder = self._assemble(get_workflow=_boom("kaput"), get_watchdog_scripts=_ok([]))
        self.assertEqual(out["warnings"], ["workflow: kaput"])
        self.assertNotIn("workflow", builder.payload)
        self.assertIn("watchdogScripts", builder.payload)
        out, builder = self._assemble(get_workflow=_ok({"config": self.CONFIG, "warnings": []}), get_watchdog_scripts=_boom("nope"))
        self.assertEqual(out["warnings"], ["watchdogScripts: nope"])
        self.assertNotIn("watchdogScripts", builder.payload)
        self.assertIn("workflow", builder.payload)

    def test_a_malformed_result_is_treated_like_a_failure(self):
        for bad in (["x"], None, "text", {"warnings": []}, {"config": "x"}, {"config": []}):
            out, builder = self._assemble(get_workflow=_ok(bad))
            self.assertNotIn("workflow", builder.payload, repr(bad))
            self.assertEqual(len(out["warnings"]), 1, repr(bad))
            self.assertTrue(out["warnings"][0].startswith("workflow: "))
        for bad in ({"scripts": []}, None, "x", 5):
            out, builder = self._assemble(get_watchdog_scripts=_ok(bad))
            self.assertNotIn("watchdogScripts", builder.payload, repr(bad))
            self.assertTrue(out["warnings"][0].startswith("watchdogScripts: "))

    def test_warnings_keep_the_input_order_lanes_first_then_workflow_then_watchdog_scripts(self):
        out, _ = self._assemble(run_lanes=_boom("a"), get_workflow=_boom("b"), get_watchdog_scripts=_boom("c"))
        self.assertEqual(out["warnings"], ["lanes: a", "workflow: b", "watchdogScripts: c"])

    def test_a_workflow_config_without_warnings_adds_none(self):
        out, _ = self._assemble(get_workflow=_ok({"config": self.CONFIG}))
        self.assertEqual(out, GRAPH)

    def test_a_failing_builder_still_gives_available_false_when_the_optional_inputs_are_given(self):
        def broken(_payload):
            raise RuntimeError("builder down")
        out, _ = self._assemble(run_builder=broken, get_workflow=_ok({"config": self.CONFIG, "warnings": ["w"]}), get_watchdog_scripts=_ok([]))
        self.assertEqual(out, {"available": False, "reason": "builder down"})


class TestJsonOf(unittest.TestCase):
    def test_unwraps_a_response_and_a_response_status_tuple(self):
        resp = Response(json.dumps({"a": 1}), mimetype="application/json")
        self.assertEqual(wg._json_of(resp), {"a": 1})
        self.assertEqual(wg._json_of((resp, 504)), {"a": 1})
        self.assertEqual(wg._json_of(Response(json.dumps([1, 2]), mimetype="application/json")), [1, 2])

    def test_rejects_non_responses_and_non_json_bodies(self):
        with self.assertRaises(ValueError):
            wg._json_of({"a": 1})
        with self.assertRaises(ValueError):
            wg._json_of(Response("not json", mimetype="text/plain"))


class TestRoute(unittest.TestCase):
    def test_route_is_registered_as_get_only(self):
        rules = [r for r in app.app.url_map.iter_rules() if r.rule == "/api/workflow-graph"]
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0].methods - {"HEAD", "OPTIONS"}, {"GET"})

    def test_view_returns_200_json_with_schema_version_1(self):
        with mock.patch.object(wg, "assemble_graph", return_value=dict(GRAPH)) as fake:
            resp = app.app.test_client().get("/api/workflow-graph")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["schemaVersion"], 1)
        self.assertEqual(set(fake.call_args.kwargs), {"run_lanes", "get_instances", "get_topology", "get_models", "run_builder", "get_workflow", "get_watchdog_scripts"})

    def test_view_answers_200_with_available_false_when_the_builder_fails(self):
        with mock.patch.object(wg, "assemble_graph", return_value={"available": False, "reason": "boom"}):
            resp = app.app.test_client().get("/api/workflow-graph")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json(), {"available": False, "reason": "boom"})

    def test_run_node_turns_a_nonzero_exit_into_an_error_with_stderr(self):
        done = mock.Mock(returncode=2, stdout="", stderr="bad usage " * 100)
        with mock.patch.object(wg.subprocess, "run", return_value=done):
            with self.assertRaises(RuntimeError) as ctx:
                wg._run_node("workflow-graph.js", ["--stdin"], {})
        self.assertEqual(len(str(ctx.exception)), 300)

    def test_run_node_parses_json_stdout_and_passes_stdin_and_timeout(self):
        done = mock.Mock(returncode=0, stdout='{"ok": true}', stderr="")
        with mock.patch.object(wg.subprocess, "run", return_value=done) as run:
            self.assertEqual(wg._run_node("workflow-graph.js", ["--stdin"], {"K": "V"}, "{}"), {"ok": True})
        self.assertEqual(run.call_args.kwargs["input"], "{}")
        self.assertEqual(run.call_args.kwargs["timeout"], wg.NODE_TIMEOUT_SECONDS)
        self.assertEqual(run.call_args.args[0][0], "node")
        self.assertTrue(run.call_args.args[0][1].endswith("workflow-graph.js"))


class TestViewWiring(unittest.TestCase):
    """The real view with every collaborator patched: checks which node script gets which arguments."""

    WORKFLOW_OUT = {"config": {"schemaVersion": 1, "groups": [], "edges": [], "labels": {}}, "warnings": []}
    SCRIPTS_OUT = {"scripts": [], "skipped": []}

    def _get(self, topology_body, workflow_out=None, scripts_out=None):
        calls = []

        def fake_run_node(script, args, env, stdin_text=None):
            calls.append((script, list(args), stdin_text))
            if script == "lanes.js":
                return [{"id": "worker-3090"}]
            if script == "workflow-config.js":
                return self.WORKFLOW_OUT if workflow_out is None else workflow_out
            if script == "plugin-watchdog-scripts.js":
                return self.SCRIPTS_OUT if scripts_out is None else scripts_out
            return dict(GRAPH)

        def resp(body):
            return lambda: Response(json.dumps(body), mimetype="application/json")

        with mock.patch.object(wg, "_run_node", side_effect=fake_run_node), \
                mock.patch("routes.instances.api_instances", resp([{"instanceId": "reviewer"}])), \
                mock.patch("routes.job_types.api_pipeline_map", resp(topology_body)), \
                mock.patch("routes.worker_models_1_more.api_worker_models", resp({"overrides": {}})):
            out = app.app.test_client().get("/api/workflow-graph")
        return out, calls

    def test_lanes_and_builder_get_the_right_scripts_arguments_and_payload(self):
        out, calls = self._get({"available": True, "sources": [{"name": "src-a"}]})
        self.assertEqual(out.status_code, 200)
        self.assertEqual(calls[0][:2], ("lanes.js", []))
        builder = [c for c in calls if c[0] == "workflow-graph.js"]
        self.assertEqual(len(builder), 1)
        self.assertEqual(builder[0][:2], ("workflow-graph.js", ["--stdin"]))
        payload = json.loads(builder[0][2])
        self.assertEqual(payload["lanes"], [{"id": "worker-3090"}])
        self.assertEqual(payload["instances"], [{"instanceId": "reviewer"}])
        self.assertEqual(payload["topology"], [{"name": "src-a"}])
        self.assertEqual(payload["models"], {"overrides": {}})
        self.assertEqual(out.get_json()["warnings"], [])

    def test_an_unavailable_pipeline_map_gives_an_empty_topology_and_a_warning(self):
        out, calls = self._get({"available": False, "reason": "node missing"})
        self.assertEqual(out.status_code, 200)
        self.assertEqual(json.loads([c for c in calls if c[0] == "workflow-graph.js"][0][2])["topology"], [])
        warnings = out.get_json()["warnings"]
        self.assertEqual(len(warnings), 1)
        self.assertTrue(warnings[0].startswith("topology: "))
        self.assertIn("node missing", warnings[0])

    def test_node_calls_time_out_after_15_seconds(self):
        self.assertEqual(wg.NODE_TIMEOUT_SECONDS, 15)

    def test_the_workflow_file_and_the_watchdog_scripts_are_read_with_their_own_scripts_and_reach_the_builder(self):
        config = {"schemaVersion": 1, "groups": [{"id": "group:x", "label": "X", "children": ["worker-3090"], "collapsed": False}], "edges": [], "labels": {}}
        scripts = [{"plugin": "uiforge", "root": "/r", "script": "harness/watchdog-trigger.js", "abs": "/r/harness/watchdog-trigger.js"}]
        out, calls = self._get({"available": True, "sources": []}, {"config": config, "warnings": ["workflow file: one thing was dropped"]}, {"scripts": scripts, "skipped": []})
        names = [c[0] for c in calls]
        self.assertEqual(names, ["lanes.js", "workflow-config.js", "plugin-watchdog-scripts.js", "workflow-graph.js"])
        self.assertEqual(calls[1][:2], ("workflow-config.js", []))
        self.assertEqual(calls[2][:2], ("plugin-watchdog-scripts.js", ["--json"]))
        self.assertEqual(calls[3][:2], ("workflow-graph.js", ["--stdin"]))
        payload = json.loads(calls[3][2])
        self.assertEqual(payload["workflow"], config)
        self.assertEqual(payload["watchdogScripts"], scripts)
        self.assertEqual(out.get_json()["warnings"], ["workflow file: one thing was dropped"])

    def test_a_watchdog_output_without_a_scripts_list_gives_a_warning_and_no_key(self):
        out, calls = self._get({"available": True, "sources": []}, scripts_out={"skipped": []})
        payload = json.loads([c for c in calls if c[0] == "workflow-graph.js"][0][2])
        self.assertNotIn("watchdogScripts", payload)
        self.assertIn("workflow", payload)
        warnings = out.get_json()["warnings"]
        self.assertEqual(len(warnings), 1)
        self.assertTrue(warnings[0].startswith("watchdogScripts: "))


if __name__ == "__main__":
    unittest.main()
