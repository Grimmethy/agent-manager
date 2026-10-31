"""HUB0280-05: discard_stats.py --compute prices discarded / merged / needs-work branches from <pipeline>/model-stats.db.

Every fixture is a temp directory; the script's CORE constant is pointed at a missing path so the live core pipeline is never read.
Run: python3 -m unittest discover -s python -p 'test_discard_stats_compute.py'
"""
import contextlib, importlib.util, io, json, os, sqlite3, sys, tempfile, unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "agents", "skills", "verify-unmerged-branches", "scripts", "discard_stats.py")

# What the script printed for FIXTURE_STORE with `--causes` BEFORE --compute existed (captured from the original script).
EXPECTED_PLAIN = """verdicts counted: 4
  decompose          n=   1  discard=100%  merge=0%  needs-work=0%
  brain-dump adhoc   n=   2  discard=50%  merge=50%  needs-work=0%
  other              n=   1  discard=0%  merge=100%  needs-work=0%
discard causes (all families):
     1 duplicate / superseded
     1 inert / nothing consumes it
"""


def verdict(v, reasons=()):
    return {"abc123": {"verdict": v, "source": "chat", "verifiedAt": "2026-10-30T10:00:00Z", "reasons": list(reasons)}}


FIXTURE_STORE = {
    "agent/adhoc-brain-dump-one": verdict("discard", ["duplicate of master"]),
    "agent/adhoc-brain-dump-two": verdict("merge"),
    "agent/decompose-parent-1": verdict("discard", ["inert"]),
    "agent/other-thing": verdict("merge"),
}

FULL_SCHEMA = "CREATE TABLE model_calls (call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT, model TEXT, started_at TEXT, latency_ms INTEGER, prompt_eval_count INTEGER, eval_count INTEGER)"


