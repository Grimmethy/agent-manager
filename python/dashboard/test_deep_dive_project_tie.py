"""GET /api/deep-dive/projects ties each scouted repo to the project it was scouted FOR (routes/deep_dive.py).

The pipeline only works a lead for the project whose directory name equals the lead's "Relevant to" tag
(task-sources.js nextDeepDiveTask), so the Scouted Repos tab must show that tag + reason, list the active
project's not-yet-cloned leads as `queued`, and hide other projects' leads unless `?scope=all`.

Run: .venv/bin/python -m unittest python.dashboard.test_deep_dive_project_tie -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from routes.deep_dive import parse_strong_leads  # noqa: E402

INDEX = """# Index

| Project | Source | Description | Relevant to | Status |
|---|---|---|---|---|
| [org/wan](https://github.com/org/wan) | github | Video models | videoforge -- the models we run. Also relevant to: storyforge. | lead |
| [org/cloned](https://github.com/org/cloned) | github | Already cloned | videoforge -- memory tricks. | lead |
| [org/kokoro](https://github.com/org/kokoro) | github | TTS | voiceforge -- narration voice. | lead |
| [org/weak](https://github.com/org/weak) | github | No notes subsection | videoforge -- never Strong. | lead |
| [org/multi](https://github.com/org/multi) | github | Comma tag | a, b -- matches no project. | lead |

## Notes
### org/wan

videoforge: x
### org/cloned

videoforge: y
### org/kokoro

voiceforge: z
### org/multi

a, b: q
"""


class DeepDiveProjectTieTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        t = Path(self._tmp.name)
        self._orig_env_path = app.ENV_FILE_PATH
        app.ENV_FILE_PATH = t / "agent-manager.env"
        self._saved = {k: os.environ.get(k) for k in
                       ("AGENT_MANAGER_REPO_ROOT", "AGENT_MANAGER_PIPELINE_DIR", "AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH",
                        "AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH")}
        for k in self._saved:
            os.environ.pop(k, None)
        self.repo = t / "videoforge"
        self.repo.mkdir()
        self.index = t / "UsefulProjectIndex" / "INDEX.md"
        self.index.parent.mkdir()
        self.index.write_text(INDEX, encoding="utf-8")
        (t / "pipeline").mkdir()
        (t / "pipeline" / "deep-dive-coverage.json").write_text(json.dumps({"projects": {
            "org-cloned": {"sourceUrl": "https://github.com/org/cloned", "clonedAt": "2026-10-13T00:00:00Z",
                           "communities": [{"id": 1, "lastReviewedAt": "x", "actionItemCount": 2}, {"id": 2}]}}}), encoding="utf-8")
        app.ENV_FILE_PATH.write_text(
            "AGENT_MANAGER_REPO_ROOT=%s\nAGENT_MANAGER_PIPELINE_DIR=%s\n" % (self.repo, t / "pipeline"), encoding="utf-8")
        self.client = app.app.test_client()

    def tearDown(self):
        app.ENV_FILE_PATH = self._orig_env_path
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def test_parser_matches_the_node_rules_and_keeps_tag_and_reason(self):
        leads = {l["name"]: l for l in parse_strong_leads(INDEX)}
        self.assertNotIn("org/weak", leads)                       # no ### subsection -> not Strong
        self.assertEqual(leads["org/wan"]["relevantTo"], "videoforge")
        self.assertEqual(leads["org/wan"]["reason"], "the models we run. Also relevant to: storyforge.")
        self.assertEqual(leads["org/multi"]["relevantTo"], "a, b")  # a comma list is a tag that matches no project

    def test_default_list_is_this_projects_cloned_and_queued_leads_only(self):
        rows = {r["slug"]: r for r in self.client.get("/api/deep-dive/projects").get_json()}
        self.assertEqual(set(rows), {"org-cloned", "org-wan"})     # kokoro is voiceforge's, multi matches nothing
        self.assertEqual(rows["org-cloned"]["status"], "cloned")
        self.assertEqual((rows["org-cloned"]["reviewedCount"], rows["org-cloned"]["communityCount"], rows["org-cloned"]["totalActionItems"]), (1, 2, 2))
        self.assertEqual(rows["org-cloned"]["relevantTo"], "videoforge")
        self.assertEqual(rows["org-wan"]["status"], "queued")
        self.assertEqual(rows["org-wan"]["sourceUrl"], "https://github.com/org/wan")
        self.assertIn("models we run", rows["org-wan"]["reason"])

    def test_scope_all_adds_other_projects_leads_marked_and_sorted_last(self):
        rows = self.client.get("/api/deep-dive/projects?scope=all").get_json()
        by = {r["slug"]: r for r in rows}
        self.assertEqual(by["org-kokoro"]["status"], "other-project")
        self.assertEqual(by["org-kokoro"]["relevantTo"], "voiceforge")
        self.assertEqual([r["status"] for r in rows], sorted((r["status"] for r in rows), key=["cloned", "queued", "other-project"].index))

    def test_no_index_file_still_lists_cloned_projects(self):
        self.index.unlink()
        rows = self.client.get("/api/deep-dive/projects").get_json()
        self.assertEqual([r["slug"] for r in rows], ["org-cloned"])
        self.assertIsNone(rows[0]["relevantTo"])


if __name__ == "__main__":
    unittest.main()
