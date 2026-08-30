"""Tests for the per-task metadata surfaced in the dashboard's task detail modal
(Grimmethy, 2026-08-26: "At the top of every task I'd like to see... a list of all the
files it touched") -- _files_touched_for() has to handle both real shapes a task's
on-disk change comes in (see apply-task.js's own dispatch): a unified diff in
task.rawDiff (Group A/adhoc), or a JSON change object/array with a `file` field per item
in task.implementResponse (Group B) -- plus the legitimate case of neither (a verdict-
only audit, or an arch_discovery/arch_review "split" proposal that writes nothing).

Run: .venv/bin/python -m unittest python.dashboard.test_task_metadata -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class FilesTouchedForTest(unittest.TestCase):
    def test_unified_diff_extracts_new_side_paths(self):
        raw_diff = (
            "diff --git a/src/foo.js b/src/foo.js\n"
            "index abc..def 100644\n"
            "--- a/src/foo.js\n"
            "+++ b/src/foo.js\n"
            "@@ -1,1 +1,1 @@\n"
            "-old\n"
            "+new\n"
            "diff --git a/src/bar.js b/src/bar.js\n"
            "new file mode 100644\n"
            "index 0000000..1111111\n"
            "--- /dev/null\n"
            "+++ b/src/bar.js\n"
            "@@ -0,0 +1,1 @@\n"
            "+hello\n"
        )
        task = {"rawDiff": raw_diff}
        self.assertEqual(app._files_touched_for(task), ["src/foo.js", "src/bar.js"])

    def test_unified_diff_deletion_falls_back_to_old_side_path(self):
        raw_diff = (
            "diff --git a/src/gone.js b/src/gone.js\n"
            "deleted file mode 100644\n"
            "index 1111111..0000000\n"
            "--- a/src/gone.js\n"
            "+++ /dev/null\n"
            "@@ -1,1 +0,0 @@\n"
            "-bye\n"
        )
        task = {"rawDiff": raw_diff}
        self.assertEqual(app._files_touched_for(task), ["src/gone.js"])

    def test_group_b_single_object_implement_response(self):
        task = {"implementResponse": '{"mode":"edit","file":"src/foo.js","find":"a","replace":"b"}'}
        self.assertEqual(app._files_touched_for(task), ["src/foo.js"])

    def test_group_b_array_implement_response_dedupes(self):
        task = {"implementResponse": (
            '[{"mode":"edit","file":"src/a.js","find":"x","replace":"y"},'
            '{"mode":"edit","file":"src/b.js","find":"x","replace":"y"},'
            '{"mode":"edit","file":"src/a.js","find":"y","replace":"z"}]'
        )}
        self.assertEqual(app._files_touched_for(task), ["src/a.js", "src/b.js"])

    def test_group_b_response_wrapped_in_markdown_fence(self):
        task = {"implementResponse": '```json\n{"mode":"edit","file":"src/foo.js","find":"a","replace":"b"}\n```'}
        self.assertEqual(app._files_touched_for(task), ["src/foo.js"])

    def test_group_b_response_with_leading_prose_no_fence(self):
        task = {"implementResponse": 'Sure, here is the change:\n{"mode":"edit","file":"src/foo.js","find":"a","replace":"b"}'}
        self.assertEqual(app._files_touched_for(task), ["src/foo.js"])

    def test_verdict_only_task_has_no_files_touched(self):
        task = {"implementResponse": "Verdict: **False positive**. No remediation needed."}
        self.assertEqual(app._files_touched_for(task), [])

    def test_split_proposal_has_no_files_touched(self):
        # arch_discovery/arch_review "split" mode: real JSON, but each candidate's
        # "files" field is a descriptive STRING (e.g. "src/apply-task.js"), not the
        # per-change "file" key Group B's applier actually reads -- correctly not
        # mistaken for a real file write.
        task = {"implementResponse": '{"mode":"split","candidates":[{"title":"x","files":"src/apply-task.js"}]}'}
        self.assertEqual(app._files_touched_for(task), [])

    def test_missing_fields_returns_empty_list_not_error(self):
        self.assertEqual(app._files_touched_for({}), [])


class TaskInputSummaryTest(unittest.TestCase):
    def test_product_spec_surfaces_requestText_and_the_output_target(self):
        task = {
            "source": "product_spec",
            "title": "Seed the PromptForge product spec",
            "promptContext": {
                "requestText": "PromptForge is a local single-user web app ... write the FIRST product spec ...",
                "specRelPath": "Docs/PRODUCT_SPEC.md",
                "specExists": False,
            },
        }
        out = app._task_input_summary(task)
        self.assertEqual(out[0]["label"], "Request")
        self.assertIn("local single-user web app", out[0]["text"])
        self.assertEqual(out[-1], {"label": "Output", "text": "Docs/PRODUCT_SPEC.md (new file)"})

    def test_product_spec_output_note_reflects_an_existing_spec(self):
        task = {"source": "product_spec", "promptContext": {"specRelPath": "S.md", "specExists": True}}
        self.assertEqual(app._task_input_summary(task)[-1]["text"], "S.md (updating the existing spec)")

    def test_scanner_finding_surfaces_detail_and_snippet(self):
        task = {
            "source": "function_length_review",
            "title": "Function-length triage: server/app.py:349 — promptforge",
            "promptContext": {
                "detail": 'function "resolve_job" is 103 lines long (threshold 100)',
                "snippet": "def resolve_job(spec):\n    ...",
            },
        }
        labels = [i["label"] for i in app._task_input_summary(task)]
        self.assertEqual(labels, ["Finding", "Code snippet"])

    def test_falls_back_to_rawText_and_skips_a_value_equal_to_the_title(self):
        # brain-dump style: rawText carries the real request
        task = {"title": "short title", "promptContext": {"rawText": "the full, longer request body"}}
        self.assertEqual(app._task_input_summary(task), [{"label": "Request", "text": "the full, longer request body"}])
        # rawText that just duplicates the title adds nothing -> omitted
        task2 = {"title": "same", "promptContext": {"rawText": "same"}}
        self.assertEqual(app._task_input_summary(task2), [])

    def test_no_promptContext_returns_empty_list_not_error(self):
        self.assertEqual(app._task_input_summary({}), [])
        self.assertEqual(app._task_input_summary({"promptContext": None}), [])


if __name__ == "__main__":
    unittest.main()
