'use strict';

// Best-effort LIVE GPU VRAM query, gathered from nvidia-smi. Any failure here (no GPU,
// nvidia-smi missing) resolves to null; callers fall back to their previous fixed
// defaults, same fail-open philosophy as check_budget_healthy/gpu-guard.js elsewhere in
// this pipeline -- this is a sizing hint, not a correctness gate.

const { execFileSync } = require('child_process');

function queryVram() {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 5000 },
    );
    const [totalStr, usedStr] = out.trim().split('\n')[0].split(',').map((s) => s.trim());
    const totalVramMiB = Number(totalStr);
    const usedVramMiB = Number(usedStr);
    if (!Number.isFinite(totalVramMiB) || !Number.isFinite(usedVramMiB)) return null;
    return { totalVramMiB, usedVramMiB };
  } catch {
    return null;
  }
}

module.exports = { queryVram };
