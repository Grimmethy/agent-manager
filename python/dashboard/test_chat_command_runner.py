"""chat_command_runner (the restricted host-side runner for Chat's owner-approved write commands) and its internal route.

Run: .venv/bin/python -m unittest python.dashboard.test_chat_command_runner -v   (or from python/dashboard: python -m unittest test_chat_command_runner)
Every command that runs here is a harmless `python -c` in a temp directory; nothing touches the live pipeline.
"""
import json
import os
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import chat_command_runner as runner  # noqa: E402

PY = sys.executable


def now_iso(delta_seconds=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_seconds)).isoformat()


class RunnerBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.repo = root / "repo"
        self.repo.mkdir()
        self.audit = root / "audit.jsonl"
        self.pipeline = root / "pipeline"
        (self.pipeline / "queue").mkdir(parents=True)
        self.counter = 0

    def entry(self, code, **extra):
        return {"repo": str(self.repo), "argv": [PY, "-c", code], **extra}

    def allow(self, *entries):
        path = Path(self.tmp.name) / "allowlist.json"
        path.write_text(json.dumps({"commands": list(entries)}), encoding="utf-8")
        return path

    def run_it(self, code, entries=None, argv=None, **kw):
        self.counter += 1
        allowlist = self.allow(*(entries if entries is not None else [self.entry(code)]))
        return runner.run_approved(
            argv if argv is not None else [PY, "-c", code], kw.pop("repo", str(self.repo)), kw.pop("proposal_id", f"p-{self.counter}"),
            kw.pop("confirmed_at", now_iso()), "s-1", allowlist=allowlist, pipeline_dir=self.pipeline, audit=self.audit, **kw,
        )

    def audit_lines(self):
        return [json.loads(line) for line in self.audit.read_text(encoding="utf-8").splitlines()] if self.audit.exists() else []


class AllowedRunTest(RunnerBase):
    def test_an_allowlisted_command_runs_and_reports_output_exit_code_and_duration(self):
        out = self.run_it("print('hello')")
        self.assertTrue(out["ok"])
        self.assertEqual((out["exitCode"], out["stdout"].strip(), out["stderr"]), (0, "hello", ""))
        self.assertIsInstance(out["durationMs"], int)
        line = self.audit_lines()[-1]
        self.assertEqual((line["outcome"], line["exitCode"], line["proposalId"], line["sessionId"]), ("ran", 0, "p-1", "s-1"))
        self.assertNotIn("stdout", line, "the audit log never holds output")

    def test_a_failing_command_reports_its_exit_code_and_stderr(self):
        out = self.run_it("import sys; sys.stderr.write('boom'); sys.exit(3)")
        self.assertFalse(out["ok"])
        self.assertEqual((out["exitCode"], out["stderr"]), (3, "boom"))

    def test_cwd_is_the_repo_realpath_and_there_is_no_shell(self):
        out = self.run_it("import os; print(os.getcwd())")
        self.assertEqual(out["stdout"].strip(), os.path.realpath(str(self.repo)))
        tricky = [PY, "-c", "import sys; print(sys.argv[1:])", "a;b", "$(id)", "*"]
        out = self.run_it("", entries=[{"repo": str(self.repo), "argv": tricky}], argv=tricky)
        self.assertEqual(out["stdout"].strip(), "['a;b', '$(id)', '*']", "metacharacters reach the program as plain arguments")

    def test_environment_is_a_minimal_base_plus_only_the_entrys_env(self):
        code = "import os; print(sorted(k for k in os.environ if k in ('PARENT_ONLY', 'FROM_ENTRY', 'PATH', 'HOME')))"
        with mock.patch.dict(os.environ, {"PARENT_ONLY": "x"}):
            out = self.run_it(code, entries=[self.entry(code, env={"FROM_ENTRY": "1"})])
        self.assertIn("'FROM_ENTRY'", out["stdout"])
        self.assertNotIn("PARENT_ONLY", out["stdout"])
        self.assertIn("'PATH'", out["stdout"])

    def test_output_is_capped(self):
        out = self.run_it("print('x' * 30000)")
        self.assertLessEqual(len(out["stdout"]), runner.MAX_OUTPUT_CHARS + 80)
        self.assertIn("truncated", out["stdout"])

    def test_a_timeout_kills_the_command_and_its_children(self):
        code = "import subprocess, sys, time; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']); time.sleep(30)"
        out = self.run_it(code, entries=[self.entry(code, timeoutSeconds=1)])
        self.assertFalse(out["ok"])
        self.assertIsNone(out["exitCode"])
        self.assertIn("timed out after 1 seconds", out["stderr"])
        self.assertLess(out["durationMs"], 10000)
        self.assertTrue(self.audit_lines()[-1].get("timedOut"))


