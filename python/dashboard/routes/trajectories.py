"""Agent-run trajectory viewer (2026-10-18, brain-dump 1892 part 2, harness-derived).

src/trajectory.js writes one gzip JSON per runPlanWithTools() run to
<pipelineDir>/instances/trajectories/<taskId>/<startedAt>-<stage>-<pid>.json.gz (messages, per-turn end
entries from the tool-loop audit, result summary). This module serves them read-only:

  GET /api/task-anywhere/<task_id>/trajectories   -> {"taskId", "runs": [{name, startedAt, stage, bytes}]} newest first
  GET /trajectory/<task_id>[?run=<name>]          -> one self-contained HTML timeline (inline CSS, no JS)

Both accept an optional ?project=<label|repoRoot> hint (HUB0171 · 4/6, borrowed-task fix): the
runs are then read from that project's pipeline dir -- the 1/6 shared resolver
(project_scope.resolve_project) maps the hint to the pipeline dir instead of the active
project's -- so a task a lane borrowed from another project shows its own trajectories. Without
the hint the behaviour is unchanged (active project's instances/trajectories/).

Linked from the task detail modal and the Workers card (trajectoryLinkHtml in task-detail-modal.js). A
plain AM renderer rather than the competition harness's adk_eval_core viewer, which needs its own trace
model. Everything shown is escaped; a run name must be a bare *.json.gz file inside that task's own dir.
"""
import gzip
import html
import json
import re
from pathlib import Path

from flask import Blueprint, abort, jsonify, request

# The app.py helpers these views call (instances_dir) are imported lazily inside each view: app.py imports
# THIS module to register the blueprint (same pattern as routes/task_anywhere_1_more.py).

trajectories_bp = Blueprint("trajectories-bp", __name__)

_RUN_NAME_RE = re.compile(r"^(\d{8}T\d{6}Z)-(.+)-\d+\.json\.gz$")
_PREVIEW_CHARS = 300


def _safe_segment(value, fallback):
    # Same rule as src/trajectory.js safeSegment, so the dir the writer used is the dir read here.
    seg = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or ""))[:160]
    return seg or fallback


def _task_dir(task_id, project=None):
    # With a ?project= hint: read from the project that owns the task. project_scope.resolve_project
    # (the 1/6 shared resolver) maps the hint -- a label or a repoRoot -- to that project's pipeline
    # dir, and instances/ hangs off it exactly like app.instances_dir() derives it for the active
    # project (get_pipeline_dir() / "instances"). Without the hint: unchanged legacy path.
    if project:
        try:
            from project_scope import resolve_project
            entry = resolve_project(project)
        except Exception:  # noqa: BLE001 -- unknown project: no silent fallback to the active one
            abort(404, description=f"unknown project: {project}")
        pipeline_dir = entry.get("pipeline_dir") if entry else None
        if not pipeline_dir:
            abort(404, description=f"unknown project: {project}")
        inst = Path(pipeline_dir) / "instances"
    else:
        from app import instances_dir
        inst = instances_dir()
    return (inst / "trajectories" / _safe_segment(task_id, "_no-task")) if inst else None


def _list_runs(task_id, project=None):
    d = _task_dir(task_id, project)
    if not d or not d.is_dir():
        return []
    runs = []
    for f in d.iterdir():
        m = _RUN_NAME_RE.match(f.name)
        if not m or not f.is_file():
            continue
        runs.append({"name": f.name, "startedAt": m.group(1), "stage": m.group(2), "bytes": f.stat().st_size})
    return sorted(runs, key=lambda r: r["startedAt"], reverse=True)


def _load_run(task_id, name, project=None):
    if not name or "/" in name or "\\" in name or not _RUN_NAME_RE.match(name):
        abort(404, description="not a trajectory file name")
    d = _task_dir(task_id, project)
    f = d / name if d else None
    if not f or not f.is_file():
        abort(404, description=f"no trajectory '{name}' for task {task_id}")
    with gzip.open(f, "rt", encoding="utf-8") as fh:
        return json.load(fh)


@trajectories_bp.route("/api/task-anywhere/<task_id>/trajectories")
def api_task_trajectories(task_id):
    project = (request.args.get("project") or "").strip() or None
    return jsonify({"taskId": task_id, "runs": _list_runs(task_id, project)})


def _e(value):
    return html.escape("" if value is None else str(value))


def _text_block(text):
    text = "" if text is None else str(text)
    if len(text) <= _PREVIEW_CHARS:
        return f"<pre>{_e(text)}</pre>"
    return (f"<details><summary><code>{_e(text[:_PREVIEW_CHARS])}</code> &hellip; ({len(text)} chars)</summary>"
            f"<pre>{_e(text)}</pre></details>")


def _turn_badges(turn):
    if not turn:
        return ""
    parts = [f'<span class="b b-{_e(turn.get("endClass"))}">{_e(turn.get("endClass"))}</span>']
    if turn.get("heuristic"):
        parts.append('<span class="b">heuristic</span>')
    parts.append(f'<span class="m">done_reason {_e(turn.get("doneReason"))}</span>')
    if turn.get("promptEvalCount") is not None:
        parts.append(f'<span class="m">{_e(turn.get("promptEvalCount"))} prompt / {_e(turn.get("evalCount"))} gen tokens</span>')
    if turn.get("thinkingChars"):
        parts.append(f'<span class="m">{_e(turn.get("thinkingChars"))} chars thinking</span>')
    return " ".join(parts)


