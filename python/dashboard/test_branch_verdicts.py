"""Tests for branch_verdicts.py (Unmerged Branches verdicts) against a FIXTURE git repo -- real git, no mocks
of the checks. A bare 'origin' plus a clone gives real origin/<branch> refs, which is what the checks read.

Run: python -m unittest python.dashboard.test_branch_verdicts -v   (from the repo root)
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import branch_verdicts as bv  # noqa: E402


def git(args, cwd):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=str(cwd), check=True,
                          capture_output=True, text=True).stdout


def run_git(args, cwd):
    """Same contract as app.py's _run_git: raises RuntimeError with the output on a nonzero exit."""
    proc = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {(proc.stderr or proc.stdout).strip()}")
    return proc.stdout


class Fixture:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.origin, self.work, self.queue = root / "origin.git", root / "work", root / "queue"
        self.queue.mkdir()
        git(["init", "--bare", "-b", "master", str(self.origin)], root)
        git(["clone", str(self.origin), str(self.work)], root)
        git(["checkout", "-b", "master"], self.work)
        self.write("shared.txt", "line1\nline2\nline3\n")
        self.write("cands.md", "### AC-1\n")
        self.commit("base")
        git(["push", "origin", "master"], self.work)

    def write(self, name, text):
        (self.work / name).write_text(text)

    def commit(self, msg):
        git(["add", "-A"], self.work)
        git(["commit", "-m", msg], self.work)

    def branch_from_master(self, name):
        git(["checkout", "-B", name, "master"], self.work)

    def push(self, name):
        git(["push", "-f", "origin", name], self.work)
        git(["checkout", "master"], self.work)

    def sha(self, name):
        return git(["rev-parse", f"origin/{name}"], self.work).strip()

    def cleanup(self):
        self.tmp.cleanup()


class DeterministicChecks(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.cleanup)

    def check(self, branch):
        git(["fetch", "origin", "--prune"], self.fx.work)
        return bv.run_deterministic_checks(self.fx.work, "master", branch, run_git)

    def test_already_on_master_via_different_sha_is_discard(self):
        self.fx.branch_from_master("agent/dup")
        self.fx.write("feature.txt", "new feature\n")
        self.fx.commit("add feature")
        self.fx.push("agent/dup")
        # Land the same patch on master under a different SHA (cherry-pick keeps the patch-id).
        git(["cherry-pick", "origin/agent/dup"], self.fx.work)
        git(["commit", "--amend", "-m", "landed by hand"], self.fx.work)
        git(["push", "origin", "master"], self.fx.work)
        verdict, reasons = self.check("agent/dup")
        self.assertEqual(verdict, "discard")
        self.assertIn("already on master (patch-id match)", reasons)
        self.assertEqual(len(reasons), 1, "the reverse-apply sanity check should confirm, not warn")

    def test_redundant_rescued_snapshot_is_discard(self):
        self.fx.branch_from_master("agent/triage-queue")
        self.fx.write("cands.md", "### AC-1\n### AC-2\n### AC-3\n")
        self.fx.commit("triage batch")
        self.fx.push("agent/triage-queue")
        self.fx.branch_from_master("agent/triage-queue-rescued-20260925")
        self.fx.write("cands.md", "### AC-1\n### AC-2\n")
        self.fx.commit("rescued snapshot")
        self.fx.push("agent/triage-queue-rescued-20260925")
        verdict, reasons = self.check("agent/triage-queue-rescued-20260925")
        self.assertEqual(verdict, "discard")
        self.assertEqual(reasons, ["snapshot of agent/triage-queue, zero unique lines"])

    def test_rescued_snapshot_with_a_unique_line_is_not_discarded(self):
        self.fx.branch_from_master("agent/triage-queue")
        self.fx.write("cands.md", "### AC-1\n### AC-2\n")
        self.fx.commit("triage batch")
        self.fx.push("agent/triage-queue")
        self.fx.branch_from_master("agent/triage-queue-rescued-x")
        self.fx.write("cands.md", "### AC-1\n### AC-99 only here\n")
        self.fx.commit("rescued snapshot with a unique candidate")
        self.fx.push("agent/triage-queue-rescued-x")
        verdict, _ = self.check("agent/triage-queue-rescued-x")
        self.assertNotEqual(verdict, "discard")

    def test_conflict_is_needs_work_and_names_the_files(self):
        self.fx.branch_from_master("agent/conflicting")
        self.fx.write("shared.txt", "line1\nBRANCH\nline3\n")
        self.fx.commit("branch edit")
        self.fx.push("agent/conflicting")
        self.fx.write("shared.txt", "line1\nMASTER\nline3\n")
        self.fx.commit("master edit")
        git(["push", "origin", "master"], self.fx.work)
        verdict, reasons = self.check("agent/conflicting")
        self.assertEqual(verdict, "needs-work")
        self.assertIn("shared.txt", reasons[0])

    def test_genuinely_unique_clean_branch_stays_grey_and_never_merge(self):
        self.fx.branch_from_master("agent/unique")
        self.fx.write("brand-new.txt", "only on this branch\n")
        self.fx.commit("unique work")
        self.fx.push("agent/unique")
        verdict, reasons = self.check("agent/unique")
        self.assertIsNone(verdict)
        self.assertEqual(reasons, [])

    def test_extra_warnings_turn_a_quiet_branch_yellow_but_never_green(self):
        self.fx.branch_from_master("agent/unique2")
        self.fx.write("n.txt", "x\n")
        self.fx.commit("work")
        self.fx.push("agent/unique2")
        git(["fetch", "origin", "--prune"], self.fx.work)
        verdict, reasons = bv.run_deterministic_checks(self.fx.work, "master", "agent/unique2", run_git, ["stale vs master: 60 commits behind"])
        self.assertEqual(verdict, "needs-work")
        self.assertEqual(reasons, ["stale vs master: 60 commits behind"])


