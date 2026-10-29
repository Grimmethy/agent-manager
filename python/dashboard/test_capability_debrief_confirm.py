"""Confirming a held debrief report stamps debriefReportConfirmedAt for both debrief sources (capability_debrief reuses pipeline_debrief's second-pass gate)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


class TestDebriefConfirmStamp(unittest.TestCase):
    def setUp(self):
        self.q = Path(tempfile.mkdtemp()) / "queue"
        p = mock.patch.object(app, "queue_dir", return_value=self.q)
        p.start()
        self.addCleanup(p.stop)
        self.client = app.app.test_client()

    def confirm(self, source):
        d = self.q / "awaiting-confirm"
        d.mkdir(parents=True, exist_ok=True)
        (d / "t1.json").write_text(json.dumps({"id": "t1", "source": source}))
        r = self.client.post("/api/task/awaiting-confirm/t1/confirm")
        self.assertEqual(r.status_code, 200)
        return json.loads((self.q / "approved" / "t1.json").read_text())

    def test_capability_debrief_gets_the_debrief_stamp(self):
        self.assertIn("debriefReportConfirmedAt", self.confirm("capability_debrief"))

    def test_pipeline_debrief_still_gets_it_and_other_sources_do_not(self):
        self.assertIn("debriefReportConfirmedAt", self.confirm("pipeline_debrief"))
        (self.q / "approved" / "t1.json").unlink()
        self.assertNotIn("debriefReportConfirmedAt", self.confirm("arch_review"))


if __name__ == "__main__":
    unittest.main()