_CSS = """
body{font:14px/1.45 system-ui,sans-serif;margin:16px;background:#fafafa;color:#1d1d1f}
h1{font-size:18px;margin:0 0 4px} .meta,.m{color:#666;font-size:12px} a{color:#0a58ca}
.runs{margin:8px 0 16px} .runs a{margin-right:10px} .runs .cur{font-weight:700}
.row{border-left:4px solid #bbb;background:#fff;margin:6px 0;padding:6px 10px;border-radius:4px}
.row.system{border-color:#999}.row.user{border-color:#7a5}.row.assistant{border-color:#06c}.row.tool{border-color:#c80}
.role{font-weight:700;text-transform:uppercase;font-size:11px;margin-right:8px}
.b{display:inline-block;padding:0 6px;border-radius:8px;background:#eee;font-size:11px;margin-right:4px}
.b-length,.b-length-tool-call-suspected,.b-unknown{background:#fdd}.b-stop{background:#dfd}.b-tool-calls{background:#def}
pre{white-space:pre-wrap;word-break:break-word;margin:4px 0;font-size:12px;background:#f4f4f4;padding:6px;border-radius:3px}
summary{cursor:pointer} .call{margin:4px 0}
@media (prefers-color-scheme: dark){body{background:#151515;color:#e6e6e6}.row{background:#1e1e1e}pre{background:#262626}.b{background:#333}
.meta,.m{color:#aaa}a{color:#7ab0ff}}
"""


def _render_page(task_id, runs, traj, current, project=None):
    out = [f"<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
           f"<title>Trajectory {_e(task_id)}</title><style>{_CSS}</style></head><body>",
           f"<h1>Agent-run trajectory</h1><div class='meta'>task <code>{_e(task_id)}</code></div>"]
    if not runs:
        out.append("<p>No trajectories recorded for this task (runs are kept for the retention window; "
                   "AGENT_MANAGER_TRAJECTORY=off disables recording).</p></body></html>")
        return "".join(out)
    # Keep ?project= on the run links so a cross-project timeline page keeps serving every run
    # from that project's dir -- a bare ?run= link would drop the hint and fall back to the
    # active project's trajectories.
    proj_q = f"&project={_e(project)}" if project else ""
    out.append("<div class='runs'>Runs: " + "".join(
        f"<a class='{'cur' if r['name'] == current else ''}' href='?run={_e(r['name'])}{proj_q}'>{_e(r['startedAt'])} {_e(r['stage'])}</a>"
        for r in runs) + "</div>")
    res = traj.get("result") or {}
    out.append(
        "<div class='meta'>"
        f"stage <b>{_e(traj.get('stage'))}</b> · source {_e(traj.get('source'))} · lane {_e(traj.get('lane'))} · model {_e(traj.get('model'))}<br>"
        f"started {_e(traj.get('startedAt'))} · {round((traj.get('durationMs') or 0) / 1000)} s · "
        f"{_e(res.get('turnsUsed'))} turn(s) · {_e(res.get('promptEvalCount'))} prompt / {_e(res.get('evalCount'))} gen tokens total"
        + (f" · forced summary ({_e(res.get('forcedSummaryReason'))})" if res.get("forcedSummary") else "")
        + "</div>")
    turns = list(traj.get("turns") or [])
    # Every turn, whether or not its reply stayed in the message history (a narration-nudged turn's reply and the
    # final answer are never pushed onto messages by runPlanWithTools).
    out.append("<details open><summary>Turns (" + str(len(turns)) + ")</summary><table class='m'>"
               "<tr><th>turn</th><th>phase</th><th>end</th><th>done_reason</th><th>prompt</th><th>gen</th><th>tools</th></tr>"
               + "".join(f"<tr><td>{_e(t.get('turn'))}</td><td>{_e(t.get('phase'))}</td><td>{_e(t.get('endClass'))}</td>"
                         f"<td>{_e(t.get('doneReason'))}</td><td>{_e(t.get('promptEvalCount'))}</td><td>{_e(t.get('evalCount'))}</td>"
                         f"<td>{_e(', '.join(t.get('toolNames') or []))}</td></tr>" for t in turns)
               + "</table></details>")
    # Only assistant turns that made tool calls are in the message history, in order; the final answer belongs to the
    # last turn that made none.
    tool_turns = [t for t in turns if (t.get("toolCallCount") or 0) > 0]
    final_turn = next((t for t in reversed(turns) if not (t.get("toolCallCount") or 0)), None)
    assistant_i = 0
    for m in traj.get("messages") or []:
        role = m.get("role") or "?"
        head = f"<span class='role'>{_e(role)}{' (final answer)' if m.get('final') else ''}</span>"
        if role == "assistant" and m.get("final"):
            head += _turn_badges(final_turn)
        elif role == "assistant" and m.get("tool_calls"):
            head += _turn_badges(tool_turns[assistant_i] if assistant_i < len(tool_turns) else None)
            assistant_i += 1
        body = []
        if m.get("content"):
            body.append(_text_block(m.get("content")))
        for c in m.get("tool_calls") or []:
            body.append(f"<div class='call'>&rarr; <b>{_e(c.get('name'))}</b>{_text_block(c.get('arguments'))}</div>")
        out.append(f"<div class='row {_e(role)}'>{head}{''.join(body)}</div>")
    out.append("</body></html>")
    return "".join(out)


@trajectories_bp.route("/trajectory/<task_id>")
def trajectory_page(task_id):
    project = (request.args.get("project") or "").strip() or None
    runs = _list_runs(task_id, project)
    if not runs:
        if request.args.get("run"):
            abort(404, description=f"no trajectories for task {task_id}")
        return _render_page(task_id, [], None, None, project)
    current = request.args.get("run") or runs[0]["name"]
    traj = _load_run(task_id, current, project)
    return _render_page(task_id, runs, traj, current, project)
