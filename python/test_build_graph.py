#!/usr/bin/env python3
"""Regression tests for build_graph.py's symlink-resolution fix and the coverage-merge
logic backing the new --check-due daily rebuild (2026-08-19). No prior Python test
infrastructure existed in this package before this file -- uses only the stdlib
(unittest), matching this file's own zero-extra-dependency spirit.

Run: .venv/bin/python -m unittest python.test_build_graph -v
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import build_graph  # noqa: E402


class BuildImportGraphSymlinkTest(unittest.TestCase):
    """Confirmed live 2026-08-19: dashboard 'Build' button against a symlinked
    AGENT_MANAGER_REPO_ROOT (this project's own self-hosted setup) raised ValueError,
    "... is not in the subpath of ...", because file_set's f.resolve() followed the
    symlink while repo_root itself was never resolved."""

    def test_build_import_graph_handles_a_symlinked_repo_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            real_dir = Path(tmp) / "real"
            (real_dir / "src").mkdir(parents=True)
            (real_dir / "src" / "a.js").write_text("require('./b.js');\n")
            (real_dir / "src" / "b.js").write_text("module.exports = {};\n")

            symlink_dir = Path(tmp) / "via-symlink"
            symlink_dir.symlink_to(real_dir)

            # Before the fix, this line raised ValueError.
            graph = build_graph.build_import_graph(symlink_dir, ["src"])
            self.assertEqual(graph.number_of_nodes(), 2)
            self.assertEqual(graph.number_of_edges(), 1)


class MergeCoverageTest(unittest.TestCase):
    def test_identical_community_carries_forward_review_state(self):
        old_graph_nodes = [
            {"id": "src/a.js", "community": 0},
            {"id": "src/b.js", "community": 0},
        ]
        old_coverage = {"communities": [
            {"id": 0, "name": "src", "lastReviewedAt": "2026-08-01T00:00:00Z", "lastCandidateCount": 3},
        ]}
        # Same two files, but landed at a different id/position in the new build --
        # exactly the kind of harmless reordering merge_coverage must see through.
        new_graph_nodes = [
            {"id": "src/b.js", "community": 5},
            {"id": "src/a.js", "community": 5},
        ]
        new_coverage = {"communities": [
            {"id": 5, "name": "src", "lastReviewedAt": None, "lastCandidateCount": -1},
        ]}

        merged = build_graph.merge_coverage(old_coverage, old_graph_nodes, new_coverage, new_graph_nodes)
        self.assertEqual(merged["communities"][0]["lastReviewedAt"], "2026-08-01T00:00:00Z")
        self.assertEqual(merged["communities"][0]["lastCandidateCount"], 3)
        self.assertEqual(merged["communities"][0]["id"], 5)  # keeps the NEW id, only borrows review state

    def test_changed_community_membership_starts_fresh(self):
        old_graph_nodes = [{"id": "src/a.js", "community": 0}, {"id": "src/b.js", "community": 0}]
        old_coverage = {"communities": [
            {"id": 0, "name": "src", "lastReviewedAt": "2026-08-01T00:00:00Z", "lastCandidateCount": 3},
        ]}
        # A third file joined this community -- the member set genuinely changed.
        new_graph_nodes = [
            {"id": "src/a.js", "community": 0},
            {"id": "src/b.js", "community": 0},
            {"id": "src/c.js", "community": 0},
        ]
        new_coverage = {"communities": [
            {"id": 0, "name": "src", "lastReviewedAt": None, "lastCandidateCount": -1},
        ]}

        merged = build_graph.merge_coverage(old_coverage, old_graph_nodes, new_coverage, new_graph_nodes)
        self.assertIsNone(merged["communities"][0]["lastReviewedAt"])
        self.assertEqual(merged["communities"][0]["lastCandidateCount"], -1)

    def test_brand_new_community_with_no_old_history_is_untouched(self):
        merged = build_graph.merge_coverage(
            {"communities": []}, [],
            {"communities": [{"id": 0, "name": "new-area", "lastReviewedAt": None, "lastCandidateCount": -1}]},
            [{"id": "src/new.js", "community": 0}],
        )
        self.assertEqual(merged["communities"], [{"id": 0, "name": "new-area", "lastReviewedAt": None, "lastCandidateCount": -1}])


if __name__ == "__main__":
    unittest.main()
