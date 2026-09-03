from flask import Blueprint
from flask import jsonify

import hardware_stats

hardware_bp = Blueprint("hardware-bp", __name__)


def _hardware_history_averages(history: list) -> dict:
    """Current-vs-average is computed here rather than in hardware_stats.py -- that
    module only knows about individual samples, "average over the retention window" is
    a view concern for this endpoint's caller (the hardware graph), not something the
    collector itself needs. None (not 0) when a field has no samples yet, same
    fail-open convention as every field in hardware_stats.get_snapshot()."""

    def avg(get):
        values = [v for v in (get(entry) for entry in history) if v is not None]
        return sum(values) / len(values) if values else None

    return {
        "cpuPercent": avg(lambda e: e["cpuPercent"]),
        "cpuTemperatureCelsius": avg(lambda e: e["cpuTemperatureCelsius"]),
        "ramUsedBytes": avg(lambda e: e["ram"]["usedBytes"] if e["ram"] else None),
        "diskUsedBytes": avg(lambda e: e["disk"]["usedBytes"] if e["disk"] else None),
        "gpuUtilizationPercent": avg(lambda e: e["gpu"]["utilizationPercent"] if e["gpu"] else None),
        "gpuVramUsedMiB": avg(lambda e: e["gpu"]["vramUsedMiB"] if e["gpu"] else None),
        "gpuTemperatureCelsius": avg(lambda e: e["gpu"]["temperatureCelsius"] if e["gpu"] else None),
    }


@hardware_bp.route("/api/hardware/stats")
def api_hardware_stats():
    # hardware_stats' own functions never raise (see that module's fail-open docstring --
    # every field independently degrades to None instead), so there's no try/except here:
    # a fresh dashboard with an empty/nonexistent hardware-stats.db and no GPU still
    # returns 200 with "history": [] and "gpu"/averages fields as None, never an error.
    snapshot = hardware_stats.get_snapshot()
    history = hardware_stats.get_history()
    return jsonify({
        "current": snapshot,
        "history": history,
        "averages": _hardware_history_averages(history),
    })
