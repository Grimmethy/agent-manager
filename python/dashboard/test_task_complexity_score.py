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


if __name__ == "__main__":
    unittest.main()
