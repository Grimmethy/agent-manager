#!/usr/bin/env python3
"""Smoke-test for src/task-complexity-score.js (inert v1 5-factor classifier).

The module is deliberately inert (no call sites, per the 2026-09-17 human design
decision), so these tests only exercise its public scoring function and export
shape.

Run: .venv/bin/python -m unittest python.dashboard.test_task_complexity_score -v
"""
import json
import os
import subprocess
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def run_node(expr):
    r = subprocess.run(
        ["node", "-e", expr],
        capture_output=True, text=True, cwd=REPO, timeout=30,
    )
    if r.returncode != 0:
        raise RuntimeError(f"node failed: {r.stderr}")
    return json.loads(r.stdout)


def _score(task_obj_literal):
    return run_node(
        "const {scoreTaskComplexity}=require('./src/task-complexity-score');"
        f"console.log(JSON.stringify(scoreTaskComplexity({task_obj_literal})));"
    )


class TestTaskComplexityScore(unittest.TestCase):
    def test_trivial_task_scores_zero(self):
        out = _score("{'rawText':'fix typo'}")
        self.assertEqual(out["score"], 0, f"expected 0, got {out['score']}")
        self.assertEqual(out["suggestedTier"], "low")

    def test_complex_task_scores_high(self):
        out = _score(
            "{'rawText':('x'.repeat(900) + ' then, we first must add the flag, once you "
            "enable it, the other consumer depends on that flag and you should update "
            "readFile then afterwards call writeCounters and also taskIdentifiers, "
            "scoreTaskComplexity, buildUnreliableGroundingQuestion, "
            "resolveAgainstRepoDetailed -- see src/task-source-registry.js and "
            "src/task-anchor-files.js and python/dashboard/app.py and "
            "scripts/deploy.sh and docs/adr/0018-example.md'),"
            " 'promptContext':{'prefetchedPaths':['a.js','b.js','c.js'],"
            " 'harnessHits':[{'file':'a.js','line':1}]},"
            " 'history':[{'stage':'harness-search','detail':'3 hits'}]}"
        )
        self.assertGreaterEqual(out["score"], 3, f"expected >=3, got {out['score']}")
        self.assertEqual(out["suggestedTier"], "high")

    def test_empty_task_object_does_not_throw(self):
        out = _score("{}")
        self.assertEqual(out["score"], 0)
        self.assertEqual(out["factors"], {
            "length": 0, "requirementCount": 0, "domainBreadth": 0,
            "toolNeeds": 0, "reasoningDepth": 0,
        })
        self.assertEqual(out["suggestedTier"], "low")

    def test_exports_shape(self):
        out = run_node(
            "const m=require('./src/task-complexity-score');"
            "console.log(JSON.stringify({"
            "fn: typeof m.scoreTaskComplexity,"
            "frozen: Object.isFrozen(m.DEFAULT_THRESHOLDS),"
            "keys: Object.keys(m.DEFAULT_THRESHOLDS).sort()"
            "}));"
        )
        self.assertEqual(out["fn"], "function")
        self.assertIs(out["frozen"], True)
        self.assertEqual(out["keys"], ["domainBreadth", "length", "reasoningDepth",
                                       "requirementCount", "toolNeeds"])


def _factors(task):
    """Score a task given as a Python dict (passed to node as a JSON literal) -> (score, factors, tier)."""
    out = _score(json.dumps(task))
    return out["score"], out["factors"], out["suggestedTier"]


ZERO = {"length": 0, "requirementCount": 0, "domainBreadth": 0, "toolNeeds": 0, "reasoningDepth": 0}
FOUR_SYMBOLS = "call readFile and writeCounters and taskIdentifiers and scoreTaskComplexity now"


class TestEachFactorInIsolation(unittest.TestCase):
    """One input per factor that trips exactly that factor, plus the boundary just below it. Zeroing any single
    factor, or moving its cutoff, fails one of these (the first version of this file passed with any factor zeroed)."""

    def _only(self, name, task, tier="low"):
        score, factors, got_tier = _factors(task)
        self.assertEqual(factors, {**ZERO, name: 1}, name)
        self.assertEqual(score, 1, name)
        self.assertEqual(got_tier, tier, name)

    def test_length_trips_above_800_chars_and_not_at_800(self):
        self._only("length", {"rawText": "ab " * 267})          # 801 chars
        self.assertEqual(_factors({"rawText": "a" * 800})[1], ZERO)

    def test_requirement_count_trips_above_four_named_symbols(self):
        self.assertEqual(_factors({"rawText": FOUR_SYMBOLS})[1], ZERO)
        self._only("requirementCount", {"rawText": FOUR_SYMBOLS + " and resolveAgainstRepoDetailed"})

    def test_domain_breadth_counts_prefetched_paths_and_paths_named_in_the_text(self):
        self.assertEqual(_factors({"promptContext": {"prefetchedPaths": ["a.js", "b.js"]}})[1], ZERO)
        self._only("domainBreadth", {"promptContext": {"prefetchedPaths": ["a.js", "b.js", "c.js"]}})
        self._only("domainBreadth", {"rawText": "see src/a.js and docs/b.md and scripts/c.sh"})
        self.assertEqual(_factors({"rawText": "see src/a.js and docs/b.md"})[1], ZERO)

    def test_tool_needs_trips_on_any_one_harness_search_signal(self):
        self._only("toolNeeds", {"promptContext": {"harnessHits": [{"file": "a.js"}]}})
        self._only("toolNeeds", {"promptContext": {"searchResults": [1]}})
        self._only("toolNeeds", {"history": [{"stage": "harness-search"}]})
        self.assertEqual(_factors({"history": [{"stage": "orient-done"}]})[1], ZERO)

    def test_reasoning_depth_needs_two_sequential_markers(self):
        self.assertEqual(_factors({"rawText": "then"})[1], ZERO)
        self._only("reasoningDepth", {"rawText": "first we must do a, then do b, then c"})


class TestTierBoundary(unittest.TestCase):
    def test_score_one_is_low_and_score_two_is_high(self):
        one = _factors({"rawText": "ab " * 267})
        self.assertEqual((one[0], one[2]), (1, "low"))
        two = _factors({"rawText": "ab " * 267, "history": [{"stage": "harness-search"}]})
        self.assertEqual((two[0], two[2]), (2, "high"))


if __name__ == "__main__":
    unittest.main()
