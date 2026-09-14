"""Tests for POST /api/project-search/manual-lead (routes/deep_dive.py) -- the "+ Add repo"
bar on the Scouted Repos tab (Grimmethy, 2026-09-14: "I need a way to enter new github
repos into the Scouted Repos tab... processed the same as any other scouted repo").

Verifies the endpoint writes the same row + `## Notes` subsection shape
applyProjectSearchFindings() (src/apply-group-a-report-appenders.js) writes for an
auto-discovered Strong lead, since that's what makes task-sources.js's
parseStrongLeadsFromIndex() (and therefore nextDeepDiveTask()) pick it up on the very next
worker tick -- this test can't drive that JS function directly, so it locks down the exact
INDEX.md shape that function's own regexes require instead.

Run: .venv/bin/python -m unittest python.dashboard.test_deep_dive_manual_lead -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class DeepDiveManualLeadTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_env_path = app.ENV_FILE_PATH
        app.ENV_FILE_PATH = Path(self._tmp.name) / "agent-manager.env"
        self._saved = {k: os.environ.get(k) for k in
                       ("AGENT_MANAGER_REPO_ROOT", "AGENT_MANAGER_PIPELINE_DIR",
                        "AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH")}
        for k in self._saved:
            os.environ.pop(k, None)
        self.repo_root = Path(self._tmp.name) / "agent-manager"
        self.repo_root.mkdir(parents=True, exist_ok=True)
        self.index_path = Path(self._tmp.name) / "UsefulProjectIndex" / "INDEX.md"
        app.ENV_FILE_PATH.write_text(
            f"AGENT_MANAGER_REPO_ROOT={self.repo_root}\n"
            f"AGENT_MANAGER_PIPELINE_DIR={self.repo_root}\n",
            encoding="utf-8",
        )
        self.client = app.app.test_client()

    def tearDown(self):
        app.ENV_FILE_PATH = self._orig_env_path
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _post(self, body):
        return self.client.post("/api/project-search/manual-lead", json=body)

    def test_adds_a_row_and_notes_subsection_scoped_to_the_active_project(self):
        res = self._post({"url": "https://github.com/octocat/Hello-World"})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["name"], "octocat/Hello-World")
        self.assertEqual(data["slug"], "octocat-hello-world")
        self.assertEqual(data["relevantTo"], "agent-manager")  # basename(repo_root)
        self.assertFalse(data["alreadyPresent"])

        text = self.index_path.read_text(encoding="utf-8")
        self.assertIn(
            "| [octocat/Hello-World](https://github.com/octocat/Hello-World) | github |",
            text,
        )
        self.assertIn(" agent-manager -- manually added via dashboard |", text)
        self.assertIn("### octocat/Hello-World", text)
        # The subsection must land under ## Notes, not before it -- that's the exact
        # structural signal parseStrongLeadsFromIndex() keys "Strong" on.
        self.assertLess(text.index("## Notes"), text.index("### octocat/Hello-World"))

    def test_tolerates_a_trailing_slash_git_suffix_and_extra_path_segments(self):
        res = self._post({"url": "https://github.com/octocat/Hello-World.git/tree/main/"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()["name"], "octocat/Hello-World")

    def test_resubmitting_the_same_repo_is_a_dedup_no_op_not_a_duplicate_row(self):
        self._post({"url": "https://github.com/octocat/Hello-World"})
        res = self._post({"url": "https://github.com/octocat/Hello-World"})
        data = res.get_json()
        self.assertTrue(data["alreadyPresent"])

        text = self.index_path.read_text(encoding="utf-8")
        self.assertEqual(text.count("[octocat/Hello-World]"), 1)
        self.assertEqual(text.count("### octocat/Hello-World"), 1)

    def test_rejects_a_non_github_url(self):
        res = self._post({"url": "https://gitlab.com/octocat/Hello-World"})
        self.assertEqual(res.status_code, 400)

    def test_rejects_a_url_with_no_repo_path(self):
        res = self._post({"url": "https://github.com/octocat"})
        self.assertEqual(res.status_code, 400)

    def test_rejects_a_missing_url(self):
        res = self._post({})
        self.assertEqual(res.status_code, 400)


if __name__ == "__main__":
    unittest.main()
