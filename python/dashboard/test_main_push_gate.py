"""The main-push gate (HUB0364): unit rules, the edge hook on the two merge routes, and a parity check against the Node implementation.

Run from python/dashboard: .venv/bin/python -m unittest test_main_push_gate
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import main_push_gate as gate  # noqa: E402
from gate_test_support import BRANCH, NOW, SHA, EdgeBase, env_without_bypass, ledger, make_queue, rec  # noqa: E402

REPO_ROOT_JS = Path(__file__).resolve().parents[2]


class TestRules(unittest.TestCase):
    def check(self, qdir, branch=BRANCH, sha=SHA):
        return gate.assert_main_push_ready(qdir, branch, sha, caller="t", task_id="T1", now=NOW)

    def test_chat_and_manual_merge_for_the_exact_sha_pass_without_a_ledger_row(self):
        for source in ("chat", "manual"):
            q = make_queue({BRANCH: {SHA: rec(source=source)}})
            with env_without_bypass():
                self.assertEqual(self.check(q), {"allowed": True, "bypass": False})
            self.assertEqual(ledger(q), [])

    def test_another_sha_is_refused_and_ledgered(self):
        q = make_queue({BRANCH: {"b" * 40: rec()}})
        with env_without_bypass(), self.assertRaises(gate.MainPushNotReady) as cm:
            self.check(q)
        self.assertIn("no verdict recorded", str(cm.exception))
        row = ledger(q)[0]
        self.assertEqual((row["outcome"], row["branch"], row["headSha"], row["caller"], row["taskId"], row["at"]), ("refused", BRANCH, SHA, "t", "T1", "2026-11-10T12:00:00.000Z"))

    def test_other_verdicts_and_sources_are_refused(self):
        for over, text in (({"verdict": "needs-work"}, "not 'merge'"), ({"verdict": "hold"}, "not 'merge'"), ({"source": "worker"}, "not a human source"), ({"source": "deterministic"}, "not a human source")):
            q = make_queue({BRANCH: {SHA: rec(**over)}})
            with env_without_bypass(), self.assertRaisesRegex(gate.MainPushNotReady, text):
                self.check(q)

    def test_bad_timestamp_and_max_age(self):
        for bad in (None, "yesterday-ish"):
            q = make_queue({BRANCH: {SHA: rec(verifiedAt=bad)}})
            with env_without_bypass(), self.assertRaisesRegex(gate.MainPushNotReady, "valid verifiedAt"):
                self.check(q)
        q = make_queue({BRANCH: {SHA: rec(verifiedAt="2026-11-08T00:00:00Z")}})
        with env_without_bypass():
            self.assertTrue(self.check(q)["allowed"])
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH": "", "AGENT_MANAGER_MAIN_PUSH_READY_MAX_AGE_HOURS": "24"}), self.assertRaisesRegex(gate.MainPushNotReady, "older than 24 hour"):
            self.check(q)

    def test_missing_store_and_empty_arguments(self):
        with env_without_bypass():
            with self.assertRaisesRegex(gate.MainPushNotReady, "no verdict recorded"):
                self.check(make_queue())
            with self.assertRaisesRegex(gate.MainPushNotReady, "both required"):
                self.check(make_queue({BRANCH: {SHA: rec()}}), branch="")
            with self.assertRaisesRegex(gate.MainPushNotReady, "both required"):
                self.check(make_queue({BRANCH: {SHA: rec()}}), sha="")

    def test_env_bypass_allows_warns_and_writes_nothing(self):
        q = make_queue()
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH": "true"}), self.assertLogs("main_push_rules", level="WARNING") as logs:
            self.assertEqual(self.check(q), {"allowed": True, "bypass": True})
        self.assertIn("AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true", logs.output[0])
        self.assertEqual(ledger(q), [])
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH": "1"}), self.assertRaises(gate.MainPushNotReady):
            self.check(q)


class TestEdgeRefusals(EdgeBase):
    """POST /api/git/branches/<branch>/merge and .../merge-early are refused before any route code unless the exact head has a READY record."""

    def test_merge_without_a_record_is_refused_before_the_route_runs(self):
        resp, listing = self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual(resp.status_code, 409)
        body = resp.get_json()
        self.assertEqual((body["succeeded"], body["code"]), (False, "MAIN_PUSH_NOT_READY"))
        listing.assert_not_called()
        self.assertEqual(ledger(self.qdir)[0]["caller"], "dashboard-merge")

    def test_force_does_not_skip_the_gate(self):
        resp, listing = self.post(f"/api/git/branches/{BRANCH}/merge", json={"force": True})
        self.assertEqual(resp.status_code, 409)
        listing.assert_not_called()

    def test_a_record_for_an_older_head_is_refused(self):
        self.record({BRANCH: {"b" * 40: rec()}})
        resp, _ = self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual(resp.status_code, 409)

    def test_a_worker_record_is_refused(self):
        self.record({BRANCH: {SHA: rec(source="worker")}})
        resp, _ = self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual(resp.status_code, 409)
        self.assertIn("not a human source", resp.get_json()["reason"])

    def test_merge_early_goes_through_the_same_gate(self):
        resp, _ = self.post(f"/api/git/held-hub-branches/{BRANCH}/merge-early")
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(ledger(self.qdir)[0]["caller"], "dashboard-merge-early")

    def test_a_timed_out_head_read_refuses(self):
        def slow(args, cwd, timeout=30):
            if args[0] == "rev-parse":
                raise subprocess.TimeoutExpired("git rev-parse", 30)
            return ""
        with mock.patch.object(app, "_run_git", side_effect=slow):
            resp, listing = self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual(resp.status_code, 500)
        listing.assert_not_called()

    def test_a_gate_that_cannot_run_refuses(self):
        with mock.patch.object(gate, "assert_main_push_ready", side_effect=ValueError("boom")):
            resp, listing = self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual(resp.status_code, 500)
        self.assertIn("could not run", resp.get_json()["reason"])
        listing.assert_not_called()


class TestEdgePassThrough(EdgeBase):
    """Requests the gate lets through: a READY record, the bypass, a missing branch or repository, and every other route."""

    def test_a_chat_record_for_the_exact_head_lets_the_route_run(self):
        self.record({BRANCH: {SHA: rec()}})
        resp, listing = self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual(resp.status_code, 404)  # the route itself ran and found the branch unlisted
        listing.assert_called()
        self.assertEqual(ledger(self.qdir), [])

    def test_other_requests_are_untouched(self):
        resp = self.client.get(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual(resp.status_code, 405)
        resp, _ = self.post(f"/api/git/branches/{BRANCH}/discard")
        self.assertNotEqual(resp.get_json(silent=True) and resp.get_json().get("code"), "MAIN_PUSH_NOT_READY")
        self.assertEqual(ledger(self.qdir), [])

    def test_a_missing_branch_is_left_to_the_route(self):
        self.head = None
        resp, listing = self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual(resp.status_code, 404)
        listing.assert_called()

    def test_the_env_bypass_lets_the_route_run_and_does_no_git_work(self):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH": "true"}):
            resp, listing = self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual(resp.status_code, 404)
        listing.assert_called()
        self.assertEqual(self.git_calls, [])
        self.assertEqual(ledger(self.qdir), [])

    def test_a_missing_repository_is_left_to_the_route(self):
        with mock.patch.object(app, "_run_git", side_effect=FileNotFoundError("no such repository")):
            resp, listing = self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual(resp.status_code, 404)
        listing.assert_called()

    def test_the_head_is_fetched_before_it_is_read(self):
        self.record({BRANCH: {SHA: rec()}})
        self.post(f"/api/git/branches/{BRANCH}/merge")
        self.assertEqual([c[0] for c in self.git_calls[:2]], ["fetch", "rev-parse"])


class TestParityWithNode(unittest.TestCase):
    """The Node gate (src/lib/main-push-policy.js) and this one must give the same answer and the same reason for the same record."""

    CASES = {
        "ok-chat": rec(),
        "ok-manual": rec(source="manual"),
        "needs-work": rec(verdict="needs-work"),
        "hold": rec(verdict="hold"),
        "worker": rec(source="worker"),
        "deterministic": rec(source="deterministic"),
        "no-time": {k: v for k, v in rec().items() if k != "verifiedAt"},
        "bad-time": rec(verifiedAt="yesterday-ish"),
        "micro-time": rec(verifiedAt="2026-11-10T11:00:00.123456Z"),
    }

    def node_result(self, store):
        q = make_queue(store)
        script = (
            "const m=require('./src/lib/main-push-policy.js');"
            f"try{{m.assertMainPushReady({json.dumps(BRANCH)},{json.dumps(SHA)},{{pipelineDir:{json.dumps(str(q.parent))},now:new Date('2026-11-10T12:00:00Z')}});console.log('OK')}}"
            "catch(e){console.log('REFUSED '+e.message)}"
        )
        # the Node gate reads <pipelineDir>/queue/branch-verdicts.json, so mirror the layout
        pipe = Path(tempfile.mkdtemp(prefix="main-push-parity-"))
        (pipe / "queue").mkdir()
        (pipe / "queue" / "branch-verdicts.json").write_text(json.dumps(store))
        script = script.replace(json.dumps(str(q.parent)), json.dumps(str(pipe)))
        out = subprocess.run(["node", "-e", script], cwd=REPO_ROOT_JS, capture_output=True, text=True, timeout=60,
                             env={**os.environ, "AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH": "", "AGENT_MANAGER_MAIN_PUSH_READY_MAX_AGE_HOURS": ""})
        return out.stdout.strip()

    def py_result(self, store):
        q = make_queue(store)
        with env_without_bypass():
            try:
                gate.assert_main_push_ready(q, BRANCH, SHA, now=NOW)
                return "OK"
            except gate.MainPushNotReady as exc:
                return "REFUSED " + str(exc)

    def test_same_answer_and_reason_for_every_case(self):
        for name, record in self.CASES.items():
            store = {BRANCH: {SHA: record}}
            with self.subTest(case=name):
                self.assertEqual(self.py_result(store), self.node_result(store))

    def test_same_answer_when_the_sha_is_unknown_and_when_there_is_no_store(self):
        for store in ({BRANCH: {"b" * 40: rec()}}, {}):
            with self.subTest(store=store):
                self.assertEqual(self.py_result(store), self.node_result(store))


if __name__ == "__main__":
    unittest.main()


class TestEndToEnd(unittest.TestCase):
    """The real merge route on a real repository, with the gate ON: refused without a record, merged with a chat record for the exact head."""

    def setUp(self):
        from test_git_merge_closes_task_log import make_repo_with_task_log_branch
        self.task_id = "gate-e2e-1"
        self.branch = f"agent/{self.task_id}"
        self.repo, self.bare = make_repo_with_task_log_branch(self.branch, self.task_id)
        self.client = app.app.test_client()
        for p in (mock.patch.object(app, "_sync_live_checkout", return_value={"synced": False}), mock.patch.object(app, "get_active_repo_root", return_value=str(self.repo)),
                  mock.patch.object(app, "_acquire_apply_lock", return_value=None), mock.patch.object(app, "_release_apply_lock"),  # the live pipeline may hold the real lock
                  mock.patch.object(app, "get_pipeline_dir", return_value=self.repo), mock.patch.object(app, "queue_dir", return_value=self.repo / "queue"),
                  mock.patch.dict(os.environ, {"AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH": ""})):
            p.start()
            self.addCleanup(p.stop)
        app._invalidate_branch_cache()

    def head(self):
        return subprocess.run(["git", "rev-parse", f"origin/{self.branch}"], cwd=str(self.repo), capture_output=True, text=True, check=True).stdout.strip()

    def main_tip(self):
        return subprocess.run(["git", "rev-parse", "main"], cwd=str(self.bare), capture_output=True, text=True, check=True).stdout.strip()

    def test_refused_without_a_record_and_main_is_untouched(self):
        before = self.main_tip()
        res = self.client.post(f"/api/git/branches/agent%2F{self.task_id}/merge")
        self.assertEqual((res.status_code, res.get_json()["code"]), (409, "MAIN_PUSH_NOT_READY"))
        self.assertEqual(self.main_tip(), before)
        self.assertEqual(ledger(self.repo / "queue")[0]["headSha"], self.head())

    def test_merged_with_a_chat_record_for_the_exact_head(self):
        before = self.main_tip()
        (self.repo / "queue").mkdir(exist_ok=True)
        (self.repo / "queue" / "branch-verdicts.json").write_text(json.dumps({self.branch: {self.head(): rec()}}))
        res = self.client.post(f"/api/git/branches/agent%2F{self.task_id}/merge")
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertTrue(res.get_json()["succeeded"])
        self.assertNotEqual(self.main_tip(), before)
        self.assertEqual(ledger(self.repo / "queue"), [])