def load_module():
    spec = importlib.util.spec_from_file_location("discard_stats_under_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.CORE = os.path.join(tempfile.gettempdir(), "no-such-core-pipeline")
    return mod


def make_root(store, rows=None, schema=FULL_SCHEMA):
    root = tempfile.mkdtemp(prefix="discard-stats-")
    pdir = os.path.join(root, "x-pipeline")
    os.makedirs(os.path.join(pdir, "queue"))
    json.dump(store, open(os.path.join(pdir, "queue", "branch-verdicts.json"), "w"))
    if rows is not None:
        con = sqlite3.connect(os.path.join(pdir, "model-stats.db"))
        con.execute(schema)
        for r in rows:
            con.execute(f"INSERT INTO model_calls ({','.join(r)}) VALUES ({','.join('?' * len(r))})", list(r.values()))
        con.commit(); con.close()
    return root


def call(task_id, ms, p, e, n=0):
    return {"call_id": f"{task_id}-{n}-{ms}", "task_id": task_id, "stage": "plan", "model": "m", "started_at": "x", "latency_ms": ms, "prompt_eval_count": p, "eval_count": e}


def run(mod, root, *argv):
    out = io.StringIO()
    old = sys.argv
    sys.argv = ["discard_stats.py", "--root", root, *argv]
    try:
        with contextlib.redirect_stdout(out):
            mod.main()
    finally:
        sys.argv = old
    return out.getvalue()


class ComputeTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()

    def test_discarded_and_merged_branches_are_priced_from_their_task_calls(self):
        rows = [call("adhoc-brain-dump-one", 3_600_000, 2_000_000, 500_000), call("adhoc-brain-dump-one", 1_800_000, 1_000_000, 100_000, 1),
                call("adhoc-brain-dump-two", 7_200_000, 4_000_000, 300_000)]
        out = json.loads(run(self.mod, make_root(FIXTURE_STORE, rows), "--compute", "--json"))
        bd = out["compute"]["brain-dump adhoc"]
        self.assertEqual(bd["discard"]["matched"], 1)
        self.assertEqual(bd["discard"]["calls"], 2)
        self.assertEqual(bd["discard"]["model_hours"], 1.5)
        self.assertEqual(bd["discard"]["prompt_tokens_m"], 3.0)
        self.assertEqual(bd["discard"]["eval_tokens_m"], 0.6)
        self.assertEqual(bd["discard"]["avg_model_hours"], 1.5)
        self.assertEqual(bd["merge"]["model_hours"], 2.0)
        self.assertEqual(bd["merge"]["prompt_tokens_m"], 4.0)

    def test_a_decompose_branch_matches_its_parent_task_id(self):
        rows = [call("parent-1", 3_600_000, 1_000_000, 100_000)]
        out = json.loads(run(self.mod, make_root(FIXTURE_STORE, rows), "--compute", "--json"))
        d = out["compute"]["decompose"]["discard"]
        self.assertEqual(d["matched"], 1)
        self.assertEqual(d["calls"], 1)
        self.assertEqual(d["model_hours"], 1.0)

    def test_a_branch_with_no_recorded_calls_is_counted_unmatched(self):
        rows = [call("adhoc-brain-dump-one", 3_600_000, 1, 1)]
        out = json.loads(run(self.mod, make_root(FIXTURE_STORE, rows), "--compute", "--json"))
        self.assertEqual(out["compute"]["brain-dump adhoc"]["merge"]["matched"], 0)
        self.assertEqual(out["compute"]["brain-dump adhoc"]["merge"]["unmatched"], 1)
        self.assertEqual(out["compute"]["other"]["merge"]["unmatched"], 1)
        self.assertEqual(out["compute"]["other"]["merge"]["avg_model_hours"], 0)

    def test_a_pipeline_without_a_database_is_skipped_not_fatal(self):
        out = json.loads(run(self.mod, make_root(FIXTURE_STORE), "--compute", "--json"))
        self.assertEqual(out["compute"]["decompose"]["discard"]["unmatched"], 1)
        self.assertEqual(out["compute"]["decompose"]["discard"]["calls"], 0)

    def test_a_corrupt_database_file_is_skipped_not_fatal(self):
        root = make_root(FIXTURE_STORE)
        open(os.path.join(root, "x-pipeline", "model-stats.db"), "w").write("this is not a sqlite database")
        out = json.loads(run(self.mod, root, "--compute", "--json"))
        self.assertEqual(out["compute"]["decompose"]["discard"]["unmatched"], 1)

    def test_an_old_database_without_token_columns_still_prices_time(self):
        old = "CREATE TABLE model_calls (call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT, model TEXT, started_at TEXT, latency_ms INTEGER)"
        rows = [{"call_id": "c1", "task_id": "adhoc-brain-dump-one", "stage": "plan", "model": "m", "started_at": "x", "latency_ms": 3_600_000}]
        out = json.loads(run(self.mod, make_root(FIXTURE_STORE, rows, schema=old), "--compute", "--json"))
        r = out["compute"]["brain-dump adhoc"]["discard"]
        self.assertEqual(r["model_hours"], 1.0)
        self.assertEqual(r["prompt_tokens_m"], 0)

    def test_text_output_lists_the_compute_table(self):
        rows = [call("adhoc-brain-dump-one", 3_600_000, 1_000_000, 100_000)]
        text = run(self.mod, make_root(FIXTURE_STORE, rows), "--compute")
        self.assertIn("compute (model_calls joined", text)
        self.assertRegex(text, r"brain-dump adhoc\s+discard\s+matched=\s*1")

    def test_output_without_the_flag_is_unchanged_even_when_a_database_exists(self):
        rows = [call("adhoc-brain-dump-one", 3_600_000, 1_000_000, 100_000)]
        text = run(self.mod, make_root(FIXTURE_STORE, rows), "--causes")
        self.assertEqual(text, EXPECTED_PLAIN)
        self.assertNotIn("compute", json.loads(run(self.mod, make_root(FIXTURE_STORE, rows), "--json")))


if __name__ == "__main__":
    unittest.main()
