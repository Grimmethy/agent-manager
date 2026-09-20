"""Hub progress shows BUILT pieces, not just merged ones (2026-09-20 gripe).

A hub is now one stacked chain that lands as ONE final merge, so a finished piece is `pending-merge` until then. The dashboard counted only
merged/closed pieces, so a hub read "0/3 done" for its whole life and never "ready to merge". `progress.done` is still merged/closed;
`progress.built` adds finished-but-awaiting-merge; readyToMerge = every piece built (+ integration gate clear). The phase per piece comes from
coordinator-sweep.js childPhase() -- the dashboard no longer keeps its own status set.

Run: .venv/bin/python -m unittest python.dashboard.test_hub_summary -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


def hub(subs, **extra):
    return {"id": "hub-1", "title": "T", "subTasks": subs, **extra}


class TestSummarizeHub(unittest.TestCase):
    def test_built_pieces_count_as_progress_and_merged_ones_as_done(self):
        h = app._summarize_hub(hub([
            {"id": "a", "status": "merged", "phase": "merged"},
            {"id": "b", "status": "pending-merge", "phase": "built"},
            {"id": "c", "status": "in-progress", "phase": "open"},
        ]), "coordinating")
        self.assertEqual(h["progress"], {"done": 1, "built": 2, "total": 3})
        self.assertEqual([s["phase"] for s in h["subTasks"]], ["merged", "built", "open"])
        self.assertFalse(h["readyToMerge"], "one piece is still open")

    def test_every_piece_built_and_none_merged_reads_ready_to_merge_not_zero_done(self):
        h = app._summarize_hub(hub([
            {"id": "a", "status": "pending-merge", "phase": "built"},
            {"id": "b", "status": "pending-merge", "phase": "built"},
            {"id": "c", "status": "pending-merge", "phase": "built"},
        ]), "coordinating")
        self.assertEqual(h["progress"], {"done": 0, "built": 3, "total": 3})
        self.assertTrue(h["readyToMerge"])

    def test_integration_gate_still_has_to_be_clear(self):
        subs = [{"id": "a", "status": "pending-merge", "phase": "built"}, {"id": "b", "status": "pending-merge", "phase": "built"}]
        for status, ready in ((None, True), ("passed", True), ("skipped", True), ("pending", False), ("failed", False)):
            h = app._summarize_hub(hub(subs, integrationGate={"status": status} if status else {}), "coordinating")
            self.assertEqual(h["readyToMerge"], ready, status)

    def test_a_hub_already_in_done_is_ready_and_an_empty_hub_is_not(self):
        self.assertTrue(app._summarize_hub(hub([{"id": "a", "status": "merged", "phase": "merged"}]), "done")["readyToMerge"])
        self.assertFalse(app._summarize_hub(hub([]), "coordinating")["readyToMerge"])
        self.assertEqual(app._summarize_hub(hub([]), "coordinating")["progress"], {"done": 0, "built": 0, "total": 0})

    def test_a_record_the_coordinator_has_not_re_swept_yet_falls_back_by_status_and_agrees_with_it(self):
        """No `phase` on the pieces (older record): same answer, derived from status -- incl. the closes the old dashboard set forgot."""
        h = app._summarize_hub(hub([
            {"id": "a", "status": "noop"}, {"id": "b", "status": "dismissed"}, {"id": "c", "status": "superseded"},
            {"id": "d", "status": "pending-merge"}, {"id": "e", "status": "blocked"},
        ]), "coordinating")
        self.assertEqual([s["phase"] for s in h["subTasks"]], ["merged", "merged", "merged", "built", "open"])
        self.assertEqual(h["progress"], {"done": 3, "built": 4, "total": 5})

    def test_the_fallback_agrees_with_the_coordinators_definition_for_every_terminal_status(self):
        """Drift guard: node's childPhase() over TERMINAL_GOOD + pending-merge must equal this module's fallback."""
        import json
        import subprocess
        core = Path(app.__file__).resolve().parent.parent.parent
        script = (
            "const {childPhase,TERMINAL_GOOD}=require('./src/coordinator-sweep.js');"
            "const all=[...TERMINAL_GOOD,'pending-merge','in-progress','pending','blocked','needs-clarification','awaiting-confirm'];"
            "process.stdout.write(JSON.stringify(Object.fromEntries(all.map(s=>[s,childPhase(s)]))))"
        )
        out = subprocess.run(["node", "-e", script], cwd=str(core), capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr[-300:])
        for status, phase in json.loads(out.stdout).items():
            self.assertEqual(app._hub_child_phase({"status": status}), phase, status)


if __name__ == "__main__":
    unittest.main()
