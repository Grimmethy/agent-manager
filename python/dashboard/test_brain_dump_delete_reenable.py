"""Covering test for the [data-delete] handler in static/js/brain-dump-and-second-brain.js.

The delete button must be re-enabled when its request fails, matching the prioritize,
reopen and save handlers. The JS is read as text, since there is no JS test harness here.

Run: python3 -I python/dashboard/test_brain_dump_delete_reenable.py
"""
import unittest
from pathlib import Path

JS = Path(__file__).parent / "static" / "js" / "brain-dump-and-second-brain.js"


class TestBrainDumpDeleteReenable(unittest.TestCase):
    def setUp(self):
        self.src = JS.read_text(encoding="utf-8")

    def _delete_block(self):
        start = self.src.index("querySelectorAll('[data-delete]')")
        end = self.src.index("querySelectorAll('[data-reopen]')", start)
        return self.src[start:end]

    def test_catch_reenables_delete_button(self):
        block = self._delete_block()
        catch = block[block.index("catch (e)"):]
        self.assertIn("btn.disabled = false", catch)

    def test_delete_block_adds_no_timers(self):
        self.assertNotRegex(self._delete_block(), r"setInterval|setTimeout")


if __name__ == "__main__":
    unittest.main()