class RefusalTest(RunnerBase):
    def refused(self, out, fragment):
        self.assertFalse(out["ok"])
        self.assertIn(fragment, out["refused"])
        self.assertTrue(self.audit_lines()[-1]["outcome"].startswith("refused"))

    def test_argv_must_equal_an_entry_exactly(self):
        entry = self.entry("print(1)")
        self.refused(self.run_it("", entries=[entry], argv=entry["argv"] + ["extra"]), "not on the allowlist")
        self.refused(self.run_it("", entries=[entry], argv=entry["argv"][:2]), "not on the allowlist")
        self.refused(self.run_it("", entries=[entry], argv=[PY, "-c", "print(1) "]), "not on the allowlist")
        self.refused(self.run_it("", entries=[entry], argv="python -c 'print(1)'"), "not on the allowlist")

    def test_the_repo_must_match_the_entrys_repo(self):
        other = Path(self.tmp.name) / "other"
        other.mkdir()
        self.refused(self.run_it("print(1)", repo=str(other)), "not on the allowlist")

    def test_a_repo_given_through_a_symlink_matches_by_realpath(self):
        link = Path(self.tmp.name) / "link"
        link.symlink_to(self.repo)
        self.assertTrue(self.run_it("print(1)", repo=str(link))["ok"])

    def test_missing_malformed_or_invalid_allowlists_allow_nothing(self):
        argv = [PY, "-c", "print(1)"]
        path = Path(self.tmp.name) / "bad.json"
        for content in (None, "{not json", "[]", json.dumps({"commands": "x"}), json.dumps({"commands": [{"repo": str(self.repo), "argv": []}]}),
                        json.dumps({"commands": [{"repo": "relative", "argv": argv}]}), json.dumps({"commands": [{"repo": str(self.repo), "argv": [1, 2]}]}),
                        json.dumps({"commands": [{"repo": str(self.repo), "argv": argv, "env": {"A": 1}}]}),
                        json.dumps({"commands": [{"repo": str(self.repo), "argv": argv, "timeoutSeconds": "9"}]})):
            if content is None:
                path.unlink(missing_ok=True)
            else:
                path.write_text(content, encoding="utf-8")
            out = runner.run_approved(argv, str(self.repo), "p-x", now_iso(), allowlist=path, pipeline_dir=self.pipeline, audit=self.audit)
            self.assertFalse(out["ok"], content)
            self.assertIn("not on the allowlist", out["refused"])

    def test_the_kill_switch_refuses_everything(self):
        (self.pipeline / "queue" / ".chat-write-tools-disabled").write_text("")
        self.refused(self.run_it("print(1)"), "kill switch")

    def test_proposal_id_and_a_fresh_confirmation_are_required(self):
        self.refused(self.run_it("print(1)", proposal_id=""), "proposalId is required")
        self.refused(self.run_it("print(1)", proposal_id=None), "proposalId is required")
        self.refused(self.run_it("print(1)", confirmed_at=None), "confirmedAt is required")
        self.refused(self.run_it("print(1)", confirmed_at="yesterday-ish"), "confirmedAt is required")
        self.refused(self.run_it("print(1)", confirmed_at=now_iso(-runner.CONFIRM_MAX_AGE_S - 60)), "stale")
        self.refused(self.run_it("print(1)", confirmed_at=now_iso(+3600)), "stale or from the future")

    def test_a_proposal_runs_at_most_once(self):
        self.assertTrue(self.run_it("print(1)", proposal_id="once")["ok"])
        self.refused(self.run_it("print(1)", proposal_id="once"), "already been run")

    def test_only_one_command_runs_at_a_time(self):
        self.assertTrue(runner._run_lock.acquire(blocking=False))
        try:
            self.refused(self.run_it("print(1)"), "another chat command is running")
        finally:
            runner._run_lock.release()
        self.assertTrue(self.run_it("print(1)")["ok"], "the lock is free again afterwards")

    def test_a_missing_repo_directory_or_program_is_a_refusal_not_a_crash(self):
        gone = Path(self.tmp.name) / "gone"
        entry = {"repo": str(gone), "argv": [PY, "-c", "print(1)"]}
        self.refused(self.run_it("", entries=[entry], argv=entry["argv"], repo=str(gone)), "repo directory does not exist")
        entry = {"repo": str(self.repo), "argv": ["/no/such/program-xyz"]}
        out = self.run_it("", entries=[entry], argv=entry["argv"])
        self.assertFalse(out["ok"])
        self.assertIn("could not be started", out["refused"])

    def test_timeouts_are_clamped_to_the_maximum_and_defaulted(self):
        path = self.allow(self.entry("1", timeoutSeconds=100000), self.entry("2"))
        loaded = runner.load_allowlist(path)
        self.assertEqual(loaded[0]["timeoutSeconds"], runner.MAX_TIMEOUT_S)
        self.assertEqual(loaded[1]["timeoutSeconds"], runner.DEFAULT_TIMEOUT_S)


class InternalRouteTest(RunnerBase):
    def setUp(self):
        super().setUp()
        import app
        self.client = app.app.test_client()
        env = mock.patch.dict(os.environ, {"AGENT_MANAGER_INTERNAL_TOKEN": "tok", "AGENT_MANAGER_CHAT_COMMAND_ALLOWLIST_PATH": str(self.allow(self.entry("print('via route')"))),
                                           "AGENT_MANAGER_CHAT_COMMAND_AUDIT_PATH": str(self.audit)})
        env.start()
        self.addCleanup(env.stop)
        patch = mock.patch("app.get_pipeline_dir", return_value=self.pipeline)
        patch.start()
        self.addCleanup(patch.stop)

    def post(self, body, token="tok"):
        return self.client.post("/api/internal/chat/run-command", json=body, headers={"X-Internal-Token": token} if token else {})

    def test_the_route_needs_the_internal_token(self):
        self.assertEqual(self.post({}, token=None).status_code, 403)
        self.assertEqual(self.post({}, token="wrong").status_code, 403)

    def test_the_route_runs_an_allowlisted_confirmed_command_and_refuses_with_200_otherwise(self):
        body = {"argv": [PY, "-c", "print('via route')"], "repo": str(self.repo), "proposalId": "r-1", "confirmedAt": now_iso(), "sessionId": "s-9"}
        reply = self.post(body)
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(reply.get_json()["stdout"].strip(), "via route")
        refused = self.post({**body, "proposalId": "r-2", "argv": [PY, "-c", "print('other')"]})
        self.assertEqual(refused.status_code, 200)
        self.assertFalse(refused.get_json()["ok"])
        self.assertIn("allowlist", refused.get_json()["refused"])
        self.assertEqual(self.post({}).get_json()["ok"], False)


if __name__ == "__main__":
    unittest.main()
