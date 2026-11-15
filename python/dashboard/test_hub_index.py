import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hub_index  # noqa: E402

try:
    import app  # noqa: E402
except ModuleNotFoundError:      # a bare interpreter without Flask (the review sandbox): the app-level tests below skip, the index tests still run
    app = None


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


class Tree(unittest.TestCase):
    def setUp(self):
        hub_index.reset()
        self.addCleanup(hub_index.reset)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = Path(self.tmp.name)
        self.clock = 1_700_000_000

    def put(self, rel, data, raw=None):
        path = self.q / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(raw if raw is not None else json.dumps(data), encoding="utf-8")
        self.clock += 10
        os.utime(path, (self.clock, self.clock))
        return path

    def hub(self, hid, branch=None, subs=()):
        return {"id": hid, "title": f"hub {hid}", "branch": branch, "subTasks": [{"id": s, "status": "pending"} for s in subs]}

    def find(self, branch, ids=()):
        hit = hub_index.lookup(self.q, branch, list(ids), read_json)
        return (hit[0]["id"], hit[1]) if hit else None


class Lookup(Tree):
    def test_matches_a_hub_by_its_branch_field_and_by_a_sub_task_id(self):
        self.put("coordinating/a.json", self.hub("A", branch="agent/decompose-a", subs=["A-01"]))
        self.put("coordinating/b.json", self.hub("B", subs=["B-01", "B-02"]))
        self.assertEqual(self.find("agent/decompose-a"), ("A", "coordinating"))
        self.assertEqual(self.find("agent/x", ["B-02"]), ("B", "coordinating"))
        self.assertIsNone(self.find("agent/none", ["nope"]))

    def test_the_state_comes_from_the_folder_and_only_hub_named_files_in_done_count(self):
        self.put("done/x-hub-1.json", self.hub("D1", branch="agent/d1"))
        self.put("done/file-decompose-hub-2.json", self.hub("D2", branch="agent/d2"))      # also matches *-hub-*.json
        self.put("done/plain-task.json", self.hub("D3", branch="agent/d3"))
        self.put("done/_superseded/old-hub-9.json", self.hub("S9", branch="agent/s9"))
        self.put("done/_superseded/old-task.json", self.hub("S8", branch="agent/s8"))
        self.assertEqual(self.find("agent/d1"), ("D1", "done"))
        self.assertEqual(self.find("agent/d2"), ("D2", "done"))
        self.assertIsNone(self.find("agent/d3"))
        self.assertEqual(self.find("agent/s9"), ("S9", "superseded"))
        self.assertIsNone(self.find("agent/s8"))

    def test_the_earliest_file_wins_even_when_it_matches_by_task_id_and_a_later_one_by_branch(self):
        self.put("coordinating/a.json", self.hub("A", subs=["T-1"]))
        self.put("coordinating/b.json", self.hub("B", branch="agent/t"))
        first = [Path(p).stem.upper() for p, _s, _k in hub_index.scan(self.q)][0]      # the folder's directory order decides, as it did for the old scan
        self.assertEqual(self.find("agent/t", ["T-1"]), (first, "coordinating"))
        self.assertEqual(self.find("agent/t", []), ("B", "coordinating"))
        self.assertEqual(self.find("agent/x", ["T-1"]), ("A", "coordinating"))

    def test_coordinating_beats_done_and_done_beats_superseded(self):
        self.put("done/_superseded/s-hub.json", self.hub("S", branch="agent/z"))
        self.put("done/z-hub-1.json", self.hub("D", branch="agent/z"))
        self.assertEqual(self.find("agent/z"), ("D", "done"))
        self.put("coordinating/c.json", self.hub("C", branch="agent/z"))
        self.assertEqual(self.find("agent/z"), ("C", "coordinating"))

    def test_unreadable_empty_and_non_object_records_are_skipped(self):
        self.put("coordinating/a.json", None, raw="{not json")
        self.put("coordinating/b.json", {})
        self.put("coordinating/c.json", None, raw="[1, 2]")
        self.put("coordinating/d.json", self.hub("D", branch="agent/d"))
        self.assertEqual(self.find("agent/d"), ("D", "coordinating"))

    def test_a_missing_queue_or_folder_answers_none(self):
        self.assertIsNone(self.find("agent/x"))
        self.assertIsNone(hub_index.lookup(self.q / "nowhere", "agent/x", [], read_json))

    def test_a_sub_task_that_is_not_an_object_and_an_unhashable_id_do_not_break_the_index(self):
        self.put("coordinating/a.json", {"id": "A", "subTasks": ["str", 5, {"id": ["list"]}, {"id": "A-1"}]})
        self.assertEqual(self.find("agent/x", ["A-1"]), ("A", "coordinating"))
        self.assertIsNone(self.find("agent/x", [["list"]]))


