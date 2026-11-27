"""Source-assertion test: the shared .path-row rule lets wide Project-tab children shrink and wrap.

This reads source text only. It does NOT measure layout; a browser probe of the Project tab is
required to confirm the overflow finding is gone.
"""
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
INDEX_HTML = REPO / 'python' / 'dashboard' / 'templates' / 'index.html'
PROJECT_TAB_JS = REPO / 'python' / 'dashboard' / 'static' / 'js' / 'project-tab.js'


def _rule_body(css, selector):
    # selector is the bare selector text (no brace); matches `selector { ... }`.
    m = re.search(re.escape(selector) + r'\s*\{([^}]*)\}', css)
    return m.group(1) if m else None


class ProjectTabOverflowTest(unittest.TestCase):
    def setUp(self):
        self.css = INDEX_HTML.read_text(encoding='utf-8')
        self.js = PROJECT_TAB_JS.read_text(encoding='utf-8')

    def test_path_row_rule_wraps_and_can_shrink(self):
        body = _rule_body(self.css, '.path-row')
        self.assertIsNotNone(body, '.path-row rule missing from index.html')
        self.assertIn('flex-wrap: wrap', body)
        self.assertIn('min-width: 0', body)

    def test_path_row_children_can_shrink(self):
        body = _rule_body(self.css, '.path-row > *')
        self.assertIsNotNone(body, '.path-row > * rule missing from index.html')
        self.assertIn('min-width: 0', body)
        self.assertIn('max-width: 100%', body)

    def test_project_tab_still_appends_danger_button_to_path_row(self):
        self.assertIn("document.querySelector('.path-row').appendChild(startBtn)", self.js)

    def test_no_inline_width_added_to_start_button(self):
        self.assertNotRegex(self.js, r"start-pipeline-btn[^;]*style\.width")
        self.assertNotRegex(self.js, r"startBtn\.style\.width")

    def test_changed_rules_have_no_font_size_below_12px(self):
        for sel in ('.path-row', '.path-row > *'):
            body = _rule_body(self.css, sel) or ''
            for m in re.finditer(r'font-size:\s*(\d+)px', body):
                self.assertGreaterEqual(int(m.group(1)), 12, sel)


if __name__ == '__main__':
    unittest.main()
