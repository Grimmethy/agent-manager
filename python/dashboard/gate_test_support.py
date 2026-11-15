"""Test helpers for the main-push gate (test_main_push_gate.py) and for the merge-route tests that must not be gated.

`client(testcase)` is a Flask test client with the gate bypassed (the gate's one documented switch, AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true, for the
length of the test case): the merge-route tests exercise the routes with fake branches, and the gate has its own tests.
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import app
import main_push_gate as gate

SHA = "a" * 40
NOW = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)
BRANCH = "agent/adhoc-gate-probe-1790000000000"


def client(testcase):
    env = mock.patch.dict("os.environ", {"AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH": "true"})
    env.start()
    testcase.addCleanup(env.stop)
    return app.app.test_client()


def rec(**over):
    return {"verdict": "merge", "reasons": ["ok"], "source": "chat", "verifiedAt": "2026-11-10T11:00:00Z", **over}


def make_queue(store=None):
    qdir = Path(tempfile.mkdtemp(prefix="main-push-gate-"))
    if store is not None:
        (qdir / "branch-verdicts.json").write_text(json.dumps(store))
    return qdir


def ledger(qdir):
    f = qdir / gate.LEDGER_FILE
    return [json.loads(line) for line in f.read_text().splitlines()] if f.exists() else []


def env_without_bypass():
    return mock.patch.dict(os.environ, {"AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH": "", "AGENT_MANAGER_MAIN_PUSH_READY_MAX_AGE_HOURS": ""})


class EdgeBase(unittest.TestCase):
    """A Flask test client whose git calls and active repository are faked; `self.head` is what `git rev-parse origin/<branch>` answers."""

    def setUp(self):
        self.client = app.app.test_client()
        self.qdir = make_queue()
        self.git_calls = []
        self.head = SHA
        for p in (mock.patch.object(app, "get_active_repo_root", return_value="/tmp/active-repo"), mock.patch.object(app, "queue_dir", return_value=self.qdir),
                  mock.patch.object(app, "_run_git", side_effect=self.fake_git), mock.patch.dict(os.environ, {"AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH": ""})):
            p.start()
            self.addCleanup(p.stop)

    def fake_git(self, args, cwd, timeout=30):
        self.git_calls.append(list(args))
        if args[0] == "rev-parse":
            if self.head is None:
                raise RuntimeError("git rev-parse failed: unknown revision")
            return self.head + "\n"
        return ""

    def record(self, store):
        (self.qdir / "branch-verdicts.json").write_text(json.dumps(store))

    def post(self, path, json=None):
        with mock.patch.object(app, "list_unmerged_branches", return_value=[]) as listing:
            resp = self.client.post(path, json=json or {})
        return resp, listing