class Freshness(Tree):
    def test_an_unchanged_tree_is_parsed_once_however_many_lookups(self):
        for i in range(5):
            self.put(f"coordinating/h{i}.json", self.hub(f"H{i}", branch=f"agent/h{i}"))
        for _ in range(20):
            self.find("agent/h3")
            self.find("agent/none")
        self.assertEqual(hub_index.stats()["parses"], 5)
        self.assertEqual(hub_index.stats()["builds"], 1)

    def test_a_changed_file_is_parsed_again_and_the_others_are_not(self):
        a = self.put("coordinating/a.json", self.hub("A", branch="agent/a"))
        self.put("coordinating/b.json", self.hub("B", branch="agent/b"))
        self.find("agent/a")
        self.assertEqual(hub_index.stats()["parses"], 2)
        data = self.hub("A", branch="agent/a2")
        a.write_text(json.dumps(data) + " ", encoding="utf-8")
        self.clock += 10
        os.utime(a, (self.clock, self.clock))
        self.assertIsNone(self.find("agent/a"))
        self.assertEqual(self.find("agent/a2"), ("A", "coordinating"))
        self.assertEqual(hub_index.stats()["parses"], 3)

    def test_a_same_size_rewrite_is_seen_through_the_modification_time(self):
        a = self.put("coordinating/a.json", self.hub("A", branch="agent/aa"))
        self.assertEqual(self.find("agent/aa"), ("A", "coordinating"))
        a.write_text(json.dumps(self.hub("A", branch="agent/bb")), encoding="utf-8")
        self.clock += 10
        os.utime(a, (self.clock, self.clock))
        self.assertEqual(self.find("agent/bb"), ("A", "coordinating"))
        self.assertIsNone(self.find("agent/aa"))

    def test_a_longer_rewrite_with_the_same_modification_time_is_seen_through_the_size(self):
        a = self.put("coordinating/a.json", self.hub("A", branch="agent/aa"))
        before = a.stat().st_mtime_ns
        self.assertEqual(self.find("agent/aa"), ("A", "coordinating"))
        a.write_text(json.dumps(self.hub("A", branch="agent/bb-longer")), encoding="utf-8")
        os.utime(a, ns=(before, before))
        self.assertEqual(self.find("agent/bb-longer"), ("A", "coordinating"))

    def test_an_added_and_a_removed_file_are_seen(self):
        self.assertIsNone(self.find("agent/n"))
        path = self.put("coordinating/n.json", self.hub("N", branch="agent/n"))
        self.assertEqual(self.find("agent/n"), ("N", "coordinating"))
        path.unlink()
        self.assertIsNone(self.find("agent/n"))

    def test_a_file_that_could_not_be_read_is_tried_again_when_it_changes(self):
        path = self.put("coordinating/a.json", None, raw="{broken")
        self.assertIsNone(self.find("agent/a"))
        path.write_text(json.dumps(self.hub("A", branch="agent/a")), encoding="utf-8")
        self.clock += 10
        os.utime(path, (self.clock, self.clock))
        self.assertEqual(self.find("agent/a"), ("A", "coordinating"))

    def test_each_project_queue_has_its_own_index(self):
        self.put("coordinating/a.json", self.hub("A", branch="agent/a"))
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        (Path(other.name) / "coordinating").mkdir()
        (Path(other.name) / "coordinating" / "x.json").write_text(json.dumps(self.hub("X", branch="agent/a")))
        self.assertEqual(self.find("agent/a"), ("A", "coordinating"))
        self.assertEqual(hub_index.lookup(Path(other.name), "agent/a", [], read_json)[0]["id"], "X")
        for _ in range(5):                                   # alternating between projects must not rebuild either index
            self.find("agent/a")
            hub_index.lookup(Path(other.name), "agent/a", [], read_json)
        self.assertEqual(hub_index.stats()["builds"], 2)
        self.assertEqual(hub_index.stats()["projects"], 2)

    def test_the_switch_reads_off_only_for_false(self):
        for value, expected in (("false", False), ("FALSE", False), ("", True), ("true", True), ("0", True)):
            with mock.patch.dict(os.environ, {"AGENT_MANAGER_HUB_INDEX": value}):
                self.assertEqual(hub_index.enabled(), expected, value)


@unittest.skipIf(app is None, "Flask is not installed")
class SameAnswersAsTheOldScan(Tree):
    """_hub_for_branch answers identically with the index and with the old file scan."""

    def ask(self, branch, ids):
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_HUB_INDEX": "true"}):
            fast = app._hub_for_branch(self.q, branch, ids)
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_HUB_INDEX": "false"}):
            slow = app._hub_for_branch(self.q, branch, ids)
        return fast, slow

    def test_every_branch_and_task_id_of_a_mixed_tree_gets_the_same_answer(self):
        self.put("coordinating/a.json", self.hub("A", branch="agent/decompose-a", subs=["A-01", "A-02"]))
        self.put("coordinating/b.json", self.hub("B", subs=["B-01", "T-9"]))
        self.put("coordinating/c.json", self.hub("C", branch="agent/t-9", subs=["C-01", "T-9"]))
        self.put("done/q-hub-1.json", self.hub("D", branch="agent/d", subs=["D-01", "T-9"]))
        self.put("done/_superseded/z-hub.json", self.hub("S", subs=["S-01"]))
        self.put("coordinating/bad.json", None, raw="nope")
        probes = [("agent/decompose-a", []), ("agent/t-9", []), ("agent/t-9", ["T-9"]), ("agent/x", ["T-9"]), ("agent/x", ["T-9", "D-01"]), ("agent/x", ["B-01"]), ("agent/x", ["D-01"]), ("agent/x", ["S-01"]),
                  ("agent/x", ["A-02", "B-01"]), ("agent/d", ["B-01"]), ("agent/none", []), ("agent/none", ["zzz"])]
        for branch, ids in probes:
            fast, slow = self.ask(branch, ids)
            self.assertEqual(fast, slow, (branch, ids))
        self.assertEqual(self.ask("agent/t-9", [])[0]["id"], "C")
        self.assertIsNotNone(self.ask("agent/x", ["T-9"])[0])

    def test_no_queue_dir_answers_none(self):
        self.assertIsNone(app._hub_for_branch(None, "agent/x", []))


if __name__ == "__main__":
    unittest.main()
