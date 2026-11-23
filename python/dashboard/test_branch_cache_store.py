"""Tests for python/dashboard/branch_cache_store.py.

Run: .venv/bin/python -m unittest python.dashboard.test_branch_cache_store -v
(from the repo root)
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import branch_cache_store as bcs  # noqa: E402


class _TmpDir:
    """Tiny context manager over ``tempfile.TemporaryDirectory`` that yields the directory path."""

    def __enter__(self):
        self._d = tempfile.TemporaryDirectory()
        return self._d.name

    def __exit__(self, *exc):
        self._d.cleanup()


class MissingFileCase(unittest.TestCase):
    def test_missing_path_returns_empty(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "no-such-file.json")
            self.assertEqual(bcs.load_cache(path), {})

    def test_missing_path_via_pathlib_returns_empty(self):
        with _TmpDir() as tmp:
            path = Path(tmp) / "nope.json"
            self.assertEqual(bcs.load_cache(path), {})


class CorruptJsonCase(unittest.TestCase):
    def test_truncated_json(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            Path(path).write_text('{"branches": [', encoding="utf-8")
            self.assertEqual(bcs.load_cache(path), {})

    def test_random_bytes(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            Path(path).write_bytes(b"\x00\x01\x02\x03")
            self.assertEqual(bcs.load_cache(path), {})

    def test_plain_text(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            Path(path).write_text("this is not json", encoding="utf-8")
            self.assertEqual(bcs.load_cache(path), {})


class WrongShapeCase(unittest.TestCase):
    def test_top_level_is_list(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            Path(path).write_text(json.dumps([1, 2, 3]), encoding="utf-8")
            self.assertEqual(bcs.load_cache(path), {})

    def test_top_level_is_string(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            Path(path).write_text(json.dumps("hello"), encoding="utf-8")
            self.assertEqual(bcs.load_cache(path), {})

    def test_top_level_is_number(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            Path(path).write_text(json.dumps(42), encoding="utf-8")
            self.assertEqual(bcs.load_cache(path), {})

    def test_entry_value_not_dict(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            Path(path).write_text(json.dumps({"r1": "not-a-dict"}), encoding="utf-8")
            result = bcs.load_cache(path)
            self.assertEqual(result, {})

    def test_entry_missing_branches_key(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            Path(path).write_text(json.dumps({"r1": {"held": []}}), encoding="utf-8")
            result = bcs.load_cache(path)
            self.assertEqual(result, {})

    def test_entry_missing_held_key(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            Path(path).write_text(json.dumps({"r1": {"branches": []}}), encoding="utf-8")
            result = bcs.load_cache(path)
            self.assertEqual(result, {})

    def test_branches_not_list(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            Path(path).write_text(json.dumps({"r1": {"branches": "x", "held": []}}), encoding="utf-8")
            result = bcs.load_cache(path)
            self.assertEqual(result, {})

    def test_held_not_list(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            Path(path).write_text(json.dumps({"r1": {"branches": [], "held": 1}}), encoding="utf-8")
            result = bcs.load_cache(path)
            self.assertEqual(result, {})


class RoundTripCase(unittest.TestCase):
    def test_round_trip(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            cache = {
                "/repo/a": {"branches": ["main", "dev"], "held": ["feat-x"]},
                "/repo/b": {"branches": ["master"], "held": []},
            }
            bcs.save_cache(path, cache)
            self.assertTrue(os.path.exists(path))
            loaded = bcs.load_cache(path)
            self.assertEqual(loaded, cache)

    def test_round_trip_multiple(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            cache = {
                "/r1": {"branches": ["a", "b"], "held": ["c"]},
                "/r2": {"branches": [], "held": ["d", "e"]},
                "/r3": {"branches": ["f"], "held": []},
            }
            bcs.save_cache(path, cache)
            self.assertEqual(bcs.load_cache(path), cache)


class TransientStateStrippedCase(unittest.TestCase):
    def test_error_key_stripped(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            cache = {
                "/r1": {"branches": ["main"], "held": [], "error": "boom", "retry": 3},
            }
            bcs.save_cache(path, cache)
            # Read raw file to confirm transient keys are absent
            raw = json.loads(Path(path).read_text())
            self.assertNotIn("error", raw["/r1"])
            self.assertNotIn("retry", raw["/r1"])
            self.assertEqual(raw["/r1"]["branches"], ["main"])
            self.assertEqual(raw["/r1"]["held"], [])

    def test_extra_transient_keys_stripped(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            cache = {
                "/r1": {"branches": ["x"], "held": ["y"], "ts": 123, "source": "hub"},
            }
            bcs.save_cache(path, cache)
            raw = json.loads(Path(path).read_text())
            self.assertEqual(set(raw["/r1"].keys()), {"branches", "held"})


class AtomicWriteCase(unittest.TestCase):
    def test_uses_mkstemp_and_os_replace(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            written_chunks: list[str] = []

            def fake_fdopen(fd, mode, encoding=None):
                class _Fake:
                    def __enter__(s):
                        return s
                    def __exit__(s, *a):
                        pass
                    def write(s, data):
                        written_chunks.append(data)
                return _Fake()

            with mock.patch("branch_cache_store.tempfile.mkstemp") as mkstemp, \
                    mock.patch("branch_cache_store.os.replace") as os_replace, \
                    mock.patch("branch_cache_store.os.fdopen", fake_fdopen):
                fd = 9999
                tmp_path = os.path.join(tmp, ".branch_cache.XXXXX.tmp")
                mkstemp.return_value = (fd, tmp_path)
                bcs.save_cache(path, {"/r1": {"branches": ["a"], "held": []}})
                mkstemp.assert_called_once_with(dir=tmp, prefix=".branch_cache.", suffix=".tmp")
                os_replace.assert_called_once_with(tmp_path, path)
                self.assertTrue(any("branches" in c for c in written_chunks))

    def test_temp_file_cleaned_up_on_failure(self):
        with _TmpDir() as tmp:
            path = os.path.join(tmp, "cache.json")
            tmp_path = os.path.join(tmp, ".branch_cache.ZZZZZ.tmp")
            # Create the temp file so we can verify it gets deleted
            Path(tmp_path).write_text("junk")
            with mock.patch("branch_cache_store.tempfile.mkstemp") as mkstemp, \
                    mock.patch("branch_cache_store.os.replace", side_effect=OSError("boom")):
                mkstemp.return_value = (3, tmp_path)
                with self.assertRaises(OSError):
                    bcs.save_cache(path, {"/r1": {"branches": ["a"], "held": []}})
            self.assertFalse(os.path.exists(tmp_path), "temp file should be cleaned up on failure")

    def test_no_temp_file_left_when_parent_missing(self):
        """mkstemp fails if parent dir doesn't exist; temp file must not be left behind."""
        with _TmpDir() as tmp:
            bad_parent = os.path.join(tmp, "no-such-subdir")
            path = os.path.join(bad_parent, "cache.json")
            with mock.patch("branch_cache_store.tempfile.mkstemp") as mkstemp:
                mkstemp.side_effect = FileNotFoundError("parent missing")
                with self.assertRaises(FileNotFoundError):
                    bcs.save_cache(path, {"/r1": {"branches": [], "held": []}})
                # mkstemp raised before returning a fd, so nothing to clean up -- check it didn't leak
                self.assertEqual(os.listdir(tmp), [])


class OSErrorLoadCase(unittest.TestCase):
    def test_oserror_on_read_returns_empty(self):
        """Force an OSError during open to confirm load_cache returns {}."""
        with mock.patch("builtins.open", side_effect=OSError("read failed")):
            result = bcs.load_cache("/any/path.json")
            self.assertEqual(result, {})


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
