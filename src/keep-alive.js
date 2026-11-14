'use strict';
// Owner rule (2026-11-06): the local model is never unloaded and never swapped. Every request to Ollama carries a per-request keep_alive that
// OVERRIDES the server's OLLAMA_KEEP_ALIVE (last request wins), so one caller sending '30m' or 0 shortens the expiry for everyone. This module is
// the single definition of what keep_alive may be. Ollama rejects the STRING '-1' with HTTP 400 ('missing unit in duration', brain dump #1631), so
// the working form is a very long Go duration, the same value agent-manager.env sets as LOCAL_KEEP_ALIVE.
const NEVER_EXPIRE = '8760h';
const NEVER_EXPIRE_MS = 8760 * 3600 * 1000;

// Parses a Go-style duration ('30m', '1h30m', '8760h', '90s', '0') or a bare number of seconds into ms; null when unparseable.
function parseKeepAliveMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 0 ? Infinity : v * 1000;
  const s = String(v).trim();
  if (s === '-1') return Infinity;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const unit = { h: 3600000, m: 60000, s: 1000, ms: 1 };
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (!parts.length || parts.map((p) => p[0]).join('') !== s) return null;
  return parts.reduce((t, p) => t + Number(p[1]) * unit[p[2]], 0);
}

// Returns NEVER_EXPIRE unless the supplied value is already at least that long. A shorter, zero or unparseable value is ignored (one warning).
function resolveKeepAlive(...candidates) {
  const supplied = candidates.find((c) => c != null && c !== '');
  if (supplied == null) return NEVER_EXPIRE;
  const ms = parseKeepAliveMs(supplied);
  if (ms !== null && ms >= NEVER_EXPIRE_MS) return ms === Infinity ? NEVER_EXPIRE : String(supplied);
  console.warn(`[keep-alive] ignoring keep_alive=${JSON.stringify(supplied)}: the local model must never unload, using ${NEVER_EXPIRE}`);
  return NEVER_EXPIRE;
}

module.exports = { NEVER_EXPIRE, NEVER_EXPIRE_MS, parseKeepAliveMs, resolveKeepAlive };
