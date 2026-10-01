"""Tests for /api/task/<state>/<id>/requeue preserving coordination fields (2026-09-06,
real incident: a stacked file-decompose sub-task -- seq 2 of 5, sharing one branch with
its 4 siblings, see file-decompose-to-hub.js -- blocked on a sustained Ollama infra
outage. Its `stacked` field ({branch, seq, total}) is the ONLY thing tying it back to the
shared branch and its position in the sequence, but api_task_requeue's "fresh" rebuild
only ever carried over id/domain/source/title/promptContext -- a human clicking Requeue
on a stuck stacked sub-task would have silently detached it from its hub with no error and
no visible sign anything broke until the wiring step later found the branch incomplete.
`dependsOn` (also file-decompose-to-hub.js; consumed by nextAdhocTask's/coordinator-
sweep.js's dependency gate) is the identical shape.

Uses the same ENV_FILE_PATH-override + Flask test_client() pattern as
test_concepts_routes.py.

Run: .venv/bin/python -m unittest python.dashboard.test_requeue_preserves_coordination_fields -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class RequeuePreservesCoordinationFieldsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_env_path = app.ENV_FILE_PATH
        app.ENV_FILE_PATH = Path(self._tmp.name) / "agent-manager.env"
        self._saved = {k: os.environ.get(k) for k in
                       ("AGENT_MANAGER_REPO_ROOT", "AGENT_MANAGER_PIPELINE_DIR")}
        for k in self._saved:
            os.environ.pop(k, None)
        self.pipeline_dir = Path(self._tmp.name) / "pipeline"
        self.pipeline_dir.mkdir(parents=True, exist_ok=True)
        app.ENV_FILE_PATH.write_text(f"AGENT_MANAGER_PIPELINE_DIR={self.pipeline_dir}\n", encoding="utf-8")
        self.client = app.app.test_client()
        (self.pipeline_dir / "queue" / "blocked").mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        app.ENV_FILE_PATH = self._orig_env_path
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _write_blocked(self, task_id, data):
        p = self.pipeline_dir / "queue" / "blocked" / f"{task_id}.json"
        p.write_text(json.dumps(data), encoding="utf-8")
        return p

    def test_requeue_preserves_stacked_field(self):
        task_id = "adhoc-decompose-hub-x-02-tasks-and-branches-js"
        stacked = {"branch": "agent/decompose-hub-x", "seq": 2, "total": 5}
        self._write_blocked(task_id, {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "move stuff",
            "promptContext": {"newFile": "python/dashboard/static/js/x.js"},
            "stacked": stacked,
            "blockedReason": "Plan pass degenerate: empty",
            "draftAttempts": [{"attemptNo": 1}],
        })

        resp = self.client.post(f"/api/task/blocked/{task_id}/requeue")
        self.assertEqual(resp.status_code, 200)

        pending_path = self.pipeline_dir / "queue" / "pending" / f"{task_id}.json"
        self.assertTrue(pending_path.is_file(), "requeue must move the task into pending/")
        requeued = json.loads(pending_path.read_text(encoding="utf-8"))
        self.assertEqual(requeued.get("stacked"), stacked, "stacked must survive a manual requeue, not be silently dropped")
        # The reset still drops drafting artifacts -- this is a deliberate fresh start,
        # not a full-fidelity copy.
        self.assertNotIn("draftAttempts", requeued)
        self.assertNotIn("blockedReason", requeued)

    def test_requeue_preserves_dependsOn_field(self):
        task_id = "adhoc-decompose-hub-y-99-wiring"
        deps = ["adhoc-decompose-hub-y-01-a", "adhoc-decompose-hub-y-02-b"]
        self._write_blocked(task_id, {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "wire it up",
            "promptContext": {},
            "dependsOn": deps,
            "blockedReason": "some infra error",
        })

        resp = self.client.post(f"/api/task/blocked/{task_id}/requeue")
        self.assertEqual(resp.status_code, 200)

        requeued = json.loads((self.pipeline_dir / "queue" / "pending" / f"{task_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(requeued.get("dependsOn"), deps, "dependsOn must survive a manual requeue")

    def test_requeue_of_an_ordinary_task_never_adds_stacked_or_dependsOn(self):
        task_id = "adhoc-ordinary-task-1"
        self._write_blocked(task_id, {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "fix a bug",
            "promptContext": {"rawText": "fix it"},
            "blockedReason": "Plan pass degenerate: empty",
        })

        resp = self.client.post(f"/api/task/blocked/{task_id}/requeue")
        self.assertEqual(resp.status_code, 200)

        requeued = json.loads((self.pipeline_dir / "queue" / "pending" / f"{task_id}.json").read_text(encoding="utf-8"))
        self.assertNotIn("stacked", requeued, "a task that never carried stacked must not gain one")
        self.assertNotIn("dependsOn", requeued, "a task that never carried dependsOn must not gain one")

    # 2026-09-06, same requeue endpoint, a second real incident: `atomic` was STILL being
    # dropped even after the stacked/dependsOn fix above -- confirmed live, a requeued
    # file-decompose sub-task lost `atomic: true`, so local-draft.js's `!task.atomic`
    # pre-split guard ("a file-decompose child IS the output of a decomposition;
    # re-splitting it loops") no longer held, and the model tried to decompose it again.
    def test_requeue_preserves_atomic_and_noDecompose_fields(self):
        task_id = "adhoc-decompose-hub-z-02-tasks-and-branches-js"
        self._write_blocked(task_id, {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "move stuff",
            "promptContext": {"newFile": "python/dashboard/static/js/x.js"},
            "atomic": True,
            "noDecompose": True,
            "blockedReason": "Ollama infra outage",
        })

        resp = self.client.post(f"/api/task/blocked/{task_id}/requeue")
        self.assertEqual(resp.status_code, 200)

        requeued = json.loads((self.pipeline_dir / "queue" / "pending" / f"{task_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(requeued.get("atomic"), True, "atomic must survive a manual requeue -- it is what stops a file-decompose child re-splitting itself")
        self.assertEqual(requeued.get("noDecompose"), True, "noDecompose must survive a manual requeue")

    def test_requeue_of_an_ordinary_task_never_adds_atomic_or_noDecompose(self):
        task_id = "adhoc-ordinary-task-2"
        self._write_blocked(task_id, {
            "id": task_id, "domain": "adhoc", "source": "manual", "title": "fix a bug",
            "promptContext": {"rawText": "fix it"},
            "blockedReason": "Plan pass degenerate: empty",
        })

        resp = self.client.post(f"/api/task/blocked/{task_id}/requeue")
        self.assertEqual(resp.status_code, 200)

        requeued = json.loads((self.pipeline_dir / "queue" / "pending" / f"{task_id}.json").read_text(encoding="utf-8"))
        self.assertNotIn("atomic", requeued, "a task that never carried atomic must not gain one")
        self.assertNotIn("noDecompose", requeued, "a task that never carried noDecompose must not gain one")


    # 2026-09-17, arch_import requeue burn: archImportImplementPrompt (src/prompts.js)
    # now forbids naming any file outside the fact-check Real-matches list and tells the
    # model to respond with exactly "no real file to adapt" when no listed file fits.
    # src/local-draft.js must treat that stub as a TERMINAL SUCCESSFUL no-op (same shape
    # as the skipImplementWhenNoHarnessHits zero-hit block) so it never reaches
    # critique/requeue/re-draft -- the single largest avoidable cost in this window.
    # A stub that got flagged blocked/requeued would re-enter the exact requeue loop
    # this change exists to stop.
    def test_no_real_file_to_adapt_stub_is_terminal_noop_not_requeued(self):
        import re

        draft_js = (self.pipeline_dir.parent.parent / "src" / "local-draft.js").resolve()
        # The draft path may legitimately live one directory above this repo in an
        # in-place checkout; fall back to the file's own repo root either way.
        if not draft_js.is_file():
            draft_js = (Path(__file__).parent.parent.parent / "src" / "local-draft.js")
        text = draft_js.read_text(encoding="utf-8")

        # (a) The stub guard exists in the draft path.
        self.assertIn(
            "implementResponse.trim() === 'no real file to adapt'",
            text,
            "local-draft.js must special-case the 'no real file to adapt' stub",
        )
        # (b) It is a TERMINAL no-op: resolved successful/unblocked, exactly like the
        #     zero-hit skip, with no blockedReason attached.
        self.assertRegex(
            text,
            r"no real file to adapt.*?\{ succeeded: true, blocked: false \}",
            "the stub must resolve as { succeeded: true, blocked: false }, a terminal no-op",
        )
        self.assertNotRegex(
            text,
            r"no real file to adapt[^;]*blockedReason",
            "the stub must never be stamped with a blockedReason (that would feed the requeue loop)",
        )
        # (c) It short-circuits BEFORE critique/requeue: the guard's concludeDraft +
        #     return sit between the implement pass and runCritiqueAndRevision.
        guard_idx = text.find("no real file to adapt")
        critique_idx = text.find("runCritiqueAndRevision(task, {")
        self.assertGreater(guard_idx, -1, "stub guard present")
        self.assertGreater(critique_idx, guard_idx,
                           "the stub guard must fire before critique/requeue")
        # (d) The prompt itself carries both halves: the file-naming prohibition and
        #     the stub instruction (no more "output the empty string" escape).
        prompts_js = draft_js.parent / "prompts.js"
        ptext = prompts_js.read_text(encoding="utf-8")
        fn_start = ptext.find("function archImportImplementPrompt(")
        self.assertGreater(fn_start, -1)
        fn = ptext[fn_start: ptext.find("\n// ", fn_start)]
        self.assertIn("MUST NOT name", fn)
        self.assertIn("no real file to adapt", fn)
        self.assertNotIn("output the empty string", fn,
                         "the old empty-string escape must be gone from archImportImplementPrompt")
        # (e) The zero-hit skip the guard mirrors is untouched.
        self.assertIn("skipImplementOnNoHits", text)
        self.assertRegex(text, r"skipImplementOnNoHits && Array\.isArray\(task\.promptContext\.harnessHits\)\s*&& task\.promptContext\.harnessHits\.length === 0")
        # (f) The stub must NOT ride the requeue endpoint: a task parked blocked for
        #     any other reason requeues as before (existing behavior), and the requeued
        #     copy still carries blockedReason -- i.e. the requeue path is not what
        #     disposes the stub, the draft path above is.
        task_id = "adhoc-arch-import-stub-1"
        self._write_blocked(task_id, {
            "id": task_id, "domain": "arch", "source": "arch_import", "title": "import finding",
            "promptContext": {"harnessHits": [{"file": "src/prompts.js", "line": 581}]},
            "implementResponse": "no real file to adapt",
            "blockedReason": "unrelated blocked reason, not the stub",
        })
        resp = self.client.post(f"/api/task/blocked/{task_id}/requeue")
        self.assertEqual(resp.status_code, 200)
        requeued = json.loads((self.pipeline_dir / "queue" / "pending" / f"{task_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(requeued.get("implementResponse"), "no real file to adapt",
                         "the stub text must survive an incidental requeue of an otherwise-blocked task")
        self.assertEqual(requeued.get("blockedReason"), "unrelated blocked reason, not the stub",
                         "requeue semantics are unchanged -- the stub's terminal handling lives in the draft path, not here")


if __name__ == "__main__":
    unittest.main()
