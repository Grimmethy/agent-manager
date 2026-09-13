from flask import Blueprint, abort, jsonify, request

from pathlib import Path
import json
import subprocess
from datetime import datetime, timedelta, timezone
import os
import re

# The app.py helpers these views call (BENCHMARK_CURRENT_POINTER, BENCHMARK_STATE_DIR, ENV_FILE_PATH, PACKAGE_ROOT, SRC_DIR, _case_result_score, _fetch_ollama_models, _safe_run_id, _second_brain_bench_dir, logger, read_env_file, read_json_safe, second_brain_dir) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

benchmark_bp = Blueprint("benchmark-bp", __name__)

def _benchmark_run_dir(run_id: str) -> Path:
    from app import BENCHMARK_STATE_DIR
    return BENCHMARK_STATE_DIR / run_id


def _compute_case_stats() -> dict:
    """For each test case, the best- and worst-scoring model ACROSS EVERY SAVED RUN (not
    just the most recently viewed one) -- Grimmethy, 2026-08-19: "each test needs to show
    the current worst and best model scoring models in line on the main models page."
    Scans every _summary.json's raw `results` (not the already-per-run `summary`, which is
    grouped by category, not by individual case) and pools every response for a given
    (caseId, model) pair across all runs into one average score. Returns
    {caseId: {best: {model, score, sampleCount}, worst: {...}, modelCount}} -- a case with
    fewer than 2 distinct scored models has no meaningful "worst" (nothing to contrast
    against) and is simply omitted from the response for that case's key gaps."""
    from app import _case_result_score, _second_brain_bench_dir, read_json_safe
    bench_root = _second_brain_bench_dir()
    if not bench_root or not bench_root.is_dir():
        return {}

    # {caseId: {model: [scores...]}}
    scores_by_case_model: dict = {}
    for entry in bench_root.iterdir():
        summary_path = entry / "_summary.json"
        if not entry.is_dir() or not summary_path.is_file():
            continue
        data = read_json_safe(summary_path)
        if not data:
            continue
        for result in data.get("results", []):
            score = _case_result_score(result)
            if score is None:
                continue
            case_id = result.get("caseId")
            model = result.get("model")
            if not case_id or not model:
                continue
            scores_by_case_model.setdefault(case_id, {}).setdefault(model, []).append(score)

    stats = {}
    for case_id, by_model in scores_by_case_model.items():
        averages = [
            {"model": model, "score": sum(vals) / len(vals), "sampleCount": len(vals)}
            for model, vals in by_model.items()
        ]
        if len(averages) < 2:
            continue  # nothing to contrast a single tested model against
        averages.sort(key=lambda a: a["score"])
        stats[case_id] = {"worst": averages[0], "best": averages[-1], "modelCount": len(averages)}
    return stats


