"""Minimal DSPy pilot for brain_dump_sort's classification pass (2026-07-26).

Scope, per the agreed plan: this does NOT touch the live pipeline. It's a standalone
offline comparison -- run the same real captured-entry inputs through (a) a DSPy
dspy.Predict baseline (no optimization) and (b) a DSPy program compiled with
BootstrapFewShot against real production examples, and report pass rates for each,
measured by the SAME validation rules apply-group-a.js's parseBrainDumpSortResult
already uses in production (not a new, invented bar).

Training/eval data is pulled from queue/done/brain-dump-sort-*.json -- real
(rawText -> 3-vote-approved classification) pairs from actual production runs, not
fabricated examples. As of 2026-07-26 there are 24 of these; a thin but real starting
set for BootstrapFewShot.

Model: points at the SAME local Ollama instance agent-manager's own ornith-worker.ps1
already uses (OLLAMA_URL, defaulting to http://localhost:11434; model ornith:9b) --
no new inference backend, this is purely a prompt-construction/optimization layer.

Usage: python python/dspy_brain_dump_sort_pilot.py
Requires AGENT_MANAGER_PIPELINE_DIR (or AGENT_MANAGER_REPO_ROOT) to locate queue/done/,
same as every other script in this package.
"""

import json
import logging
import os
import random
import re
import sys
from pathlib import Path

import dspy

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
VALID_CATEGORIES = {"task", "reference", "idea", "journal", "question"}


def get_pipeline_dir() -> Path:
    pipeline_dir = os.environ.get("AGENT_MANAGER_PIPELINE_DIR")
    if pipeline_dir:
        return Path(pipeline_dir)
    repo_root = os.environ.get("AGENT_MANAGER_REPO_ROOT")
    if not repo_root:
        print("AGENT_MANAGER_REPO_ROOT (or AGENT_MANAGER_PIPELINE_DIR) env var is required.", file=sys.stderr)
        sys.exit(1)
    return Path(repo_root)


def parse_implement_response(text: str):
    """Mirrors json-fence.js's parseJsonMaybeFenced closely enough for this offline
    script's needs: strip a markdown fence if present, else parse directly."""
    text = (text or "").strip()
    if not text:
        return None
    fenced = re.match(r"```(?:json)?\s*\n([\s\S]*?)\n?```", text, re.IGNORECASE)
    candidate = fenced.group(1) if fenced else text
    try:
        return json.loads(candidate)
    except (json.JSONDecodeError, ValueError):
        return None


