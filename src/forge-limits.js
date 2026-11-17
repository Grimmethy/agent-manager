'use strict';

// Single source of truth for forge-mode limits: key, env var, default.
const TABLE = Object.freeze([
  Object.freeze({ key: 'minAvailMB', envName: 'FORGE_MODE_MIN_AVAIL_MB', def: 10240 }),
  Object.freeze({ key: 'maxIoSome10', envName: 'FORGE_MODE_MAX_IO', def: 50 }),
  Object.freeze({ key: 'vmMB', envName: 'FORGE_MODE_VM_MB', def: 4300 }),
]);

// Resolve the limits from env. Unset (undefined / whitespace-only) values use
// the default silently; invalid values (non-finite or negative) use the
// default and add a warning. Returns a fresh warnings array on every call.
function limits(env = process.env) {
  const warnings = [];
  const out = {};
  for (const { key, envName, def } of TABLE) {
    const raw = env[envName];
    if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      out[key] = def;
      continue;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      out[key] = n;
    } else {
      out[key] = def;
      warnings.push(`${envName}=${JSON.stringify(raw)} is not a finite non-negative number; using default ${def}`);
    }
  }
  return { limits: { minAvailMB: out.minAvailMB, maxIoSome10: out.maxIoSome10, vmMB: out.vmMB }, warnings };
}

module.exports = { limits };
