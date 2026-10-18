'use strict';

// The serialization key for ONE Ollama endpoint (== one physical GPU): `ollama-<host>-<port>`. gpu-arbiter.js keys its tickets and the real flock by this (lockKey), so
// two callers contend exactly when they hit the same endpoint. Extracted from draft-lifecycle.js (which re-exports localOllamaLockKey unchanged) so the interactive
// chat can use the SAME definition: until 2026-09-21 the chat keyed its tickets by MODEL NAME while every worker draft keyed by endpoint, so the chat and the local
// lane never saw each other (no priority, no takeover, no mutual exclusion) even though they share one GPU.

function ollamaLockKey(url) {
  const raw = url || 'http://localhost:11434';
  try {
    const u = new URL(raw);
    return `ollama-${u.hostname}-${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return `ollama-${raw}`;
  }
}

// The endpoint THIS process talks to (its OLLAMA_URL; the host's own Ollama when unset).
function localOllamaLockKey(env = process.env) {
  return ollamaLockKey(env.OLLAMA_URL);
}

// The P40 VM's endpoint key, or null when no P40 lane is configured (see lanes.js).
function p40OllamaLockKey(env = process.env) {
  return env.AGENT_MANAGER_P40_OLLAMA_URL ? ollamaLockKey(env.AGENT_MANAGER_P40_OLLAMA_URL) : null;
}

// Endpoint keys of every lane that is NOT the host GPU's -- the P40 and any lanes-registry lane (src/lanes.js). The interactive chat takes over
// the HOST GPU only (2026-09-21, "only take over the 3090. P40 should remain in action"), so its `--local` key must never resolve to one of
// these. Replaces the P40-only check now that lanes are data (2026-10-17); falls back to the P40 key if lanes.js cannot be loaded.
function remoteLaneLockKeys(env = process.env) {
  const keys = [];
  try {
    for (const l of require('../lanes.js').getLanes(env)) if (!l.local && l.env && l.env.OLLAMA_URL) keys.push(ollamaLockKey(l.env.OLLAMA_URL));
  } catch { /* lanes.js unreadable: the P40 key below is still enforced */ }
  // Always also the P40 URL on its own: the old guard refused it whenever AGENT_MANAGER_P40_OLLAMA_URL was set, even if the P40 lane
  // itself was incomplete (no model) and so absent from getLanes(). A safety check must not get weaker because a lane is half-configured.
  const p40 = p40OllamaLockKey(env);
  if (p40 && !keys.includes(p40)) keys.unshift(p40);
  return keys;
}

module.exports = { ollamaLockKey, localOllamaLockKey, p40OllamaLockKey, remoteLaneLockKeys };
