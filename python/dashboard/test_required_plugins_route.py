"""GET /api/required-plugins: the dashboard backend for the required-plugins status.

Run from python/dashboard: .venv/bin/python -B -m unittest test_required_plugins_route
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

OK = {"ok": True, "results": [{"name": "agent-manager-hub-tasks", "range": "^0.1.0", "found": "0.1.0", "status": "ok"}]}
UNMET = {"ok": False, "results": [{"name": "agent-manager-hub-tasks", "range": "^0.1.0", "found": None, "status": "MISSING", "message": "not installed"}]}


def proc(code, out="", err=""):
    return subprocess.CompletedProcess(["node"], code, out, err)


class TestRequiredPluginsRoute(unittest.TestCase):
    def get(self, **patch):
        with mock.patch("routes.required_plugins.subprocess.run", **patch) as run:
            resp = app.app.test_client().get("/api/required-plugins")
        return resp, run

    def test_all_met_is_passed_through(self):
        resp, run = self.get(return_value=proc(0, json.dumps(OK)))
        self.assertEqual((resp.status_code, resp.get_json()), (200, OK))
        self.assertEqual(run.call_args.args[0][2], "--json")
        self.assertEqual(run.call_args.kwargs["timeout"], 15)

    def test_an_unmet_plugin_exit_3_is_a_normal_answer(self):
        resp, _ = self.get(return_value=proc(3, json.dumps(UNMET), "required plugins unmet"))
        body = resp.get_json()
        self.assertEqual((resp.status_code, body["ok"], body["results"][0]["status"]), (200, False, "MISSING"))
        self.assertNotIn("error", body)

    def test_every_way_the_check_cannot_run_answers_200_with_an_error(self):
        cases = {
            "unusable config": dict(return_value=proc(2, "", "bad config")),
            "other exit": dict(return_value=proc(1, "", "boom")),
            "timeout": dict(side_effect=subprocess.TimeoutExpired("node", 15)),
            "no node": dict(side_effect=FileNotFoundError("node")),
            "not json": dict(return_value=proc(0, "hello")),
            "wrong shape": dict(return_value=proc(0, json.dumps([1, 2]))),
            "no ok key": dict(return_value=proc(0, json.dumps({"results": []}))),
        }
        for name, patch in cases.items():
            with self.subTest(name):
                resp, _ = self.get(**patch)
                body = resp.get_json()
                self.assertEqual((resp.status_code, body["ok"], body["results"]), (200, False, []))
                self.assertTrue(body["error"])

    def test_only_get_is_allowed(self):
        self.assertEqual(app.app.test_client().post("/api/required-plugins").status_code, 405)

    def test_the_real_check_answers_for_the_real_config(self):
        body = app.app.test_client().get("/api/required-plugins").get_json()
        self.assertIn("ok", body)
        self.assertTrue(body["results"] or body.get("error"))


if __name__ == "__main__":
    unittest.main()
