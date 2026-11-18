# Drafting rglob scan of the adhoc-tasks view must skip non-task JSON without raising.
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import app as app_module  # noqa: E402

VALID_ID = "adhoc-valid-1"
ENDPOINT = "/api/adhoc-tasks"
MALFORMED_JSON_TEXT = '{"id": '


def valid_task_record():
    return {"id": VALID_ID, "title": "Valid adhoc task", "createdAt": "2026-11-01T00:00:00Z", "domain": "adhoc"}


def metadata_json():
    return {"generated_at": "2026-11-01T00:00:00Z"}


def top_level_array():
    return [1, 2]


class DraftingRglobTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.qdir = Path(tmp.name) / "queue"
        self.qdir.mkdir()
        self.drafting = self.qdir / "drafting"
        patcher = mock.patch.object(app_module, "queue_dir", lambda: self.qdir)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = app_module.app.test_client()

    def _write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def _write_json(self, path, payload):
        self._write(path, json.dumps(payload))

    def _tasks(self):
        resp = self.client.get(ENDPOINT)
        self.assertEqual(resp.status_code, 200)
        return resp.get_json()["tasks"]

    def _seed_tree(self):
        self._write_json(self.drafting / "worker-1" / f"{VALID_ID}.json", valid_task_record())
        self._write_json(self.drafting / "worker-1" / "metadata.json", metadata_json())
        self._write_json(self.drafting / "worker-1" / "list.json", top_level_array())
        self._write(self.drafting / "worker-2" / "broken.json", MALFORMED_JSON_TEXT)

    def test_only_valid_task_rows_returned(self):
        self._seed_tree()
        tasks = self._tasks()
        self.assertEqual([t["id"] for t in tasks], [VALID_ID])
        self.assertEqual(tasks[0]["state"], "drafting:worker-1")

    def test_non_task_json_does_not_raise(self):
        self._seed_tree()
        self._tasks()  # _tasks asserts HTTP 200

    def test_metadata_dict_alone_is_skipped(self):
        self._write_json(self.drafting / "worker-1" / "metadata.json", metadata_json())
        self.assertEqual(self._tasks(), [])

    def test_top_level_array_alone_is_skipped(self):
        self._write_json(self.drafting / "worker-1" / "list.json", top_level_array())
        self.assertEqual(self._tasks(), [])

    def test_malformed_json_alone_is_skipped(self):
        self._write(self.drafting / "worker-1" / "broken.json", MALFORMED_JSON_TEXT)
        self.assertEqual(self._tasks(), [])

    def test_adding_non_task_json_leaves_row_count_unchanged(self):
        self._seed_tree()
        before = len(self._tasks())
        self._write_json(self.drafting / "worker-1" / "nested" / "extra.json", {"generated_at": "2026-11-02"})
        self._write_json(self.drafting / "worker-3" / "notes.json", ["x"])
        after = len(self._tasks())
        self.assertEqual(before, 1)
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