@benchmark_bp.route("/api/benchmark/cases")
def api_benchmark_cases():
    """Case bank metadata (id/category/grader) for the Models tab's test picker -- read
    live from reasoning-bench-cases.js via node rather than hand-duplicated here, so the
    two can never drift out of sync with each other. Each case is annotated with `stats`
    (best/worst scoring model pooled across every saved run, see _compute_case_stats) so
    the picker can show it inline without a separate round-trip."""
    from app import SRC_DIR, logger
    script = (
        "const {CASES} = require(process.argv[1]);"
        "console.log(JSON.stringify(CASES.map(c => ({id: c.id, category: c.category, grader: c.grader, prompt: c.prompt, description: c.description}))));"
    )
    try:
        result = subprocess.run(
            ["node", "-e", script, str(SRC_DIR / "reasoning-bench-cases.js")],
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        logger.warning("reasoning-bench-cases node script timed out after 15s")
        return jsonify([])
    if result.returncode != 0:
        logger.warning("reasoning-bench-cases node script exited with code %d: %s", result.returncode, result.stderr[:500])
        return jsonify([])
    try:
        cases = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        logger.warning("case-list: subprocess output was not valid JSON (%s); returning empty list. Raw output (first 500 chars): %r", exc, result.stdout[:500])
        return jsonify([])

    stats = _compute_case_stats()
    for c in cases:
        c["stats"] = stats.get(c["id"])
    return jsonify(cases)


@benchmark_bp.route("/api/benchmark/models")
def api_benchmark_models():
    from app import _fetch_ollama_models
    return jsonify({"ollamaModels": _fetch_ollama_models()})


@benchmark_bp.route("/api/benchmark/run", methods=["POST"])
def api_benchmark_run():
    from app import BENCHMARK_CURRENT_POINTER, BENCHMARK_STATE_DIR, ENV_FILE_PATH, PACKAGE_ROOT, SRC_DIR, read_env_file, second_brain_dir
    body = request.get_json(silent=True) or {}
    models = [m.strip() for m in (body.get("models") or []) if m.strip()]
    case_ids = [c.strip() for c in (body.get("caseIds") or []) if c.strip()]
    runs = max(1, min(20, int(body.get("runs") or 1)))
    include_judge = bool(body.get("includeJudge"))
    if not models:
        abort(400, description="at least one model is required")
    if not case_ids:
        abort(400, description="at least one test case is required")

    # One benchmark run at a time -- a second concurrent run would double-claim the same
    # Ollama model slot this box can only hold one of anyway (see model-inflight-lock.js's
    # own header for why), and would silently interleave two runs' progress into the same
    # "current" pointer.
    BENCHMARK_STATE_DIR.mkdir(parents=True, exist_ok=True)
    if BENCHMARK_CURRENT_POINTER.is_file():
        current_id = BENCHMARK_CURRENT_POINTER.read_text(encoding="utf-8").strip()
        progress_path = _benchmark_run_dir(current_id) / "progress.json"
        if progress_path.is_file():
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
            if progress.get("status") == "running":
                abort(409, description=f"a benchmark run ('{current_id}') is already in progress")

    run_id = f"run-{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S')}-{os.getpid() % 10000}"
    run_dir = _benchmark_run_dir(run_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    BENCHMARK_CURRENT_POINTER.write_text(run_id, encoding="utf-8")

    env_overrides = read_env_file(ENV_FILE_PATH)
    child_env = {**os.environ, **env_overrides}

    args = [
        "node", str(SRC_DIR / "reasoning-bench.js"),
        "--models", ",".join(models),
        "--cases", ",".join(case_ids),
        "--runs", str(runs),
        "--run-id", run_id,
        "--progress-out", str(run_dir / "progress.json"),
    ]
    sb_dir = second_brain_dir()
    if sb_dir:
        args += ["--second-brain-dir", str(sb_dir)]
    if not include_judge:
        args.append("--no-judge")

    log_path = run_dir / "run.log"
    subprocess.Popen(
        args,
        env=child_env,
        cwd=str(PACKAGE_ROOT),
        stdout=log_path.open("w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return jsonify({"runId": run_id, "started": True, "models": models, "caseIds": case_ids, "runs": runs, "includeJudge": include_judge, "savedToSecondBrain": sb_dir is not None})


@benchmark_bp.route("/api/benchmark/status")
def api_benchmark_status():
    """?runId=... for a specific run, else whichever run is/was most recently started."""
    from app import BENCHMARK_CURRENT_POINTER, _safe_run_id, logger
    run_id = request.args.get("runId")
    if not run_id:
        if not BENCHMARK_CURRENT_POINTER.is_file():
            return jsonify({"status": "idle"})
        run_id = BENCHMARK_CURRENT_POINTER.read_text(encoding="utf-8").strip()
    else:
        run_id = _safe_run_id(run_id)
    progress_path = _benchmark_run_dir(run_id) / "progress.json"
    if not progress_path.is_file():
        return jsonify({"status": "idle"})
    try:
        return jsonify(json.loads(progress_path.read_text(encoding="utf-8")))
    except json.JSONDecodeError:
        logger.warning(
            "Progress file %s is not valid JSON; reporting status as idle",
            progress_path,
            exc_info=True,
        )
        return jsonify({"status": "idle"})


@benchmark_bp.route("/api/benchmark/runs")
def api_benchmark_runs():
    """Past runs with a saved _summary.json, newest first -- the source of truth for
    history is SECOND_BRAIN_DIR (reasoning-bench.js's real, durable output), not
    BENCHMARK_STATE_DIR (which only ever holds transient progress/log files and is safe to
    clear at any time). Empty if SECOND_BRAIN_DIR isn't configured -- same "nothing to show,
    not an error" shape every other SECOND_BRAIN_DIR-gated endpoint in this file uses."""
    from app import _second_brain_bench_dir, read_json_safe
    bench_root = _second_brain_bench_dir()
    if not bench_root or not bench_root.is_dir():
        return jsonify([])
    runs = []
    for entry in bench_root.iterdir():
        summary_path = entry / "_summary.json"
        if not entry.is_dir() or not summary_path.is_file():
            continue
        data = read_json_safe(summary_path)
        if not data:
            continue
        runs.append({
            "runId": data.get("runId", entry.name),
            "generatedAt": data.get("generatedAt"),
            "models": data.get("models", []),
            "caseIds": data.get("caseIds", []),
            "runs": data.get("runs", 1),
        })
    runs.sort(key=lambda r: r.get("generatedAt") or "", reverse=True)
    return jsonify(runs)


@benchmark_bp.route("/api/benchmark/runs/<run_id>")
def api_benchmark_run_detail(run_id):
    from app import _safe_run_id, _second_brain_bench_dir, read_json_safe
    run_id = _safe_run_id(run_id)
    bench_dir = _second_brain_bench_dir(run_id)
    if not bench_dir:
        abort(404, description="SECOND_BRAIN_DIR is not configured")
    data = read_json_safe(bench_dir / "_summary.json")
    if not data:
        abort(404)
    return jsonify(data)


@benchmark_bp.route("/api/benchmark/response/<run_id>/<response_id>")
def api_benchmark_response(run_id, response_id):
    """Serves one saved response as a task-shaped JSON -- the SAME shape
    /api/task/<state>/<task_id> returns for a real pipeline task, so the frontend's
    existing renderTaskDetailModal() renders it with zero new viewer code (see
    reasoning-bench.js's writeResponseArtifact() for the field-name contract)."""
    from app import _safe_run_id, _second_brain_bench_dir, read_json_safe
    run_id = _safe_run_id(run_id)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", response_id or ""):
        abort(400, description="invalid response id")
    bench_dir = _second_brain_bench_dir(run_id)
    if not bench_dir:
        abort(404, description="SECOND_BRAIN_DIR is not configured")
    data = read_json_safe(bench_dir / f"{response_id}.json")
    if not data:
        abort(404)
    return jsonify(data)