class StoreAndStaleness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)

    def test_round_trip(self):
        bv.record_verdict(self.q, "agent/x", "sha1", "merge", ["reviewed"], "manual")
        v = bv.get_verdict(self.q, "agent/x", "sha1")
        self.assertEqual((v["verdict"], v["reasons"], v["source"], v["stale"]), ("merge", ["reviewed"], "manual", False))
        self.assertTrue(v["verifiedAt"])

    def test_verdict_for_an_older_sha_reads_back_stale_and_unverified(self):
        bv.record_verdict(self.q, "agent/x", "old", "merge", ["reviewed"], "chat")
        v = bv.get_verdict(self.q, "agent/x", "new")
        self.assertIsNone(v["verdict"])
        self.assertTrue(v["stale"])
        self.assertEqual(v["reasons"], ["verdict is for an older commit"])

    def test_no_verdict_is_plain_unverified(self):
        v = bv.get_verdict(self.q, "agent/none", "s")
        self.assertEqual((v["verdict"], v["stale"]), (None, False))

    def test_bad_verdict_and_source_are_rejected(self):
        with self.assertRaises(ValueError):
            bv.record_verdict(self.q, "agent/x", "s", "ship-it", [], "manual")
        with self.assertRaises(ValueError):
            bv.record_verdict(self.q, "agent/x", "s", "merge", [], "vibes")
        with self.assertRaises(ValueError):
            bv.record_verdict(self.q, "agent/x", "s", "merge", "not-a-list", "manual")

    def test_deterministic_never_overwrites_chat_or_manual_for_the_same_sha(self):
        bv.record_verdict(self.q, "agent/x", "s", "merge", ["human said so"], "manual")
        rec, written = bv.record_verdict(self.q, "agent/x", "s", "discard", ["cherry"], "deterministic")
        self.assertFalse(written)
        self.assertEqual(bv.get_verdict(self.q, "agent/x", "s")["verdict"], "merge")

    def test_manual_does_overwrite_deterministic(self):
        bv.record_verdict(self.q, "agent/x", "s", "discard", ["cherry"], "deterministic")
        bv.record_verdict(self.q, "agent/x", "s", "merge", ["actually fine"], "manual")
        self.assertEqual(bv.get_verdict(self.q, "agent/x", "s")["verdict"], "merge")

    def test_clear_only_removes_deterministic(self):
        bv.record_verdict(self.q, "agent/a", "s", "discard", [], "deterministic")
        bv.record_verdict(self.q, "agent/b", "s", "merge", [], "chat")
        self.assertTrue(bv.clear_verdict(self.q, "agent/a", "s"))
        self.assertFalse(bv.clear_verdict(self.q, "agent/b", "s"))
        self.assertEqual(bv.get_verdict(self.q, "agent/b", "s")["verdict"], "merge")

    def test_store_is_pruned_to_recent_shas(self):
        for i in range(bv._KEEP_SHAS + 3):
            bv.record_verdict(self.q, "agent/x", f"sha{i}", "needs-work", [], "manual")
        self.assertEqual(len(bv.load_verdicts(self.q)["agent/x"]), bv._KEEP_SHAS)

    def test_corrupt_store_reads_as_empty(self):
        (self.q / bv.STORE_NAME).write_text("{not json")
        self.assertEqual(bv.load_verdicts(self.q), {})