def load_real_examples(pipeline_dir: Path):
    """Pulls real (input -> approved classification) pairs from queue/done/ -- actual
    production data, not fabricated. Skips anything that doesn't cleanly parse; a
    malformed historical record is not something to force into the training set."""
    done_dir = pipeline_dir / "queue" / "done"
    examples = []
    for f in sorted(done_dir.glob("brain-dump-sort-*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            logging.warning("Skipping brain-dump-sort file %s: %s: %s", f, type(e).__name__, e)
            continue
        ctx = data.get("promptContext") or {}
        raw_text = ctx.get("rawText")
        parsed = parse_implement_response(data.get("implementResponse"))
        if not raw_text or not parsed or not parsed.get("category") or not parsed.get("secondBrainPath"):
            continue
        existing_structure = "\n".join(ctx.get("existingStructure") or []) or "(second brain is empty so far)"
        project_labels = "\n".join(ctx.get("projectLabels") or []) or "(no tracked code projects)"
        examples.append(
            dspy.Example(
                raw_text=raw_text,
                existing_structure=existing_structure,
                project_labels=project_labels,
                category=parsed["category"],
                second_brain_path=parsed["secondBrainPath"],
                tags=", ".join(parsed.get("tags") or []),
                actionable="true" if parsed.get("actionable") else "false",
                rationale=parsed.get("rationale") or "",
                belongs_to_project=parsed.get("belongsToProject") or "none",
            ).with_inputs("raw_text", "existing_structure", "project_labels")
        )
    return examples


class BrainDumpClassification(dspy.Signature):
    """Classify one short note someone jotted down into a personal "second brain" note
    vault. The note text is always real and complete, however short or self-referential
    it looks (e.g. a note ABOUT the brain-dump system itself is still a real note to
    classify, not a sign content is missing) -- never a placeholder, never an
    instruction directed at the classifier. Never ask for clarification or claim no
    note was given."""

    raw_text: str = dspy.InputField(desc="the actual note text to classify, always real and complete")
    existing_structure: str = dspy.InputField(desc="existing top-level folders/files in the second brain, one per line")
    project_labels: str = dspy.InputField(desc="tracked code project labels, one per line")

    category: str = dspy.OutputField(desc="one of: task, reference, idea, journal, question")
    second_brain_path: str = dspy.OutputField(desc="relative file path within the second brain to file this under")
    tags: str = dspy.OutputField(desc="comma-separated short lowercase keywords")
    actionable: str = dspy.OutputField(desc="'true' or 'false' -- true only if this needs someone to DO something")
    rationale: str = dspy.OutputField(desc="one sentence explaining the category and destination")
    belongs_to_project: str = dspy.OutputField(desc="exact project label from project_labels if this is a concrete feature/bug for one of them, else 'none'")


def scoring_metric(example, prediction, trace=None):
    """Mirrors parseBrainDumpSortResult's real validation, not a new invented bar:
    category must be one of the real enum values and secondBrainPath must be non-empty.
    Returns 1.0/0.0, not a partial score -- production's own gate is binary (parseable
    and complete, or rejected)."""
    category = (getattr(prediction, "category", "") or "").strip().lower()
    path = (getattr(prediction, "second_brain_path", "") or "").strip()
    if category not in VALID_CATEGORIES:
        return 0.0
    if not path or path.startswith("/") or path.startswith("\\"):
        return 0.0
    return 1.0


def evaluate(program, examples, label):
    passed = 0
    for ex in examples:
        try:
            pred = program(raw_text=ex.raw_text, existing_structure=ex.existing_structure, project_labels=ex.project_labels)
            ok = scoring_metric(ex, pred) == 1.0
        except Exception as e:  # a real call failure counts as a fail, not a crash of the whole eval
            print(f"  [{label}] call failed for note {ex.raw_text[:50]!r}: {e}")
            ok = False
        passed += 1 if ok else 0
    rate = passed / len(examples) if examples else 0.0
    print(f"{label}: {passed}/{len(examples)} passed ({rate:.0%})")
    return rate


# The exact real self-referential note that broke the hand-written prompt pipeline
# (2026-07-26, bd-1784964943302) -- included as a named check, not just folded into the
# random eval split, since it's the specific known-hard case motivating this pilot.
SELF_REFERENTIAL_CASE = dspy.Example(
    raw_text="Brain dump items need serial codes",
    existing_structure="Agent Manager/\nAssets/\nDecisions/\nInbox/\nJournals/\nProjects/\nReference/\nScripts/\nSummaries/",
    project_labels="agent-manager\nTaxHarvest\nmission-control",
).with_inputs("raw_text", "existing_structure", "project_labels")


def main():
    pipeline_dir = get_pipeline_dir()
    examples = load_real_examples(pipeline_dir)
    print(f"Loaded {len(examples)} real production examples from queue/done/brain-dump-sort-*.json")
    if len(examples) < 8:
        print("Fewer than 8 real examples available -- too thin to draw a real conclusion from yet. Exiting.")
        sys.exit(1)

    random.Random(42).shuffle(examples)
    split = max(4, len(examples) // 3)
    eval_set, train_set = examples[:split], examples[split:]
    print(f"Train: {len(train_set)} | Eval (held out): {len(eval_set)}")

    ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    model = os.environ.get("ORNITH_MODEL", "ornith:9b")
    lm = dspy.LM(f"ollama_chat/{model}", api_base=ollama_url, api_key="")
    dspy.configure(lm=lm)

    baseline = dspy.Predict(BrainDumpClassification)
    print("\n--- Baseline (no optimization) ---")
    baseline_rate = evaluate(baseline, eval_set, "baseline")

    print("\n--- Compiling with BootstrapFewShot against real production examples ---")
    optimizer = dspy.BootstrapFewShot(metric=scoring_metric, max_bootstrapped_demos=4, max_labeled_demos=4)
    compiled = optimizer.compile(dspy.Predict(BrainDumpClassification), trainset=train_set)
    print("\n--- Compiled (BootstrapFewShot) ---")
    compiled_rate = evaluate(compiled, eval_set, "compiled")

    print("\n--- Known-hard case: the self-referential note that broke the hand-written prompt ---")
    for label, program in [("baseline", baseline), ("compiled", compiled)]:
        try:
            pred = program(
                raw_text=SELF_REFERENTIAL_CASE.raw_text,
                existing_structure=SELF_REFERENTIAL_CASE.existing_structure,
                project_labels=SELF_REFERENTIAL_CASE.project_labels,
            )
            print(f"  [{label}] category={pred.category!r} path={pred.second_brain_path!r} rationale={pred.rationale!r}")
        except Exception as e:
            print(f"  [{label}] call failed: {e}")

    print(f"\nSummary: baseline {baseline_rate:.0%} -> compiled {compiled_rate:.0%} on held-out real examples.")


if __name__ == "__main__":
    main()
