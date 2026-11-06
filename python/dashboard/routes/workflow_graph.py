from flask import Blueprint, jsonify

import json
import os
import subprocess

# GET /api/workflow-graph: the read-only WorkflowGraph of the Workers tab (HUB0323 piece W-A2).
# The graph itself is built by src/workflow-graph.js (a pure function); this module only gathers
# its four inputs from the existing sources and pipes them to `node src/workflow-graph.js --stdin`.
# The app.py helpers it needs are imported lazily inside the view for the same circular-import
# reason as routes/job_types.py (app.py imports this module to register the blueprint).

workflow_graph_bp = Blueprint("workflow-graph-bp", __name__)

NODE_TIMEOUT_SECONDS = 15


def _json_of(resp):
    """Parsed JSON body of a Flask Response or of a (Response, status) tuple.
    Raises ValueError when the value is not a response or its body is not JSON."""
    if isinstance(resp, tuple):
        resp = resp[0]
    get_json = getattr(resp, "get_json", None)
    if get_json is None:
        raise ValueError("not a Flask response")
    body = get_json(silent=True)
    if body is None:
        raise ValueError("response body is not JSON")
    return body


def _gather(name, fetch, default, warnings):
    """Run one input fetcher; a failure only adds a warning naming the input."""
    try:
        return fetch()
    except Exception as exc:  # noqa: BLE001 - one broken input must not take the whole graph down
        warnings.append(f"{name}: {str(exc)[:200] or type(exc).__name__}")
        return default


def _checked_workflow(value):
    """The output of `node src/workflow-config.js`: { config: {...}, warnings: [...] }."""
    if not isinstance(value, dict) or not isinstance(value.get("config"), dict):
        raise ValueError("unexpected output (expected {config, warnings})")
    return value


def _checked_scripts(value):
    """The `scripts` list of `node src/plugin-watchdog-scripts.js --json`."""
    if not isinstance(value, list):
        raise ValueError("unexpected output (expected a list)")
    return value


def assemble_graph(run_lanes, get_instances, get_topology, get_models, run_builder, get_workflow=None, get_watchdog_scripts=None):
    """Collect the inputs through the injected callables and run the builder on them.
    The four required inputs are lanes, instances, topology and models. Two more are optional (None = not asked for): get_workflow returns the
    output of the workflow file loader ({config, warnings}) and goes to the builder as `workflow`; get_watchdog_scripts returns the list of watchdog
    scripts and goes to the builder as `watchdogScripts`. A failing or malformed input only adds a warning naming it and its key is left out of the payload.
    Returns the builder's graph (with one extra warning per failed input and the workflow file's own warnings), or
    {"available": False, "reason": ...} when the builder itself fails."""
    warnings = []
    lanes = _gather("lanes", run_lanes, [], warnings)
    instances = _gather("instances", get_instances, [], warnings)
    topology = _gather("topology", get_topology, [], warnings)
    models = _gather("models", get_models, {}, warnings)
    payload = {"lanes": lanes, "instances": instances, "topology": topology, "models": models}
    config_warnings = []
    if get_workflow is not None:
        workflow = _gather("workflow", lambda: _checked_workflow(get_workflow()), None, warnings)
        if workflow is not None:
            payload["workflow"] = workflow["config"]
            config_warnings = [str(w) for w in (workflow.get("warnings") or [])]
    if get_watchdog_scripts is not None:
        scripts = _gather("watchdogScripts", lambda: _checked_scripts(get_watchdog_scripts()), None, warnings)
        if scripts is not None:
            payload["watchdogScripts"] = scripts
    try:
        graph = run_builder(payload)
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "reason": (str(exc) or type(exc).__name__)[:300]}
    if (warnings or config_warnings) and isinstance(graph, dict):
        graph["warnings"] = list(graph.get("warnings") or []) + warnings + config_warnings
    return graph


def _run_node(script, args, env, stdin_text=None):
    from app import SRC_DIR
    result = subprocess.run(
        ["node", str(SRC_DIR / script), *args],
        input=stdin_text, capture_output=True, text=True,
        timeout=NODE_TIMEOUT_SECONDS, cwd=str(SRC_DIR), env=env,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or f"{script} exited {result.returncode}").strip()[:300])
    return json.loads(result.stdout)


@workflow_graph_bp.route("/api/workflow-graph")
def api_workflow_graph():
    from app import ENV_FILE_PATH, read_env_file
    from routes.instances import api_instances
    from routes.job_types import api_pipeline_map
    from routes.worker_models_1_more import api_worker_models

    # Same env the pipeline loops get (agent-manager.env on top of os.environ), as api_pipeline_map does.
    child_env = {**os.environ, **read_env_file(ENV_FILE_PATH)}

    def get_topology():
        body = _json_of(api_pipeline_map())
        if not isinstance(body, dict) or body.get("available") is False:
            reason = body.get("reason") if isinstance(body, dict) else None
            raise ValueError(f"pipeline map unavailable ({reason or 'no reason given'})")
        return body.get("sources") or []

    return jsonify(assemble_graph(
        run_lanes=lambda: _run_node("lanes.js", [], child_env),
        get_instances=lambda: _json_of(api_instances()),
        get_topology=get_topology,
        get_models=lambda: _json_of(api_worker_models()),
        run_builder=lambda payload: _run_node("workflow-graph.js", ["--stdin"], child_env, json.dumps(payload)),
        get_workflow=lambda: _run_node("workflow-config.js", [], child_env),
        get_watchdog_scripts=lambda: _run_node("plugin-watchdog-scripts.js", ["--json"], child_env).get("scripts"),
    ))
