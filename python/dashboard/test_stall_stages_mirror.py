"""Guard: the Python STALL_STAGES mirror must equal src/queue-events.js STALL_STAGES, in order.

queue_events.py says its STALL_STAGES is copied verbatim from src/queue-events.js. Nothing enforced that claim before this test.
Run from the repository root:  python3 -m pytest python/dashboard/test_stall_stages_mirror.py
"""
import re
import sys
import unittest
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parent
REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(DASHBOARD))

import queue_events  # noqa: E402

JS_PATH = REPO / "src" / "queue-events.js"


def js_stall_stages():
    text = JS_PATH.read_text(encoding="utf-8")
    m = re.search(r"const\s+STALL_STAGES\s*=\s*\[(.*?)\]\s*;", text, re.S)
    if not m:
        raise AssertionError("no const STALL_STAGES = [...] array found in src/queue-events.js")
    return re.findall(r"'([^']*)'", m.group(1))


class StallStagesMirror(unittest.TestCase):
    def test_js_array_parses_non_empty(self):
        self.assertTrue(js_stall_stages(), "parsed an empty STALL_STAGES from src/queue-events.js")

    def test_python_mirror_equals_js_in_order(self):
        self.assertEqual(list(queue_events.STALL_STAGES), js_stall_stages())


if __name__ == "__main__":
    unittest.main()
