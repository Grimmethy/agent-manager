'use strict';

// Best-effort LIVE GPU/model VRAM query -- the inputs gpu-capacity.js's math needs, gathered
// from nvidia-smi and Ollama's own /api/ps. Any failure here (no GPU, nvidia-smi missing,
// Ollama unreachable) resolves to null; callers fall back to their previous fixed defaults,
// same fail-open philosophy as check_budget_healthy/gpu-guard.js elsewhere in this pipeline --
// this is a sizing hint, not a correctness gate.

const { execFileSync } = require('child_process');
const http = require('http');

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

function queryLoadedModel(ollamaUrl, modelName) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    const req = http.get(`${ollamaUrl}/api/ps`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const models = parsed.models || [];
          const m = models.find((x) => x.name === modelName || x.model === modelName) || models[0];
          if (!m || !(m.size_vram > 0)) return finish(null);
          finish({ modelWeightMiB: m.size_vram / (1024 * 1024), numCtx: m.context_length || null });
        } catch {
          finish(null);
        }
      });
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => { req.destroy(); finish(null); });
  });
}

module.exports = { queryVram, queryLoadedModel };
