"""A `Files:` line in a needs-clarification answer replaces the task's stale `Files:` line (2026-10-30).

src/adhoc-diff-sanity.js extractDeclaredFiles reads only the FIRST `Files:` line and every guard trusts it, so an answer that merely appended a corrected
path as prose left the stale line in charge (HUB0088-02 was blocked six times that way). The chat answer (src/chat-task-requeue.js replaceFilesLine)
already replaces it; this file pins the same rule for the dashboard route routes/task.py api_task_answer_clarification and its pure helper
replace_files_line. Sandbox project only: temp queue, stubbed registry, no live queue.

Run: .venv/bin/python -m unittest python.dashboard.test_answer_files_line -v   (from the repo root)
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes.task import replace_files_line  # noqa: E402


class ReplaceFilesLineTest(unittest.TestCase):
    def test_last_answer_line_replaces_the_first_task_line_and_both_values_are_returned(self):
        text, replaced = replace_files_line("ask\nFiles: old.py\nbody", "The file moved.\nFiles: new.py, other.py")
        self.assertEqual(text, "ask\nFiles: new.py, other.py\nbody")
        self.assertEqual(replaced, {"old": "old.py", "new": "new.py, other.py"})

    def test_two_answer_lines_use_the_last_one(self):
        text, replaced = replace_files_line("ask\nFiles: old.py", "first try\nFiles: a.py\nthen\nFiles: b.py, c.py")
        self.assertEqual(text, "ask\nFiles: b.py, c.py")
        self.assertEqual(replaced["new"], "b.py, c.py")

    def test_no_files_line_in_the_answer_changes_nothing(self):
        self.assertEqual(replace_files_line("ask\nFiles: old.py", "go with option B"), ("ask\nFiles: old.py", None))

    def test_a_mid_line_files_mention_in_prose_is_not_a_files_line(self):
        self.assertEqual(replace_files_line("ask\nFiles: x.js", "see Files: y.js in prose"), ("ask\nFiles: x.js", None))

    def test_no_earlier_files_line_on_the_task_adds_none(self):
        self.assertEqual(replace_files_line("ask without a files line", "Files: new.py"), ("ask without a files line", None))

    def test_an_unchanged_value_changes_nothing(self):
        self.assertEqual(replace_files_line("a\nFiles: x.js\nb", "Files: x.js"), ("a\nFiles: x.js\nb", None))

    def test_the_label_is_case_insensitive_and_the_replacement_is_normalised(self):
        text, replaced = replace_files_line("a\nfiles: x.js\nb", "FILES: y.js")
        self.assertEqual(text, "a\nFiles: y.js\nb")
        self.assertEqual(replaced, {"old": "x.js", "new": "y.js"})

    def test_only_the_first_task_line_is_replaced_and_empty_inputs_are_safe(self):
        text, _ = replace_files_line("Files: a.py\nmid\nFiles: b.py", "Files: z.py")
        self.assertEqual(text, "Files: z.py\nmid\nFiles: b.py")
        self.assertEqual(replace_files_line(None, None), ("", None))


class AnswerRouteTest(unittest.TestCase):
    def setUp(self):
        self.q = Path(tempfile.mkdtemp()) / "queue"
        for p in (
            mock.patch.object(app, "queue_dir", return_value=self.q),
            mock.patch.object(app, "_record_manual_requeue"),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.client = app.app.test_client()

    def put(self, task_id, raw_text, history=None):
        d = self.q / "needs-clarification"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{task_id}.json").write_text(json.dumps({
            "id": task_id, "history": history or [], "needsClarification": {"reason": "design-decision"}, "promptContext": {"rawText": raw_text},
        }))

    def moved(self, task_id):
        return json.loads((self.q / "adhoc" / f"{task_id}.json").read_text())

    def test_an_answer_with_a_files_line_replaces_the_stale_line_and_logs_the_swap_before_the_resolved_entry(self):
        self.put("t1", "Part 2 of 3.\nFiles: python/build_graph.py\n\nTHIS PART: store specs.")
        r = self.client.post("/api/task/needs-clarification/t1/answer", json={"answer": "It was split.\nFiles: python/graph_edge_resolution.py"})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        task = self.moved("t1")
        raw = task["promptContext"]["rawText"]
        self.assertRegex(raw, r"(?m)^Files: python/graph_edge_resolution\.py$")
        self.assertNotIn("python/build_graph.py", raw)
        self.assertIn("HUMAN DESIGN DECISION", raw)
        stages = [h["stage"] for h in task["history"]]
        self.assertEqual(stages[-2:], ["files-line-replaced", "needs-clarification-resolved"])
        swap = task["history"][-2]["detail"]
        self.assertIn("python/build_graph.py", swap)
        self.assertIn("python/graph_edge_resolution.py", swap)

    def test_an_answer_without_a_files_line_leaves_the_task_line_and_writes_no_swap_entry(self):
        self.put("t2", "ask\nFiles: old.py")
        r = self.client.post("/api/task/needs-clarification/t2/answer", json={"answer": "go with B"})
        self.assertEqual(r.status_code, 200)
        task = self.moved("t2")
        self.assertRegex(task["promptContext"]["rawText"].split("HUMAN DESIGN DECISION")[0], r"(?m)^Files: old\.py$")
        self.assertNotIn("files-line-replaced", [h["stage"] for h in task["history"]])

    def test_a_task_with_no_earlier_files_line_gets_none_in_its_own_text(self):
        self.put("t3", "ask without a files line")
        r = self.client.post("/api/task/needs-clarification/t3/answer", json={"answer": "Files: new.py"})
        self.assertEqual(r.status_code, 200)
        task = self.moved("t3")
        self.assertNotIn("Files:", task["promptContext"]["rawText"].split("HUMAN DESIGN DECISION")[0])
        self.assertNotIn("files-line-replaced", [h["stage"] for h in task["history"]])

    def test_the_existing_happy_path_still_has_exactly_one_resolved_entry(self):
        self.put("t4", "original ask", history=[{"stage": "implement-done", "at": "x"}])
        r = self.client.post("/api/task/needs-clarification/t4/answer", json={"answer": "go with option B"})
        self.assertEqual(r.status_code, 200)
        task = self.moved("t4")
        self.assertEqual([h["stage"] for h in task["history"]], ["implement-done", "needs-clarification-resolved"])
        self.assertNotIn("needsClarification", task)


if __name__ == "__main__":
    unittest.main()