class TaskLog(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)
        for d in ("done", "coordinating"):
            (self.q / d).mkdir()

    def test_appends_history_event_in_appendHistoryEvent_shape_to_task_and_hub(self):
        (self.q / "done" / "t1.json").write_text(json.dumps({"id": "t1", "history": [{"stage": "x", "at": "a"}]}))
        (self.q / "coordinating" / "HUB1.json").write_text(json.dumps({"id": "HUB1"}))
        n = bv.write_task_log(self.q, "t1", "HUB1", "agent/t1", "discard", ["already on master (patch-id match)"], "deterministic")
        self.assertEqual(n, 2)
        t = json.loads((self.q / "done" / "t1.json").read_text())
        ev = t["history"][-1]
        self.assertEqual(set(ev), {"stage", "at", "detail"})
        self.assertEqual(ev["stage"], "branch-verdict")
        self.assertIn("discard", ev["detail"])
        self.assertIn("already on master", ev["detail"])
        self.assertEqual(len(t["history"]), 2)
        self.assertEqual(len(json.loads((self.q / "coordinating" / "HUB1.json").read_text())["history"]), 1)

    def test_no_owning_task_is_a_silent_noop(self):
        self.assertEqual(bv.write_task_log(self.q, "ghost", None, "agent/ghost", "merge", [], "manual"), 0)


class ResolveOwner(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.cleanup)

    def _branch_with_trailer(self, name, *trailers):
        self.fx.branch_from_master(name)
        self.fx.write("f.txt", "f\n")
        git(["add", "-A"], self.fx.work)
        msg = "work\n\n" + "\n".join(trailers)
        git(["commit", "-m", msg], self.fx.work)
        self.fx.push(name)
        git(["fetch", "origin", "--prune"], self.fx.work)

    def test_trailer_task_ids_are_read_from_the_branch_commits(self):
        self._branch_with_trailer("agent/decompose-x", "Task: HUB0001-02-real-id (adhoc/manual)")
        ids, hub = bv.resolve_owner(self.fx.work, "master", "agent/decompose-x", run_git, self.fx.queue, None, "decompose-x")
        self.assertEqual(ids, ["HUB0001-02-real-id", "decompose-x"])  # trailer first, branch-name fallback last
        self.assertIsNone(hub)

    def test_hub_comes_from_the_lookup_called_with_the_trailer_ids(self):
        self._branch_with_trailer("agent/decompose-x", "Task: HUB0001-02-real-id (adhoc/manual)")
        seen = {}

        def lookup(qdir, branch, ids):
            seen.update(qdir=qdir, branch=branch, ids=ids)
            return {"id": "the-hub"}
        ids, hub = bv.resolve_owner(self.fx.work, "master", "agent/decompose-x", run_git, self.fx.queue, lookup, "decompose-x")
        self.assertEqual(hub, "the-hub")
        self.assertEqual((seen["branch"], seen["ids"]), ("agent/decompose-x", ["HUB0001-02-real-id", "decompose-x"]))

    def test_a_failing_hub_lookup_or_git_log_yields_fewer_ids_never_an_exception(self):
        def boom(*a):
            raise RuntimeError("provider down")
        ids, hub = bv.resolve_owner(self.fx.work, "master", "agent/does-not-exist", run_git, self.fx.queue, boom, "fallback")
        self.assertEqual((ids, hub), (["fallback"], None))

    def test_write_task_log_accepts_a_list_dedupes_and_skips_missing(self):
        q = self.fx.queue
        (q / "done").mkdir()
        (q / "done" / "a.json").write_text(json.dumps({"id": "a"}))
        n = bv.write_task_log(q, ["a", "a", "missing"], "a", "agent/x", "merge", ["r"], "chat")
        self.assertEqual(n, 1)
        self.assertEqual(len(json.loads((q / "done" / "a.json").read_text())["history"]), 1)


