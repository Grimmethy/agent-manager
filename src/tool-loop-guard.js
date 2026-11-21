'use strict';

// Deterministic tool-loop guard (HUB0259 1/2). Pure: no I/O, no timers, no model calls.
// observe({ tool, args, resultText, atMs }) returns { verdict: 'ok' | 'suspect' | 'stop', layer, count, reason }.

const POLL_TOLERANCE = 0.1;

const DEFAULTS = {
  layer1_consecutive: 4,
  layer2_window: 12,
  layer2_threshold: 2,
  layer3_window: 16,
  layer3_threshold: 4,
  layer4_window: 128,
  layer4_distinct: 32,
  layer4_frequent_count: 4,
  layer4_frequent_pct: 0.9,
};

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function resolveOptions(options) {
  const cfg = {};
  for (const name of Object.keys(DEFAULTS)) {
    const v = options[name];
    cfg[name] = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULTS[name];
  }
  return cfg;
}

function resolveEnabled(options) {
  if (typeof options.enabled === 'boolean') return options.enabled;
  if (options.source === 'chat') return process.env.AGENT_MANAGER_CHAT_LOOP_GUARD !== 'off';
  return false;
}

function okResult() {
  return { verdict: 'ok', layer: null, count: 0, reason: '' };
}

function createToolLoopGuard(options) {
  const opts = options || {};
  const cfg = resolveOptions(opts);
  const enabled = resolveEnabled(opts);
  const cap = Math.max(cfg.layer2_window, cfg.layer3_window, cfg.layer4_window);
  const history = []; // entries: { key, argsKey, tool, atMs }
  let runKey = null;
  let runLength = 0;
  let runAt = [];
  let episodeActive = false;

  // Polling: regular spacing of the current identical run. No timers; uses injected atMs only.
  function isPolling() {
    const need = cfg.layer1_consecutive - 1;
    if (runAt.length < 2 || runAt.length - 1 < need) return false;
    const deltas = [];
    for (let i = 1; i < runAt.length; i++) {
      const a = runAt[i - 1];
      const b = runAt[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      const d = b - a;
      if (!(d > 0)) return false;
      deltas.push(d);
    }
    const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length;
    const spread = Math.max(...deltas) - Math.min(...deltas);
    return spread <= POLL_TOLERANCE * mean;
  }

  function checkLayer1(tool) {
    if (runLength < cfg.layer1_consecutive) return null;
    const reason = isPolling()
      ? `identical call to ${tool} repeated ${runLength} times at a regular interval (polling)`
      : `identical call to ${tool} repeated ${runLength} times in a row`;
    return { layer: 1, count: runLength, reason };
  }

  function checkLayer2() {
    const w = cfg.layer2_window;
    if (history.length < w) return null;
    const win = history.slice(-w);
    const byTool = new Map();
    for (const e of win) {
      if (!byTool.has(e.tool)) byTool.set(e.tool, []);
      byTool.get(e.tool).push(e);
    }
    for (const [tool, calls] of byTool) {
      if (calls.length < Math.floor(w / 2)) continue;
      const argKeys = new Set(calls.map((c) => c.argsKey));
      if (argKeys.size <= cfg.layer2_threshold) {
        return {
          layer: 2,
          count: calls.length,
          reason: `${tool} called ${calls.length} times in the last ${w} calls with only ${argKeys.size} distinct input(s)`,
        };
      }
    }
    return null;
  }

  function checkLayer3() {
    const maxP = cfg.layer3_threshold >= 1 ? Math.floor(cfg.layer3_window / cfg.layer3_threshold) : 0;
    for (let p = 2; p <= maxP; p++) {
      const n = cfg.layer3_threshold * p;
      if (history.length < n) break;
      const win = history.slice(-n);
      let periodic = true;
      for (let i = p; i < n; i++) {
        if (win[i].key !== win[i - p].key) { periodic = false; break; }
      }
      if (!periodic) continue;
      if (new Set(win.map((e) => e.key)).size !== p) continue;
      return { layer: 3, count: cfg.layer3_threshold, reason: `a ${p}-call rotation repeated ${cfg.layer3_threshold} times` };
    }
    return null;
  }

  function checkLayer4() {
    const w = cfg.layer4_window;
    if (history.length < w) return null;
    const freq = new Map();
    for (const e of history.slice(-w)) freq.set(e.key, (freq.get(e.key) || 0) + 1);
    if (freq.size > cfg.layer4_distinct) return null;
    let top = 0;
    for (const c of freq.values()) if (c > top) top = c;
    const need = Math.max(cfg.layer4_frequent_count, Math.ceil(cfg.layer4_frequent_pct * w));
    if (top < need) return null;
    return { layer: 4, count: top, reason: `one input repeated ${top} times in the last ${w} calls (long read window)` };
  }

  function observe(call) {
    if (!enabled) return okResult();
    const c = call || {};
    const tool = String(c.tool);
    const argsKey = stableStringify(c.args);
    const atMs = c.atMs;
    const key = JSON.stringify([tool, argsKey]);

    if (key === runKey) {
      runLength += 1;
      runAt.push(atMs);
    } else {
      runKey = key;
      runLength = 1;
      runAt = [atMs];
    }
    if (runAt.length > cap) runAt.shift();

    history.push({ key, argsKey, tool, atMs });
    if (history.length > cap) history.shift();

    const hit = checkLayer1(tool) || checkLayer2() || checkLayer3() || checkLayer4();
    if (!hit) {
      episodeActive = false;
      return okResult();
    }
    const verdict = episodeActive ? 'stop' : 'suspect';
    episodeActive = true;
    return { verdict, layer: hit.layer, count: hit.count, reason: hit.reason };
  }

  return { observe };
}

module.exports = { createToolLoopGuard };
