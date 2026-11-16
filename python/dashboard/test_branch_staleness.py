"""Tests for branch_staleness.py (pure stale-branch classifier). No I/O, no git: rows and
lookups are plain Python values and callables.

Run (from the repo root):
    python3 -m unittest discover -s python/dashboard -p "test_branch_staleness.py" -v

Mutation checks (each was applied to a scratch copy of branch_staleness.py and the suite
was run against it; the named test(s) must fail):

1. Boundary mutation: in classify_row, change `if behind < threshold:` to
   `if behind <= threshold:` (i.e. the candidate test `behind >= threshold` becomes
   `behind > threshold`). Caught by test_boundary_100_is_candidate, which expects behind == 100
   to be a candidate.

2. Human-source mutation: remove the `if row.get("source") in HUMAN_SOURCES:` exclusion so
   chat/manual rows are no longer excluded. Caught by test_chat_and_manual_are_excluded_as_human_source
   and test_excluded_owner_lists_human_rows.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import branch_staleness as bs  # noqa: E402

THRESHOLD = 100


def make_row(**overrides):
    row = {
        "branch": "agent/x",
        "taskId": "T1",
        "subject": "subject",
        "ahead": 0,
        "behind": 200,
        "hub": "H0001",
        "headSha": "abc123",
        "verdict": None,
        "source": "agent",
        "project": {"label": "proj"},
    }
    row.update(overrides)
    return row


def no_lookup(_key):
    return None


class StaleThresholdTests(unittest.TestCase):
    def test_unset_env_defaults_to_100(self):
        self.assertEqual(bs.stale_threshold({}), 100)

    def test_none_env_defaults_to_100(self):
        self.assertEqual(bs.stale_threshold(None), 100)

    def test_valid_integer_override_is_honored(self):
        self.assertEqual(bs.stale_threshold({bs.ENV_VAR: "250"}), 250)

    def test_override_is_stripped_before_parsing(self):
        self.assertEqual(bs.stale_threshold({bs.ENV_VAR: "  42 "}), 42)

    def test_non_integer_falls_back_to_100(self):
        self.assertEqual(bs.stale_threshold({bs.ENV_VAR: "abc"}), 100)
        self.assertEqual(bs.stale_threshold({bs.ENV_VAR: "12.5"}), 100)
        self.assertEqual(bs.stale_threshold({bs.ENV_VAR: ""}), 100)

    def test_zero_falls_back_to_100(self):
        self.assertEqual(bs.stale_threshold({bs.ENV_VAR: "0"}), 100)

    def test_negative_falls_back_to_100(self):
        self.assertEqual(bs.stale_threshold({bs.ENV_VAR: "-5"}), 100)


class BoundaryTests(unittest.TestCase):
    def test_boundary_99_is_not_far_behind(self):
        self.assertEqual(bs.classify_row(make_row(behind=99), THRESHOLD), "not-far-behind")

    def test_boundary_100_is_candidate(self):
        self.assertIsNone(bs.classify_row(make_row(behind=100), THRESHOLD))

    def test_boundary_101_is_candidate(self):
        self.assertIsNone(bs.classify_row(make_row(behind=101), THRESHOLD))

    def test_boundary_uses_threshold_argument(self):
        self.assertEqual(bs.classify_row(make_row(behind=249), 250), "not-far-behind")
        self.assertIsNone(bs.classify_row(make_row(behind=250), 250))


class ExclusionTests(unittest.TestCase):
    def test_hub_none_is_excluded_as_hub(self):
        self.assertEqual(bs.classify_row(make_row(hub=None), THRESHOLD), "hub")

    def test_chat_and_manual_are_excluded_as_human_source(self):
        self.assertEqual(bs.classify_row(make_row(source="chat"), THRESHOLD), "human-source")
        self.assertEqual(bs.classify_row(make_row(source="manual"), THRESHOLD), "human-source")

    def test_agent_source_is_not_human_source(self):
        self.assertIsNone(bs.classify_row(make_row(source="agent"), THRESHOLD))

    def test_behind_none_is_behind_unknown(self):
        self.assertEqual(bs.classify_row(make_row(behind=None), THRESHOLD), "behind-unknown")

    def test_ahead_one_is_excluded_as_ahead(self):
        self.assertEqual(bs.classify_row(make_row(ahead=1), THRESHOLD), "ahead")

    def test_ahead_two_is_not_excluded_as_ahead(self):
        # Contract: only ahead == 1 triggers the 'ahead' reason; ahead 2 falls through the checks.
        self.assertIsNone(bs.classify_row(make_row(ahead=2), THRESHOLD))

    def test_approved_verdict_is_not_excluded_as_verdict(self):
        self.assertIsNone(bs.classify_row(make_row(verdict="approved"), THRESHOLD))

    def test_needs_work_verdict_is_excluded_as_verdict(self):
        self.assertEqual(bs.classify_row(make_row(verdict="needs-work"), THRESHOLD), "verdict")

    def test_check_order_hub_before_behind(self):
        self.assertEqual(bs.classify_row(make_row(hub=None, behind=None), THRESHOLD), "hub")


class StaleCandidatesTests(unittest.TestCase):
    def test_candidate_shape_and_refile_from_find_by_id(self):
        record = {"id": "T1", "title": "rec"}
        result = bs.stale_candidates(
            [make_row()], THRESHOLD, lambda k: record if k == "T1" else None, no_lookup)
        self.assertEqual(len(result["candidates"]), 1)
        cand = result["candidates"][0]
        self.assertEqual(cand["project"], "proj")
        self.assertEqual(cand["branch"], "agent/x")
        self.assertEqual(cand["headSha"], "abc123")
        self.assertEqual(cand["behind"], 200)
        self.assertEqual(cand["taskId"], "T1")
        self.assertEqual(cand["refile"], record)
        self.assertEqual(result["threshold"], THRESHOLD)
        self.assertEqual(result["lookupErrors"], 0)

    def test_refile_falls_back_to_find_by_sha(self):
        record = {"id": "by-sha"}
        result = bs.stale_candidates(
            [make_row()], THRESHOLD, no_lookup, lambda k: record if k == "abc123" else None)
        self.assertEqual(result["candidates"][0]["refile"], record)

    def test_missing_record_gives_refile_none_and_row_still_listed(self):
        result = bs.stale_candidates([make_row()], THRESHOLD, no_lookup, no_lookup)
        self.assertEqual(len(result["candidates"]), 1)
        self.assertIsNone(result["candidates"][0]["refile"])
        self.assertEqual(result["lookupErrors"], 0)

    def test_find_by_id_value_error_does_not_hide_sibling_rows(self):
        def find_by_id(key):
            if key == "BAD":
                raise ValueError("boom")
            return {"id": key}

        rows = [
            make_row(branch="agent/bad", taskId="BAD", headSha=None),
            make_row(branch="agent/good", taskId="GOOD", headSha=None),
        ]
        result = bs.stale_candidates(rows, THRESHOLD, find_by_id, no_lookup)
        self.assertEqual(len(result["candidates"]), 2)
        by_branch = {c["branch"]: c for c in result["candidates"]}
        self.assertIsNone(by_branch["agent/bad"]["refile"])
        self.assertEqual(by_branch["agent/good"]["refile"], {"id": "GOOD"})
        self.assertEqual(result["lookupErrors"], 1)

    def test_excluded_counts_by_reason(self):
        rows = [
            make_row(ahead=1),
            make_row(hub=None),
            make_row(behind=None),
            make_row(behind=5),
            make_row(verdict="needs-work"),
            make_row(source="chat"),
            make_row(),
        ]
        result = bs.stale_candidates(rows, THRESHOLD, no_lookup, no_lookup)
        self.assertEqual(result["excluded"], {
            "ahead": 1,
            "hub": 1,
            "behind-unknown": 1,
            "not-far-behind": 1,
            "verdict": 1,
            "human-source": 1,
        })
        self.assertEqual(len(result["candidates"]), 1)

    def test_chat_and_manual_are_not_candidates(self):
        rows = [make_row(branch="agent/c", source="chat"), make_row(branch="agent/m", source="manual")]
        result = bs.stale_candidates(rows, THRESHOLD, no_lookup, no_lookup)
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["excluded"], {"human-source": 2})

    def test_excluded_owner_lists_human_rows(self):
        rows = [make_row(branch="agent/c", source="chat"), make_row()]
        result = bs.stale_candidates(rows, THRESHOLD, no_lookup, no_lookup)
        self.assertEqual(result["excludedOwner"], [
            {"project": "proj", "branch": "agent/c", "source": "chat"},
        ])

    def test_boundary_rows_through_stale_candidates(self):
        rows = [make_row(branch="b99", behind=99), make_row(branch="b100", behind=100),
                make_row(branch="b101", behind=101)]
        result = bs.stale_candidates(rows, THRESHOLD, no_lookup, no_lookup)
        self.assertEqual([c["branch"] for c in result["candidates"]], ["b100", "b101"])
        self.assertEqual(result["excluded"], {"not-far-behind": 1})


if __name__ == "__main__":
    unittest.main()
