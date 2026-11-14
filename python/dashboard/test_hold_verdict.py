"""The 'hold' verdict: a sound piece waiting on its hub or a sibling, distinct from needs-work (2026-10-31).

Covers the store, the POST endpoint, the redraft hand-off (hold must not feed one), a stored legacy file, and discard_stats.py counting hold in its own column.

Run: .venv/bin/python -m unittest python.dashboard.test_hold_verdict -v
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import branch_verdicts as bv  # noqa: E402

STATS = HERE.parent.parent / "docs" / "agents" / "skills" / "verify-unmerged-branches" / "scripts" / "discard_stats.py"


class TestStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)

    def test_hold_is_a_valid_verdict_and_reads_back(self):
        self.assertIsNone(bv.validate_verdict_body("hold", ["hub HUB0017 is 2/5"], "chat"))
        bv.record_verdict(self.q, "agent/a", "sha1", "hold", ["hub HUB0017 is 2/5"], "chat")
        got = bv.get_verdict(self.q, "agent/a", "sha1")
        self.assertEqual((got["verdict"], got["stale"], got["reasons"]), ("hold", False, ["hub HUB0017 is 2/5"]))

    def test_an_unknown_verdict_is_still_refused_and_the_message_lists_hold(self):
        err = bv.validate_verdict_body("ship-it", [], "chat")
        self.assertIn("hold", err)
        self.assertIn("needs-work", err)

    def test_a_stored_needs_work_verdict_reads_back_unchanged(self):
        (self.q / bv.STORE_NAME).write_text(json.dumps({"agent/old": {"sha9": {"verdict": "needs-work", "reasons": ["r"], "source": "chat", "verifiedAt": "2026-10-01T00:00:00Z"}}}))
        got = bv.get_verdict(self.q, "agent/old", "sha9")
        self.assertEqual((got["verdict"], got["reasons"], got["source"]), ("needs-work", ["r"], "chat"))

    def test_a_deterministic_check_never_overwrites_a_chat_hold(self):
        bv.record_verdict(self.q, "agent/a", "s", "hold", ["waiting"], "chat")
        rec, written = bv.record_verdict(self.q, "agent/a", "s", "needs-work", ["conflicts"], "deterministic")
        self.assertFalse(written)
        self.assertEqual(rec["verdict"], "hold")

    def test_the_verdict_set_is_exactly_four(self):
        self.assertEqual(bv.VERDICTS, ("merge", "needs-work", "hold", "discard"))


class TestRedraftHandOff(unittest.TestCase):
    def test_hold_does_not_stamp_a_prior_verdict(self):
        rec = {"promptContext": {}}
        self.assertFalse(bv.apply_prior_verdict(rec, "agent/a", "hold", ["waiting"], "chat", "sha"))
        self.assertNotIn("priorVerdict", rec["promptContext"])

    def test_hold_leaves_an_existing_prior_verdict_alone(self):
        rec = {"promptContext": {"priorVerdict": {"verdict": "needs-work", "reasons": ["defect"]}}}
        self.assertFalse(bv.apply_prior_verdict(rec, "agent/a", "hold", ["waiting"], "chat", "sha"))
        self.assertEqual(rec["promptContext"]["priorVerdict"]["verdict"], "needs-work")

    def test_needs_work_still_stamps_it(self):
        rec = {"promptContext": {}}
        self.assertTrue(bv.apply_prior_verdict(rec, "agent/a", "needs-work", ["defect"], "chat", "sha"))
        self.assertEqual(rec["promptContext"]["priorVerdict"]["verdict"], "needs-work")


class TestEndpoint(unittest.TestCase):
    """Same harness as test_branch_verdict_endpoint.Endpoint: the real Flask app, git-backed lookups stubbed, temp store."""

    def setUp(self):
        import app  # noqa: WPS433
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)
        self.client = app.app.test_client()
        branch = {"branch": "agent/t1", "taskId": "t1", "headSha": "sha-A", "hub": None}
        for p in (mock.patch.object(app, "get_active_repo_root", return_value="/repo"),
                  mock.patch.object(app, "queue_dir", return_value=self.q),
                  mock.patch.object(app, "list_unmerged_branches", return_value=[branch]),
                  mock.patch.object(app, "_invalidate_branch_cache")):
            p.start()
            self.addCleanup(p.stop)

    def post(self, body):
        return self.client.post("/api/git/branches/agent/t1/verdict", json=body)

    def test_a_hold_is_recorded_and_read_back(self):
        r = self.post({"verdict": "hold", "reasons": ["hub 2/5"], "source": "chat"})
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual((body["succeeded"], body["verdict"], body["stale"]), (True, "hold", False))
        self.assertEqual(bv.get_verdict(self.q, "agent/t1", "sha-A")["verdict"], "hold")

    def test_a_bad_verdict_is_400_and_records_nothing(self):
        self.assertEqual(self.post({"verdict": "wait", "reasons": [], "source": "chat"}).status_code, 400)
        self.assertEqual(bv.load_verdicts(self.q), {})

    def test_a_moved_head_is_409_for_a_hold_too(self):
        r = self.post({"verdict": "hold", "reasons": ["x"], "source": "chat", "sha": "sha-OLD"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(bv.load_verdicts(self.q), {})


class TestDiscardStatsCountsHoldSeparately(unittest.TestCase):
    def _run(self, root, *argv):
        import importlib.util
        import io
        from contextlib import redirect_stdout
        spec = importlib.util.spec_from_file_location("discard_stats_under_test", STATS)
        ds = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ds)
        ds.CORE = str(Path(root) / "no-core-pipeline")  # the script always reads the live core pipeline too; keep the test hermetic
        buf = io.StringIO()
        with mock.patch.object(sys, "argv", ["discard_stats.py", "--root", root, *argv]), redirect_stdout(buf):
            ds.main()
        return buf.getvalue()

    def test_hold_has_its_own_column_and_needs_work_is_not_inflated(self):
        with tempfile.TemporaryDirectory() as root:
            q = Path(root) / "demo-pipeline" / "queue"
            q.mkdir(parents=True)
            rec = lambda v: {"s": {"verdict": v, "reasons": ["r"], "source": "chat", "verifiedAt": "2026-10-31T00:00:00Z"}}
            (q / "branch-verdicts.json").write_text(json.dumps({
                "agent/adhoc-one": rec("merge"), "agent/adhoc-two": rec("needs-work"),
                "agent/adhoc-three": rec("hold"), "agent/adhoc-four": rec("hold"),
            }))
            fam = json.loads(self._run(root, "--json"))["families"]["other adhoc"]
            self.assertEqual(fam["n"], 4)
            self.assertEqual((fam["merge"], fam["needs-work"], fam["hold"], fam["discard"]), (0.25, 0.25, 0.5, 0.0))
            text = self._run(root)
            self.assertIn("hold=50%", text)
            self.assertIn("needs-work=25%", text)


if __name__ == "__main__":
    unittest.main()
