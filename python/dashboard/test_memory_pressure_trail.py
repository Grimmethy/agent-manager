"""The memory-pressure data trail (memory_pressure_trail.py and GET /api/triggers/memory-pressure): the gpu-broker journal folded into episodes, offenders and a daily view.

Run from python/dashboard: .venv/bin/python -B -m unittest test_memory_pressure_trail
"""
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import memory_pressure_fold as fold_mod  # noqa: E402
import memory_pressure_trail as trail  # noqa: E402

NOW = datetime.now(timezone.utc).replace(microsecond=0)


QEMU = "/usr/bin/qemu-system-x86_64 -name guest=p40-passthrough,debug-threads=on -S"
OLLAMA = "/usr/local/lib/ollama/llama-server --model /m"
CLAUDE = "claude"


class Fx:
    """Fixture helpers (static, so the size ratchet does not read top-level functions as running to the end of the file)."""

    @staticmethod
    def at(minutes):
        return (NOW - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


    @staticmethod
    def nums(avail, swap=100):
        return {"available_mb": avail, "swap_free_mb": swap, "swap_total_mb": 6143, "mem_some": 1.0, "mem_full": 0.0, "io_some": 2.0, "io_full": 0.0}


    @staticmethod
    def top(*procs):
        return [{"pid": 100 + i, "rss_mb": mb, "cmd": cmd} for i, (cmd, mb) in enumerate(procs)]




    @staticmethod
    def journal_lines():
        return [
            {"at": at(30000), "kind": "relief", "event": "pause", "mode": "dry-run", "state": "tight", "reason": "swap low (0 MB free)", "numbers": nums(3000), "top": top((QEMU, 4000))},  # outside 14 days
            {"at": at(300), "kind": "relief", "event": "pause", "mode": "dry-run", "state": "tight", "reason": "swap low (0 MB free)", "available_before_mb": 3800, "numbers": nums(3800, 0),
             "top": top((QEMU, 4100), (OLLAMA, 3000), (CLAUDE, 500))},
            {"at": at(295), "kind": "relief", "event": "resume", "mode": "dry-run", "pause_s": 300.0, "refused": 0},
            {"at": at(200), "kind": "relief", "event": "pause", "mode": "dry-run", "state": "tight", "reason": "memory stall 12.5%", "available_before_mb": 2500, "numbers": nums(2500, 50),
             "top": top((QEMU, 4200), ("/usr/bin/node /x/src/foo.js --flag", 900))},
            {"at": at(199), "kind": "state", "from": "tight", "to": "critical", "reason": "x", "numbers": nums(1200, 5), "via": "trigger"},
            {"at": at(198), "kind": "relief", "event": "would-refuse", "owner": "comfyui", "state": "critical"},
            {"at": at(197), "kind": "relief", "event": "would-refuse", "owner": "pf", "state": "critical"},
            {"at": at(196), "kind": "state", "from": "critical", "to": "tight", "reason": "y", "numbers": nums(1800, 20), "via": "trigger"},
            {"at": at(190), "kind": "relief", "event": "pause", "mode": "dry-run", "state": "tight", "reason": "ignored second pause", "numbers": nums(1), "top": top(("ignored", 1))},
            {"at": at(180), "kind": "relief", "event": "resume", "mode": "dry-run", "pause_s": 1200.0, "refused": 2},
            {"at": at(30), "kind": "relief", "event": "pause", "mode": "dry-run", "state": "critical", "reason": "swap nearly gone (5 MB free) with 4042 MB available", "numbers": nums(4042, 5),
             "top": top((QEMU, 4100), (OLLAMA, 2800), (CLAUDE, 450))},
        ]


at, nums, top, journal_lines = Fx.at, Fx.nums, Fx.top, Fx.journal_lines


class TrailBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = os.path.join(self._tmp.name, "journal.jsonl")
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("{not json\n[1, 2]\n" + json.dumps({"kind": "state", "numbers": nums(1)}) + "\n")  # corrupt, non-dict, no `at`
            for e in journal_lines():
                fh.write(json.dumps(e) + "\n")

    def folded(self, days=14):
        entries, truncated = trail.read_entries(self.path, since_ts=time.time() - days * 86400)
        return fold_mod.fold(entries), truncated


class TestFold(TrailBase):
    def test_episodes_have_every_field(self):
        (f, truncated) = self.folded()
        self.assertFalse(truncated)
        first, second, third = f["episodes"]
        self.assertEqual((first["pause_s"], first["open"], first["level"], first["state_changes"], first["refused"]), (300.0, False, "tight", 0, 0))
        self.assertEqual((first["end"], first["available_before_mb"], first["min_available_mb"], first["min_swap_free_mb"]), (at(295), 3800, 3800, 0))
        self.assertEqual([(p["label"], p["rss_mb"]) for p in first["top"]], [("qemu:p40-passthrough", 4100), ("llama-server", 3000), ("claude", 500)])
        self.assertEqual((second["level"], second["state_changes"], second["refused"], second["pause_s"], second["min_available_mb"], second["min_swap_free_mb"]), ("critical", 2, 2, 1200.0, 1200, 5))
        self.assertEqual((second["top"][1]["label"], second["reason"]), ("node foo.js", "memory stall 12.5%"))
        self.assertEqual((third["open"], third["end"], third["pause_s"], third["level"]), (True, None, None, "critical"))
        self.assertNotIn("_start", first)

    def test_a_second_pause_without_a_resume_is_ignored(self):
        (f, _) = self.folded()
        self.assertNotIn("ignored", [p["label"] for ep in f["episodes"] for p in ep["top"]])
        self.assertEqual(len(f["episodes"]), 3)

    def test_summary(self):
        (f, _) = self.folded()
        s = f["summary"]
        self.assertEqual((s["episodes"], s["open"], s["total_pause_s"], s["longest_pause_s"], s["refused_total"]), (3, 1, 1500.0, 1200.0, 2))
        self.assertEqual(s["by_level"], {"tight": 1, "critical": 2})
        self.assertEqual(s["min_available_mb"], 1)
        reasons = {r["reason"]: r["count"] for r in s["reasons"]}
        self.assertEqual(reasons["swap low (N MB free)"], 1)
        self.assertEqual(reasons["memory stall N%"], 1)
        self.assertEqual(sum(d["episodes"] for d in s["by_day"]), 3)
        self.assertEqual(s["by_day"], sorted(s["by_day"], key=lambda d: d["day"]))
        offenders = {o["label"]: o for o in s["top_offenders"]}
        self.assertEqual((offenders["qemu:p40-passthrough"]["episodes"], offenders["qemu:p40-passthrough"]["share"], offenders["qemu:p40-passthrough"]["max_rss_mb"]), (3, 1.0, 4200))
        self.assertEqual(offenders["qemu:p40-passthrough"]["avg_rss_mb"], round((4100 + 4200 + 4100) / 3, 1))
        self.assertEqual((offenders["llama-server"]["episodes"], offenders["llama-server"]["share"]), (2, 0.667))
        self.assertEqual([o["label"] for o in s["top_offenders"]][:2], ["qemu:p40-passthrough", "llama-server"])

    def test_the_window_drops_old_entries(self):
        (f, _) = self.folded(days=1)
        self.assertEqual(len(f["episodes"]), 3)
        entries, _ = trail.read_entries(self.path, since_ts=time.time() - 2 * 3600)
        self.assertEqual(len(fold_mod.fold(entries)["episodes"]), 1)

    def test_a_tiny_read_drops_the_partial_first_line(self):
        entries, truncated = trail.read_entries(self.path, since_ts=0, max_bytes=700)
        self.assertTrue(truncated)
        self.assertTrue(entries)
        self.assertTrue(all("kind" in e for e in entries))
        self.assertEqual(entries[-1]["event"], "pause")

    def test_a_missing_file_is_empty(self):
        self.assertEqual(trail.read_entries(os.path.join(self._tmp.name, "nope.jsonl")), ([], False))
        s = fold_mod.fold([])["summary"]
        self.assertEqual((s["episodes"], s["total_pause_s"], s["min_available_mb"], s["top_offenders"], s["by_day"]), (0, 0, None, [], []))


class TestProcessLabel(unittest.TestCase):
    def test_labels(self):
        cases = {"/usr/bin/node /x/src/foo.js": "node foo.js", "/m/.venv/bin/python app.py --port 1": "python app.py", "python3 -m http.server": "python3 http.server",
                 OLLAMA: "llama-server", QEMU: "qemu:p40-passthrough", "/usr/bin/qemu-system-x86_64 -S": "qemu-system-x86_64", "bash": "bash", "": "(unknown)", None: "(unknown)", "claude": "claude"}
        for cmd, label in cases.items():
            self.assertEqual(trail.process_label(cmd), label, cmd)


class TestRoute(TrailBase):
    def get(self, query=""):
        with mock.patch.dict(os.environ, {"MEM_RELIEF_JOURNAL": self.path}):
            return app.app.test_client().get("/api/triggers/memory-pressure" + query)

    def test_newest_first_and_the_summary(self):
        body = self.get().get_json()
        self.assertEqual(self.get().status_code, 200)
        self.assertEqual((body["days"], body["source"]["exists"], body["source"]["truncated"]), (14, True, False))
        self.assertEqual([e["start"] for e in body["episodes"]], sorted((e["start"] for e in body["episodes"]), reverse=True))
        self.assertEqual(body["summary"]["episodes"], 3)

    def test_days_are_clamped_and_a_bad_value_falls_back(self):
        self.assertEqual(self.get("?days=0").get_json()["days"], 1)
        self.assertEqual(self.get("?days=999").get_json()["days"], 90)
        self.assertEqual(self.get("?days=abc").get_json()["days"], 14)

    def test_a_missing_journal_answers_200_with_an_empty_trail(self):
        os.remove(self.path)
        resp = self.get()
        body = resp.get_json()
        self.assertEqual((resp.status_code, body["source"]["exists"], body["episodes"], body["summary"]["episodes"]), (200, False, [], 0))

    def test_only_get_is_allowed(self):
        self.assertEqual(app.app.test_client().post("/api/triggers/memory-pressure").status_code, 405)


if __name__ == "__main__":
    unittest.main()
