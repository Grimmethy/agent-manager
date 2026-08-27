#!/usr/bin/env python3
"""Regression tests for build_note_graph.py -- the Second Brain wikilink graph builder
(mirrors test_build_graph.py's structure/style). Covers: parsing `[[Note Name]]` spans
(plain, aliased, header-anchored), resolving to existing vs. dangling/ambiguous targets,
and that isolated (unlinked) notes are excluded from the built graph, same as
build_graph_data drops zero-degree nodes.

Run: .venv/bin/python -m unittest python.test_build_note_graph -v
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import build_note_graph  # noqa: E402


class ExtractWikilinkTargetsTest(unittest.TestCase):
    def test_plain_wikilink(self):
        targets = build_note_graph._extract_wikilink_targets("See [[Other Note]] for more.")
        self.assertEqual(targets, ["Other Note"])

    def test_aliased_wikilink_uses_the_target_not_the_display_text(self):
        targets = build_note_graph._extract_wikilink_targets("See [[Other Note|a friendlier name]].")
        self.assertEqual(targets, ["Other Note"])

    def test_header_anchored_wikilink_uses_the_note_name_only(self):
        targets = build_note_graph._extract_wikilink_targets("See [[Other Note#Some Heading]].")
        self.assertEqual(targets, ["Other Note"])

    def test_multiple_wikilinks_in_one_note(self):
        targets = build_note_graph._extract_wikilink_targets("[[A]] and [[B]] and [[A]] again.")
        self.assertEqual(targets, ["A", "B", "A"])

    def test_no_wikilinks_returns_empty(self):
        self.assertEqual(build_note_graph._extract_wikilink_targets("Just plain text, no links."), [])


class ResolveWikilinkTest(unittest.TestCase):
    def test_resolves_case_insensitively_against_basename(self):
        with tempfile.TemporaryDirectory() as tmp:
            note = Path(tmp) / "Other Note.md"
            note.write_text("hi\n")
            index = {"other note": [note]}
            self.assertEqual(build_note_graph.resolve_wikilink("OTHER NOTE", index), note)

    def test_explicit_md_suffix_in_the_link_still_resolves(self):
        with tempfile.TemporaryDirectory() as tmp:
            note = Path(tmp) / "Other Note.md"
            note.write_text("hi\n")
            index = {"other note": [note]}
            self.assertEqual(build_note_graph.resolve_wikilink("Other Note.md", index), note)

    def test_dangling_link_to_a_nonexistent_note_is_unresolved(self):
        index = {"real note": [Path("/fake/Real Note.md")]}
        self.assertIsNone(build_note_graph.resolve_wikilink("Nonexistent Note", index))

    def test_ambiguous_basename_shared_by_two_notes_is_unresolved(self):
        index = {"shared": [Path("/fake/a/Shared.md"), Path("/fake/b/Shared.md")]}
        self.assertIsNone(build_note_graph.resolve_wikilink("Shared", index))


class BuildNoteImportGraphTest(unittest.TestCase):
    def test_two_notes_linked_by_a_wikilink_produce_one_edge(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "A.md").write_text("Links to [[B]].\n")
            (root / "B.md").write_text("No links here.\n")

            graph = build_note_graph.build_note_import_graph(root)
            self.assertEqual(graph.number_of_nodes(), 2)
            self.assertEqual(graph.number_of_edges(), 1)
            self.assertTrue(graph.has_edge("A.md", "B.md"))

    def test_dangling_wikilink_produces_no_edge_and_does_not_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "A.md").write_text("Links to [[Does Not Exist]].\n")

            graph = build_note_graph.build_note_import_graph(root)
            self.assertEqual(graph.number_of_nodes(), 1)
            self.assertEqual(graph.number_of_edges(), 0)

    def test_self_link_produces_no_self_edge(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "A.md").write_text("Links to [[A]] itself.\n")

            graph = build_note_graph.build_note_import_graph(root)
            self.assertEqual(graph.number_of_edges(), 0)

    def test_note_with_no_wikilinks_in_or_out_is_still_a_node_before_pruning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "A.md").write_text("Links to [[B]].\n")
            (root / "B.md").write_text("No links.\n")
            (root / "Isolated.md").write_text("Nothing here links anywhere.\n")

            graph = build_note_graph.build_note_import_graph(root)
            self.assertEqual(graph.number_of_nodes(), 3)
            self.assertEqual(graph.degree("Isolated.md"), 0)

    def test_non_markdown_files_are_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "A.md").write_text("Links to [[B]].\n")
            (root / "B.md").write_text("No links.\n")
            (root / "notes.txt").write_text("[[B]] should not count, wrong extension.\n")

            graph = build_note_graph.build_note_import_graph(root)
            self.assertEqual(graph.number_of_nodes(), 2)


class BuildNoteGraphDataTest(unittest.TestCase):
    def test_isolated_notes_are_excluded_from_the_returned_graph(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "A.md").write_text("Links to [[B]].\n")
            (root / "B.md").write_text("Links to [[A]].\n")
            (root / "Isolated.md").write_text("No wikilinks at all.\n")

            result = build_note_graph.build_note_graph_data(root, progress=lambda *a: None)
            node_ids = {n["id"] for n in result["graph"]["nodes"]}
            self.assertIn("A.md", node_ids)
            self.assertIn("B.md", node_ids)
            self.assertNotIn("Isolated.md", node_ids)

    def test_no_linked_notes_at_all_returns_an_empty_graph(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "A.md").write_text("No links.\n")
            (root / "B.md").write_text("Also no links.\n")

            result = build_note_graph.build_note_graph_data(root, progress=lambda *a: None)
            self.assertEqual(result, {"graph": {"nodes": [], "links": []}, "coverage": {"communities": []}})

    def test_linked_notes_are_returned_in_the_same_shape_as_build_graph_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "A.md").write_text("Links to [[B]].\n")
            (root / "B.md").write_text("Links to [[A]].\n")

            result = build_note_graph.build_note_graph_data(root, progress=lambda *a: None)
            self.assertEqual(set(result.keys()), {"graph", "coverage"})
            self.assertEqual(set(result["graph"].keys()), {"nodes", "links"})
            node = result["graph"]["nodes"][0]
            self.assertEqual(set(node.keys()), {"id", "community", "source_file"})
            community = result["coverage"]["communities"][0]
            self.assertEqual(set(community.keys()), {"id", "name", "lastReviewedAt", "lastCandidateCount"})

    def test_unchanged_community_reuses_its_old_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "A.md").write_text("Links to [[B]].\n")
            (root / "B.md").write_text("Links to [[A]].\n")

            old_graph_nodes = [
                {"id": "A.md", "community": 0, "source_file": "A.md"},
                {"id": "B.md", "community": 0, "source_file": "B.md"},
            ]
            old_coverage = {"communities": [
                {"id": 0, "name": "Existing Real Name", "lastReviewedAt": None, "lastCandidateCount": -1},
            ]}

            result = build_note_graph.build_note_graph_data(
                root, progress=lambda *a: None,
                old_coverage=old_coverage, old_graph_nodes=old_graph_nodes,
            )
            self.assertEqual(result["coverage"]["communities"][0]["name"], "Existing Real Name")


if __name__ == "__main__":
    unittest.main()