class Enrich(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.cleanup)

    def test_enrich_marks_dup_discard_leaves_unique_grey_and_logs_once(self):
        fx = self.fx
        fx.branch_from_master("agent/dup")
        fx.write("f.txt", "f\n")
        fx.commit("f")
        fx.push("agent/dup")
        git(["cherry-pick", "origin/agent/dup"], fx.work)
        git(["commit", "--amend", "-m", "by hand"], fx.work)
        git(["push", "origin", "master"], fx.work)
        fx.branch_from_master("agent/unique")
        fx.write("u.txt", "u\n")
        fx.commit("u")
        fx.push("agent/unique")
        git(["fetch", "origin", "--prune"], fx.work)
        (fx.queue / "done").mkdir()
        (fx.queue / "done" / "dup.json").write_text(json.dumps({"id": "dup"}))
        branches = [{"branch": "agent/dup", "taskId": "dup", "mainBranch": "master", "behind": 1},
                    {"branch": "agent/unique", "taskId": "unique", "mainBranch": "master", "behind": 1}]
        bv.enrich_branches_with_verdicts(fx.queue, fx.work, branches, run_git)
        dup, uniq = branches
        self.assertEqual((dup["verdict"], dup["source"], dup["stale"]), ("discard", "deterministic", False))
        self.assertIsNone(uniq["verdict"])
        bv.enrich_branches_with_verdicts(fx.queue, fx.work, branches, run_git)  # second build: unchanged -> not re-logged
        history = json.loads((fx.queue / "done" / "dup.json").read_text())["history"]
        self.assertEqual(len(history), 1)

    def test_enrich_logs_on_the_trailer_task_and_hub_when_branch_name_differs_from_the_record(self):
        fx = self.fx
        fx.branch_from_master("agent/dup")
        fx.write("f.txt", "f\n")
        git(["add", "-A"], fx.work)
        git(["commit", "-m", "f\n\nTask: HUB0009-01-the-real-task (adhoc/manual)"], fx.work)
        fx.push("agent/dup")
        git(["cherry-pick", "origin/agent/dup"], fx.work)
        git(["commit", "--amend", "-m", "by hand"], fx.work)
        git(["push", "origin", "master"], fx.work)
        git(["fetch", "origin", "--prune"], fx.work)
        (fx.queue / "done").mkdir()
        (fx.queue / "coordinating").mkdir()
        (fx.queue / "done" / "HUB0009-01-the-real-task.json").write_text(json.dumps({"id": "HUB0009-01-the-real-task"}))
        (fx.queue / "coordinating" / "the-hub.json").write_text(json.dumps({"id": "the-hub"}))
        branches = [{"branch": "agent/dup", "taskId": "dup", "mainBranch": "master", "behind": 1}]
        bv.enrich_branches_with_verdicts(fx.queue, fx.work, branches, run_git, hub_lookup=lambda q, b, ids: {"id": "the-hub"})
        self.assertEqual(branches[0]["verdict"], "discard")
        for f in ("done/HUB0009-01-the-real-task.json", "coordinating/the-hub.json"):
            events = [h for h in json.loads((fx.queue / f).read_text()).get("history", []) if h["stage"] == "branch-verdict"]
            self.assertEqual(len(events), 1, f)

    def test_enrich_respects_a_manual_verdict_for_the_same_head(self):
        fx = self.fx
        fx.branch_from_master("agent/unique")
        fx.write("u.txt", "u\n")
        fx.commit("u")
        fx.push("agent/unique")
        git(["fetch", "origin", "--prune"], fx.work)
        bv.record_verdict(fx.queue, "agent/unique", fx.sha("agent/unique"), "merge", ["read it, fine"], "manual")
        b = [{"branch": "agent/unique", "taskId": "unique", "mainBranch": "master", "behind": 999}]  # would be yellow deterministically
        bv.enrich_branches_with_verdicts(fx.queue, fx.work, b, run_git)
        self.assertEqual((b[0]["verdict"], b[0]["source"]), ("merge", "manual"))

    def test_new_commit_makes_the_old_verdict_stale(self):
        fx = self.fx
        fx.branch_from_master("agent/unique")
        fx.write("u.txt", "u\n")
        fx.commit("u")
        fx.push("agent/unique")
        git(["fetch", "origin", "--prune"], fx.work)
        bv.record_verdict(fx.queue, "agent/unique", fx.sha("agent/unique"), "merge", ["read it"], "chat")
        fx.branch_from_master("agent/unique")
        fx.write("u.txt", "u\nmore\n")
        fx.commit("second commit")
        fx.push("agent/unique")
        git(["fetch", "origin", "--prune"], fx.work)
        b = [{"branch": "agent/unique", "taskId": "unique", "mainBranch": "master", "behind": 0}]
        bv.enrich_branches_with_verdicts(fx.queue, fx.work, b, run_git)
        self.assertIsNone(b[0]["verdict"])
        self.assertTrue(b[0]["stale"])
        self.assertEqual(b[0]["reasons"], ["verdict is for an older commit"])


if __name__ == "__main__":
    unittest.main()
