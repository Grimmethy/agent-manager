"""Tests for routes/trajectories.py: the read-only agent-run trajectory viewer (brain-dump 1892 part 2).

Run: .venv/bin/python -m unittest python.dashboard.test_trajectories -v
"""
import gzip
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

TASK = "adhoc-some-task-1"


def _traj(final="all done <ok>", content_extra=""):
    return {
        "version": 1, "taskId": TASK, "stage": "agentic-write", "source": "manual", "lane": "worker-3090", "model": "qwen3.8:27b",
        "startedAt": "2026-10-18T10:00:00.000Z", "endedAt": "2026-10-18T10:01:30.000Z", "durationMs": 90000,
        "result": {"responseChars": len(final), "turnsUsed": 3, "forcedSummary": False, "forcedSummaryReason": None,
                   "toolsDisabled": False, "promptEvalCount": 900, "evalCount": 40},
        "turns": [
            {"turn": 0, "phase": "loop", "doneReason": "stop", "endClass": "tool-calls", "toolCallCount": 1, "toolNames": ["edit_file"], "promptEvalCount": 300, "evalCount": 12},
            {"turn": 1, "phase": "loop", "doneReason": "stop", "endClass": "stop", "toolCallCount": 0, "toolNames": [], "promptEvalCount": 340, "evalCount": 9},
            {"turn": 2, "phase": "loop", "doneReason": "length", "endClass": "length", "toolCallCount": 0, "toolNames": [], "promptEvalCount": 360, "evalCount": 19},
        ],
        "messages": [
            {"role": "system", "content": "you are an agent" + content_extra},
            {"role": "assistant", "content": "", "tool_calls": [{"name": "edit_file", "arguments": json.dumps({"path": "a.txt", "find": "alpha", "replace": "ALPHA"})}]},
            {"role": "tool", "content": json.dumps({"path": "a.txt", "edited": True})},
            {"role": "assistant", "content": final, "final": True},
        ],
    }


class TrajectoryViewerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.inst = Path(self._tmp.name) / "instances"
        self.dir = self.inst / "trajectories" / TASK
        self.dir.mkdir(parents=True)
        self._p = mock.patch.object(app, "instances_dir", return_value=self.inst)
        self._p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        self._p.stop()
        self._tmp.cleanup()

    def _write(self, name, traj):
        with gzip.open(self.dir / name, "wt", encoding="utf-8") as fh:
            json.dump(traj, fh)

    def test_list_runs_newest_first_and_empty_for_unknown_task(self):
        self._write("20261018T100000Z-agentic-write-11.json.gz", _traj())
        self._write("20261018T120000Z-plan-12.json.gz", _traj())
        (self.dir / "notes.txt").write_text("ignored")
        body = self.client.get(f"/api/task-anywhere/{TASK}/trajectories").get_json()
        self.assertEqual([r["name"] for r in body["runs"]], ["20261018T120000Z-plan-12.json.gz", "20261018T100000Z-agentic-write-11.json.gz"])
        self.assertEqual(body["runs"][0]["stage"], "plan")
        self.assertEqual(self.client.get("/api/task-anywhere/no-such-task/trajectories").get_json()["runs"], [])

    def test_page_renders_header_turns_tool_calls_results_and_final_answer(self):
        self._write("20261018T100000Z-agentic-write-11.json.gz", _traj())
        r = self.client.get(f"/trajectory/{TASK}")
        self.assertEqual(r.status_code, 200)
        page = r.get_data(as_text=True)
        for needle in ("agentic-write", "worker-3090", "qwen3.8:27b", "90 s", "3 turn(s)", "Turns (3)",
                       "b-tool-calls", "300 prompt / 12 gen tokens", "edit_file", "&quot;find&quot;: &quot;alpha&quot;",
                       "&quot;edited&quot;: true", "(final answer)", "b-length", "done_reason length"):
            self.assertIn(needle, page, needle)

    def test_text_is_escaped_and_bad_run_names_404(self):
        self._write("20261018T100000Z-agentic-write-11.json.gz", _traj(content_extra="<script>alert(1)</script>"))
        page = self.client.get(f"/trajectory/{TASK}").get_data(as_text=True)
        self.assertNotIn("<script>alert(1)</script>", page)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", page)
        self.assertIn("all done &lt;ok&gt;", page)
        for bad in ("../x.json.gz", "foo.txt", "20261018T999999Z-nope-1.json.gz", "..%2F..%2Fsecret.json.gz"):
            self.assertEqual(self.client.get(f"/trajectory/{TASK}?run={bad}").status_code, 404, bad)

    def test_task_with_no_trajectories_says_so(self):
        r = self.client.get("/trajectory/never-ran")
        self.assertEqual(r.status_code, 200)
        self.assertIn("No trajectories recorded", r.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
