'use strict';

// Resolve the GPU broker URL from the environment. Precedence: `GPU_BROKER_URL` wins
// if set (truthy), otherwise the caller-provided `fallback` is returned unchanged.
// A trailing slash is always stripped from the resolved URL so callers get a clean
// base URL regardless of how the value was configured.

function brokerUrlFromEnv(env, fallback) {
  const raw = env && env.GPU_BROKER_URL;
  if (raw) {
    return String(raw).replace(/\/$/, '');
  }
  return fallback;
}

module.exports = { brokerUrlFromEnv };
