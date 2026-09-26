from flask import Blueprint, jsonify, request

import json
import os
import sqlite3

# The app.py helpers these views call (CLAUDE_MODEL_CHOICES, _fetch_ollama_models, _has_cost_usd_column, _has_hypothetical_cost_column, _has_instance_id_column, _zero_stats_model_row, model_stats_db_path, read_dashboard_settings, write_dashboard_settings) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

worker_models_1_more_bp = Blueprint("worker-models-1-more-bp", __name__)

@worker_models_1_more_bp.route("/api/worker-models")
def api_worker_models():
    from app import CLAUDE_MODEL_CHOICES, read_dashboard_settings
    overrides = read_dashboard_settings().get("workerModelOverrides", {})
    ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    ollama_models = []
    try:
        import urllib.request
        with urllib.request.urlopen(f"{ollama_url}/api/tags", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        ollama_models = sorted(m["name"] for m in data.get("models", []))
    except Exception:
        pass  # Ollama unreachable -- dropdown just shows the Claude lane / empty, not a 500.
    return jsonify({
        "overrides": overrides,
        "ollamaModels": ollama_models,
        "claudeModels": CLAUDE_MODEL_CHOICES,
        "claudePaused": read_dashboard_settings().get("claudePaused", False) is True,
    })


@worker_models_1_more_bp.route("/api/worker-models/<instance_id>", methods=["POST"])
def api_set_worker_model(instance_id):
    """model: "" or omitted clears the override, reverting that instance to its
    agent-manager.env default (LOCAL_MODEL or CLAUDE_MODEL) on its next tick."""
    from app import read_dashboard_settings, write_dashboard_settings
    body = request.get_json(silent=True) or {}
    model = (body.get("model") or "").strip()
    overrides = dict(read_dashboard_settings().get("workerModelOverrides", {}))
    if model:
        overrides[instance_id] = model
    else:
        overrides.pop(instance_id, None)
    write_dashboard_settings({"workerModelOverrides": overrides})
    return jsonify({"instanceId": instance_id, "model": model or None})


@worker_models_1_more_bp.route("/api/models")
def api_models():
    """Aggregate per-model stats for the implement-pass A/B test (see model-stats-db.js).
    Outcome and performance are joined in one query -- a fast-but-always-rejected model
    must not look like a winner in a raw tok/s-only view.

    Also includes every locally-available-but-never-called Ollama model with zeroed/null
    stats (2026-08-24, Grimmethy: "I need all models available to show here even if we
    haven't run them yet") -- reuses _fetch_ollama_models(), the SAME real symbol
    /api/benchmark/models already calls, rather than a second model-listing mechanism.
    This table has no concept of a fixed Claude-model roster (Claude models aren't
    locally enumerable the way Ollama's /api/tags is), so only Ollama models get a
    zero-stats placeholder row here; a Claude model still only appears once it has a
    real model_calls row, same as before."""
    from app import _fetch_ollama_models, _has_cost_usd_column, _zero_stats_model_row, model_stats_db_path
    ollama_models = set(_fetch_ollama_models())
    db_path = model_stats_db_path()
    if not db_path or not db_path.is_file():
        return jsonify([_zero_stats_model_row(m) for m in sorted(ollama_models)])

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        has_cost = _has_cost_usd_column(conn)
        cost_select = "SUM(cost_usd) AS total_cost_usd," if has_cost else "NULL AS total_cost_usd,"
        rows = conn.execute(f"""
            SELECT model,
                   COUNT(*) AS call_count,
                   SUM(CASE WHEN outcome = 'approved' THEN 1 ELSE 0 END) AS approved,
                   SUM(CASE WHEN outcome IN ('rejected', 'blocked_apply') THEN 1 ELSE 0 END) AS rejected,
                   AVG(latency_ms) AS avg_latency_ms,
                   AVG(CASE WHEN eval_count IS NOT NULL AND eval_duration_ns > 0
                            THEN eval_count * 1.0 / (eval_duration_ns / 1e9) END) AS avg_tokens_per_sec,
                   MIN(CASE WHEN eval_count IS NOT NULL AND eval_duration_ns > 0
                            THEN eval_count * 1.0 / (eval_duration_ns / 1e9) END) AS min_tokens_per_sec,
                   MAX(CASE WHEN eval_count IS NOT NULL AND eval_duration_ns > 0
                            THEN eval_count * 1.0 / (eval_duration_ns / 1e9) END) AS max_tokens_per_sec,
                   SUM(CASE WHEN degenerate IS NOT NULL THEN 1 ELSE 0 END) AS degenerate_count,
                   SUM(CASE WHEN call_error IS NOT NULL THEN 1 ELSE 0 END) AS error_count,
                   {cost_select}
                   1 AS _dummy
            FROM model_calls
            WHERE stage = 'implement'
            GROUP BY model
            ORDER BY model
        """).fetchall()
    finally:
        conn.close()

    results = []
    for model, call_count, approved, rejected, avg_latency_ms, avg_tok_s, min_tok_s, max_tok_s, degenerate_count, error_count, total_cost_usd, _dummy in rows:
        decided = (approved or 0) + (rejected or 0)
        results.append({
            "model": model,
            "callCount": call_count,
            "approved": approved or 0,
            "rejected": rejected or 0,
            "approveRate": (approved / decided) if decided else None,
            "avgLatencyMs": avg_latency_ms,
            "avgTokensPerSec": avg_tok_s,
            "minTokensPerSec": min_tok_s,
            "maxTokensPerSec": max_tok_s,
            "degenerateCount": degenerate_count or 0,
            "errorCount": error_count or 0,
            "totalCostUsd": total_cost_usd,
        })

    seen = {r["model"] for r in results}
    for model in sorted(ollama_models - seen):
        results.append(_zero_stats_model_row(model))
    return jsonify(results)


@worker_models_1_more_bp.route("/api/models/cost-summary")
def api_models_cost_summary():
    """Anthropic-API-equivalent cost estimate, aggregated across EVERY stage (not just
    'implement' -- a review-pass majority vote can be a real Claude call too). Same
    underlying data model-stats-db.js's own `cost-summary` CLI event exposes, queried
    directly here (read-only sqlite connection, same pattern every other endpoint in this
    file already uses against this db) rather than shelling out to Node for a page load.
    Grimmethy, 2026-08-23: "Do we have any way of knowing how much these tasks would cost
    using anthropic API?" -- claude-client.js's call() had always computed this
    (Claude Code CLI's own total_cost_usd, a client-side estimate against real Anthropic
    API pricing, independent of subscription billing); nothing ever stored or surfaced it
    until now."""
    from app import _has_cost_usd_column, _has_hypothetical_cost_column, _has_instance_id_column, model_stats_db_path
    db_path = model_stats_db_path()
    empty_hypothetical = {"totalCostUsd": 0, "totalCalls": 0, "byModel": [], "byDay": []}
    empty = {"totalCostUsd": 0, "callsWithCost": 0, "freeCalls": 0, "byModel": [], "byDay": [], "byInstance": [], "hypothetical": empty_hypothetical}
    if not db_path or not db_path.is_file():
        return jsonify(empty)

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        if not _has_cost_usd_column(conn):
            total_calls = conn.execute("SELECT COUNT(*) FROM model_calls").fetchone()[0]
            return jsonify({**empty, "freeCalls": total_calls})

        total_row = conn.execute(
            "SELECT COALESCE(SUM(cost_usd), 0), COUNT(*) FROM model_calls WHERE cost_usd IS NOT NULL"
        ).fetchone()
        free_calls = conn.execute("SELECT COUNT(*) FROM model_calls WHERE cost_usd IS NULL").fetchone()[0]
        by_model = conn.execute("""
            SELECT model, COALESCE(SUM(cost_usd), 0) AS total_cost, COUNT(*) AS calls
            FROM model_calls WHERE cost_usd IS NOT NULL GROUP BY model ORDER BY total_cost DESC
        """).fetchall()
        by_day = conn.execute("""
            SELECT substr(started_at, 1, 10) AS day, COALESCE(SUM(cost_usd), 0) AS total_cost, COUNT(*) AS calls
            FROM model_calls WHERE cost_usd IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 30
        """).fetchall()
        by_instance = []
        if _has_instance_id_column(conn):
            by_instance = conn.execute("""
                SELECT COALESCE(instance_id, '(unknown)') AS instance_id, COALESCE(SUM(cost_usd), 0) AS total_cost, COUNT(*) AS calls
                FROM model_calls WHERE cost_usd IS NOT NULL GROUP BY instance_id ORDER BY total_cost DESC
            """).fetchall()

        # Hypothetical: "what if EVERY call -- including the local ones -- had gone
        # through the Anthropic API" (2026-08-23, Grimmethy: "I'd like estimates for if
        # we had used the API. Even if we used the local models."). Covers every row
        # with a hypothetical_cost_usd value, always populated per model-stats-client.js's
        # own recordCall() (real cost for an actual Claude call, a token-based estimate
        # via anthropic-pricing.js otherwise).
        hypothetical = empty_hypothetical
        if _has_hypothetical_cost_column(conn):
            h_total_row = conn.execute(
                "SELECT COALESCE(SUM(hypothetical_cost_usd), 0), COUNT(*) FROM model_calls WHERE hypothetical_cost_usd IS NOT NULL"
            ).fetchone()
            h_by_model = conn.execute("""
                SELECT model, COALESCE(SUM(hypothetical_cost_usd), 0) AS total_cost, COUNT(*) AS calls
                FROM model_calls WHERE hypothetical_cost_usd IS NOT NULL GROUP BY model ORDER BY total_cost DESC
            """).fetchall()
            h_by_day = conn.execute("""
                SELECT substr(started_at, 1, 10) AS day, COALESCE(SUM(hypothetical_cost_usd), 0) AS total_cost, COUNT(*) AS calls
                FROM model_calls WHERE hypothetical_cost_usd IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 30
            """).fetchall()
            hypothetical = {
                "totalCostUsd": h_total_row[0],
                "totalCalls": h_total_row[1],
                "byModel": [{"model": m, "totalCost": c, "calls": n} for m, c, n in h_by_model],
                "byDay": [{"day": d, "totalCost": c, "calls": n} for d, c, n in h_by_day],
            }
    finally:
        conn.close()

    return jsonify({
        "totalCostUsd": total_row[0],
        "callsWithCost": total_row[1],
        "freeCalls": free_calls,
        "byModel": [{"model": m, "totalCost": c, "calls": n} for m, c, n in by_model],
        "byDay": [{"day": d, "totalCost": c, "calls": n} for d, c, n in by_day],
        "byInstance": [{"instanceId": i, "totalCost": c, "calls": n} for i, c, n in by_instance],
        "hypothetical": hypothetical,
    })


@worker_models_1_more_bp.route("/api/models/usage")
def api_models_usage():
    """Per-model call volume across EVERY stage, not just 'implement' -- api_models()
    above is specifically about drafting-pass quality (approved/rejected against a real
    review verdict), which an interactive Discuss/Grill session has no equivalent of
    (there's no reviewer voting on a conversation). This is the simpler "how much did I
    actually use each model" view claude_client.py's/model_stats_client.py's Discuss-
    session recording feeds into, covering both providers on equal footing -- before
    those existed, only the Node pipeline's own implement-pass calls were tracked at
    all, so interactive sessions (on ANY model) were invisible here regardless."""
    from app import model_stats_db_path
    db_path = model_stats_db_path()
    if not db_path or not db_path.is_file():
        return jsonify([])

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute("""
            SELECT model, stage,
                   COUNT(*) AS call_count,
                   AVG(latency_ms) AS avg_latency_ms,
                   MAX(started_at) AS last_used_at
            FROM model_calls
            GROUP BY model, stage
            ORDER BY model, stage
        """).fetchall()
    except sqlite3.DatabaseError:
        # is_file() only proves the path exists: a db file the Node side has not created its
        # model_calls table in yet ("no such table"), or a zeroed/corrupt one (same failure
        # class as _task_cost_summary, AC-61), would otherwise 500 this route and blank the
        # Models tab. "No usage recorded" is the truthful answer for both (change_review AC-79).
        return jsonify([])
    finally:
        conn.close()

    return jsonify([
        {"model": model, "stage": stage, "callCount": call_count,
         "avgLatencyMs": avg_latency_ms, "lastUsedAt": last_used_at}
        for model, stage, call_count, avg_latency_ms, last_used_at in rows
    ])
