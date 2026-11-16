"""Call and token rates of the cloud lanes, for the cloud-dial panel (feature cloud-agent-pool, FF-3c). Pure apart from the injected `fetch(url, timeout)`; nothing here knows the
dashboard, the filesystem or a clock (callers pass `now`).

Every cloud lane talks to a cloud-providers gateway whose GET /meter answers {monthToDate: {calls, inputTokens, outputTokens, ...}, today: {...}, ...}. The gateways keep SEPARATE
ledgers (checked 2026-11-16: :7450 and :7480 report different totals), so their counters are summed. If two endpoints ever report the identical non-zero (calls, input, output)
triple they are treated as ONE shared ledger and counted once, so a future shared ledger cannot double the rate.

read_gateways(lanes, fetch) -> {"readings": {endpoint: (calls, tokens)}, "unavailable": [lane ids], "sharedLedgers": n}   (parallel; a down or garbled gateway is unavailable, never an exception)
RateRing(window_s).add(now, readings); .rates(now) -> {"callsPerHour", "tokensPerHour", "windowS"} or the same keys None until two readings exist.
"""
from concurrent.futures import ThreadPoolExecutor

METER_TIMEOUT_S = 3
WINDOW_S = 600
MAX_WORKERS = 16


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def meter_totals(meter):
    """(calls, input tokens, output tokens) from a /meter answer's monthToDate block, or None when it is not a usable meter. monthToDate is monotonic within a month; `today` resets daily."""
    block = meter.get("monthToDate") if isinstance(meter, dict) else None
    if not isinstance(block, dict):
        return None
    calls, tin, tout = _count(block.get("calls")), _count(block.get("inputTokens")), _count(block.get("outputTokens"))
    if calls is None or tin is None or tout is None:
        return None
    return calls, tin, tout


def _endpoint(lane):
    env = lane.get("env") if isinstance(lane, dict) else None
    return str((env or {}).get("OLLAMA_URL") or "").rstrip("/")


def read_gateways(lanes, fetch, timeout=METER_TIMEOUT_S):
    """Fetch /meter from every distinct cloud endpoint in parallel. `lanes` are lane definitions ({id, cloud, env: {OLLAMA_URL}}); only cloud lanes are read."""
    by_endpoint = {}
    for lane in lanes if isinstance(lanes, list) else []:
        if not isinstance(lane, dict) or lane.get("cloud") is not True:
            continue
        endpoint = _endpoint(lane)
        if endpoint:
            by_endpoint.setdefault(endpoint, []).append(lane.get("id"))

    def one(endpoint):
        try:
            return endpoint, meter_totals(fetch(endpoint + "/meter", timeout))
        except Exception:  # noqa: BLE001 - down, timed out, refused, not JSON: all mean "not available right now"
            return endpoint, None

    results = {}
    if by_endpoint:
        with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(by_endpoint))) as pool:
            results = dict(pool.map(one, sorted(by_endpoint)))
    readings, unavailable, seen_ledgers, shared = {}, [], {}, 0
    for endpoint in sorted(by_endpoint):
        totals = results.get(endpoint)
        if totals is None:
            unavailable.extend(i for i in by_endpoint[endpoint] if i)
            continue
        if any(totals) and totals in seen_ledgers:
            shared += 1
            continue
        seen_ledgers[totals] = endpoint
        readings[endpoint] = (totals[0], totals[1] + totals[2])
    return {"readings": readings, "unavailable": sorted(unavailable), "sharedLedgers": shared}


class RateRing:
    """Recent readings (time, {endpoint: (calls, tokens)}); the rate is measured between the oldest and newest reading inside the window, per endpoint present in both, so a gateway that
    went down or came up between them, or whose counter was reset (month rollover), is left out instead of producing a negative or inflated rate."""

    def __init__(self, window_s=WINDOW_S):
        self.window_s = window_s
        self._rows = []

    def add(self, now, readings):
        if not isinstance(readings, dict):
            return
        self._rows.append((float(now), dict(readings)))
        cutoff = float(now) - self.window_s
        self._rows = [row for row in self._rows if row[0] >= cutoff]

    def rates(self, now=None):
        none = {"callsPerHour": None, "tokensPerHour": None, "windowS": None}
        if len(self._rows) < 2:
            return none
        (t0, old), (t1, new) = self._rows[0], self._rows[-1]
        dt = t1 - t0
        if dt <= 0:
            return none
        calls = tokens = 0
        used = 0
        for endpoint, (c1, k1) in new.items():
            if endpoint not in old:
                continue
            c0, k0 = old[endpoint]
            if c1 < c0 or k1 < k0:
                continue
            calls += c1 - c0
            tokens += k1 - k0
            used += 1
        if used == 0:
            return none
        return {"callsPerHour": round(calls * 3600 / dt, 1), "tokensPerHour": round(tokens * 3600 / dt, 1), "windowS": round(dt)}
