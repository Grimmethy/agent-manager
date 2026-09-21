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

module.exports = { ollamaLockKey, localOllamaLockKey, p40OllamaLockKey };
