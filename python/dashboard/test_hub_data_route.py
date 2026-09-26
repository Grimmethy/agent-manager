"""Swap point for hub-data lookups (S5d of the hub-tasks extraction, 2026-09-25) -- the
Python-side twin of the JS hooks (hub-apply-routing.js, apply-branch-prep-route.js,
split-coverage-judging-route.js). Default = today's file-based _hub_for_branch /
_hub_info_for_task, moved to a swap point rather than reimplemented.

Run: .venv/bin/python -m unittest python.dashboard.test_hub_data_route -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TestHubDataProviderSwapPoint(unittest.TestCase):
    def tearDown(self):
        app.set_hub_data_provider(None)

    def test_default_provider_wraps_the_real_functions(self):
        provider = app.get_hub_data_provider()
        self.assertIs(provider.hub_for_branch, app._hub_for_branch)
        self.assertIs(provider.hub_info_for_task, app._hub_info_for_task)

    def test_set_provider_overrides_the_default(self):
        class FakeProvider:
            def hub_for_branch(self, qdir, branch, commit_task_ids):
                return {"fake": True}

            def hub_info_for_task(self, task_id, task=None, index=None, qdir=None):
                return {"fake": True}

        fake = FakeProvider()
        app.set_hub_data_provider(fake)
        self.assertIs(app.get_hub_data_provider(), fake)
        self.assertEqual(app.get_hub_data_provider().hub_for_branch(None, "x", []), {"fake": True})

    def test_set_provider_with_none_restores_the_default(self):
        app.set_hub_data_provider(object())
        app.set_hub_data_provider(None)
        provider = app.get_hub_data_provider()
        self.assertIs(provider.hub_for_branch, app._hub_for_branch)


class TestLabelForBranchGoesThroughTheProvider(unittest.TestCase):
    """_label_for_branch (app.py ~3350) is a real production caller of
    get_hub_data_provider().hub_for_branch -- this proves an override actually reaches it,
    not just the accessor pair in isolation."""

    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        (self.dir / "queue").mkdir()

    def tearDown(self):
        app.set_hub_data_provider(None)
        self._tmp.cleanup()

    def test_a_stacked_decompose_branch_label_comes_from_the_overridden_provider(self):
        class FakeProvider:
            def hub_for_branch(self, qdir, branch, commit_task_ids):
                self.seen_branch = branch
                return {
                    "title": "HUB0099 · overridden",
                    "state": "coordinating",
                    "progress": {"done": 1, "built": 2, "total": 3},
                    "integrationGate": {"status": "passed"},
                    "readyToMerge": False,
                }

            def hub_info_for_task(self, *a, **kw):
                return None

        fake = FakeProvider()
        app.set_hub_data_provider(fake)
        label = app._label_for_branch("decompose-x", self.dir, "subject line", repo_root=self.dir)
        self.assertEqual(label["title"], "HUB0099 · overridden")
        self.assertEqual(fake.seen_branch, "agent/decompose-x")


if __name__ == "__main__":
    unittest.main()
