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


class BuildImportGraphFileCacheTest(unittest.TestCase):
    """2026-08-24, Grimmethy (Brain Dump #155): "Every time I build a project graph it
    starts from scratch. Can we instead build on diff's so that we only have to modify
    what has actually been changed rather than building from scratch every time." """

    def test_first_build_populates_the_file_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            (repo / "src" / "a.js").write_text("require('./b.js');\n")
            (repo / "src" / "b.js").write_text("module.exports = {};\n")

            file_cache = {}
            graph = build_graph.build_import_graph(repo, ["src"], file_cache=file_cache)
            self.assertEqual(graph.number_of_edges(), 1)
            self.assertIn("src/a.js", file_cache["files"])
            self.assertEqual(file_cache["files"]["src/a.js"]["edges"], ["src/b.js"])

    def test_unchanged_file_with_a_deliberately_wrong_cached_edge_proves_reuse_not_reparse(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            (repo / "src" / "a.js").write_text("require('./b.js');\n")
            (repo / "src" / "b.js").write_text("module.exports = {};\n")
            (repo / "src" / "c.js").write_text("module.exports = {};\n")

            file_cache = {}
            build_graph.build_import_graph(repo, ["src"], file_cache=file_cache)

            # Deliberately wrong: a.js does NOT really import c.js. If the cache is
            # genuinely trusted (mtime/size unchanged), this wrong edge survives into the
            # next build's graph -- proof the file's real text was never re-scanned.
            file_cache["files"]["src/a.js"]["edges"] = ["src/c.js"]

            graph = build_graph.build_import_graph(repo, ["src"], file_cache=file_cache)
            self.assertTrue(graph.has_edge("src/a.js", "src/c.js"), "cached (even if stale) edges must be trusted when mtime/size are unchanged")
            self.assertFalse(graph.has_edge("src/a.js", "src/b.js"), "the real edge should NOT reappear -- that would mean the cache was ignored and the file was re-parsed")

    def test_changed_file_is_reparsed_and_cache_entry_updated(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            (repo / "src" / "a.js").write_text("require('./b.js');\n")
            (repo / "src" / "b.js").write_text("module.exports = {};\n")
            (repo / "src" / "c.js").write_text("module.exports = {};\n")

            file_cache = {}
            build_graph.build_import_graph(repo, ["src"], file_cache=file_cache)

            # Real change: a.js now imports c.js instead of b.js. write_text changes both
            # mtime and (here) size, so this must be detected as a cache miss.
            (repo / "src" / "a.js").write_text("require('./c.js');\n")
            graph = build_graph.build_import_graph(repo, ["src"], file_cache=file_cache)
            self.assertTrue(graph.has_edge("src/a.js", "src/c.js"))
            self.assertFalse(graph.has_edge("src/a.js", "src/b.js"))

    def test_deleted_files_are_pruned_from_the_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            (repo / "src" / "a.js").write_text("require('./b.js');\n")
            (repo / "src" / "b.js").write_text("module.exports = {};\n")

            file_cache = {}
            build_graph.build_import_graph(repo, ["src"], file_cache=file_cache)
            self.assertIn("src/b.js", file_cache["files"])

            (repo / "src" / "b.js").unlink()
            (repo / "src" / "a.js").write_text("// no import now\n")
            build_graph.build_import_graph(repo, ["src"], file_cache=file_cache)
            self.assertNotIn("src/b.js", file_cache["files"], "a deleted file's stale cache entry must not linger forever")


class BuildGraphDataCommunityNameReuseTest(unittest.TestCase):
    """The bigger win from Brain Dump #155 -- see check_due()'s own comment: a real
    per-community Ornith naming pass took 13+ minutes under real worker-lane contention.
    An unchanged community's name is now reused instead of re-calling the model."""

    def test_unchanged_community_reuses_its_old_name_without_calling_the_naming_functions(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            (repo / "src" / "a.js").write_text("require('./b.js');\n")
            (repo / "src" / "b.js").write_text("require('./a.js');\n")

            old_graph_nodes = [
                {"id": "src/a.js", "community": 0, "source_file": "src/a.js"},
                {"id": "src/b.js", "community": 0, "source_file": "src/b.js"},
            ]
            old_coverage = {"communities": [
                {"id": 0, "name": "Existing Real Name", "lastReviewedAt": None, "lastCandidateCount": -1},
            ]}

            calls = {"ornith": 0, "heuristic": 0}
            original_ornith = build_graph.name_community_ornith
            original_heuristic = build_graph.name_community_heuristic

            def spy_ornith(*a, **kw):
                calls["ornith"] += 1
                return original_ornith(*a, **kw)

            def spy_heuristic(*a, **kw):
                calls["heuristic"] += 1
                return original_heuristic(*a, **kw)

            build_graph.name_community_ornith = spy_ornith
            build_graph.name_community_heuristic = spy_heuristic
            try:
                result = build_graph.build_graph_data(
                    repo, ["src"], "http://localhost:11434", "fake-model",
                    progress=lambda *a: None, use_model_naming=True,
                    old_coverage=old_coverage, old_graph_nodes=old_graph_nodes,
                )
            finally:
                build_graph.name_community_ornith = original_ornith
                build_graph.name_community_heuristic = original_heuristic

            self.assertEqual(calls["ornith"], 0, "naming functions must not be called at all for an unchanged community")
            self.assertEqual(calls["heuristic"], 0)
            self.assertEqual(result["coverage"]["communities"][0]["name"], "Existing Real Name")

    def test_changed_community_still_gets_named_normally(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "src").mkdir()
            (repo / "src" / "a.js").write_text("require('./b.js');\n")
            (repo / "src" / "b.js").write_text("require('./a.js');\n")

            # Old coverage refers to a DIFFERENT member set (c.js instead of b.js) --
            # no signature match, so this must fall through to real naming.
            old_graph_nodes = [
                {"id": "src/a.js", "community": 0, "source_file": "src/a.js"},
                {"id": "src/c.js", "community": 0, "source_file": "src/c.js"},
            ]
            old_coverage = {"communities": [
                {"id": 0, "name": "Stale Name", "lastReviewedAt": None, "lastCandidateCount": -1},
            ]}

            result = build_graph.build_graph_data(
                repo, ["src"], "http://localhost:11434", "fake-model",
                progress=lambda *a: None, use_model_naming=False,  # heuristic only -- no real network call
                old_coverage=old_coverage, old_graph_nodes=old_graph_nodes,
            )
            self.assertNotEqual(result["coverage"]["communities"][0]["name"], "Stale Name")


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
