import os
import sys
import tempfile
import unittest

# Make the module importable even under `python3 -I`, which ignores the script dir.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from managed_section import refresh_managed_section, write_if_changed  # noqa: E402

S = "# BEGIN managed"
E = "# END managed"


class TestRefreshManagedSection(unittest.TestCase):
    def test_no_markers_returns_input_byte_identical(self):
        text = "human line\r\nanother\r\n"
        self.assertEqual(refresh_managed_section(text, "new\n", S, E).encode(), text.encode())

    def test_lone_start_marker_raises(self):
        with self.assertRaises(ValueError):
            refresh_managed_section(f"a\n{S}\nb\n", "x\n", S, E)

    def test_lone_end_marker_raises(self):
        with self.assertRaises(ValueError):
            refresh_managed_section(f"a\n{E}\nb\n", "x\n", S, E)

    def test_reversed_markers_raise(self):
        with self.assertRaises(ValueError):
            refresh_managed_section(f"{E}\nold\n{S}\n", "x\n", S, E)

    def test_multiple_pairs_raise(self):
        text = f"{S}\n1\n{E}\nmid\n{S}\n2\n{E}\n"
        with self.assertRaises(ValueError):
            refresh_managed_section(text, "x\n", S, E)

    def test_single_pair_replaces_only_inner_span(self):
        text = f"before\n  {S}  \nold1\nold2\n{E}\nafter\n"
        out = refresh_managed_section(text, "new1\n", S, E)
        self.assertEqual(out, f"before\n  {S}  \nnew1\n{E}\nafter\n")

    def test_body_without_trailing_newline_is_terminated(self):
        text = f"{S}\nold\n{E}\n"
        self.assertEqual(refresh_managed_section(text, "new", S, E), f"{S}\nnew\n{E}\n")

    def test_idempotent(self):
        text = f"top\n{S}\nold\n{E}\nbottom\n"
        once = refresh_managed_section(text, "gen\nline\n", S, E)
        twice = refresh_managed_section(once, "gen\nline\n", S, E)
        self.assertEqual(twice, once)


class TestWriteIfChanged(unittest.TestCase):
    def test_identical_content_returns_false_and_leaves_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "f.txt")
            with open(p, "wb") as f:
                f.write(b"same\r\n")
            mtime = os.stat(p).st_mtime_ns
            self.assertFalse(write_if_changed(p, "same\r\n"))
            with open(p, "rb") as f:
                self.assertEqual(f.read(), b"same\r\n")
            self.assertEqual(os.stat(p).st_mtime_ns, mtime)

    def test_different_content_returns_true_and_writes(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "f.txt")
            with open(p, "wb") as f:
                f.write(b"old")
            self.assertTrue(write_if_changed(p, "new"))
            with open(p, "rb") as f:
                self.assertEqual(f.read(), b"new")

    def test_missing_file_is_created(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "new.txt")
            self.assertTrue(write_if_changed(p, "hi"))
            with open(p, "rb") as f:
                self.assertEqual(f.read(), b"hi")


if __name__ == "__main__":
    unittest.main()
