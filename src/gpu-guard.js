'use strict';

// GPU headroom guard: before spending an Ornith call, check whether the GPU actually has
// room for it, and if not, proactively stop the known apps that could be sitting on VRAM
// unused. Added 2026-08-16 after a live incident: ComfyUI (a completely separate project,
// not run in hours -- confirmed by the user, not just idle-looking) was still holding
// ~7GB of VRAM, leaving the RTX 3090 at 23013/24576 MiB used. With that little headroom,
// every single Ollama call for ornith:35b timed out at REQUEST_TIMEOUT_MS (240s) --
// not a crash, not a queue bug, just silent GPU starvation -- and produced hours of
// accumulated, misleading "draft call failed" retries in queue/drafting/ that looked
// exactly like the unrelated bugs actually being investigated that session. Nothing in
// this pipeline previously looked at GPU state at all.
//
// Deliberately does NOT kill arbitrary GPU processes -- that's real user work this
// pipeline has no way to tell apart from an idle leftover. It only touches apps this
// pipeline can identify AND has a real, sanctioned control surface for: TheAgent's own
// automation-apps API (server/automationApps.js, see docs there), which already tracks
// n8n/ComfyUI as managed jobs with a proper start/stop lifecycle -- calling its /stop
// endpoint is the same action a human clicking "Stop" in TheAgent's own UI would take,
// not a raw `kill` on a process this pipeline doesn't own.
//
// CLI: node gpu-guard.js   -- best-effort, always exits 0; callers (ornith-worker.sh,
// review-runner.sh) run this once per tick and never let its outcome block the tick
// itself, same "network/external state is unreliable, log and move on" treatment
// project-search-fetch.js's own try/catch gives its own external call.

const { execFileSync } = require('child_process');

const MIN_FREE_VRAM_MB = Number(process.env.AGENT_MANAGER_MIN_FREE_VRAM_MB) || 4096;
const THEAGENT_URL = process.env.AGENT_MANAGER_THEAGENT_URL || 'http://localhost:4519';
// Apps this pipeline is allowed to ask TheAgent to stop when the GPU is starved --
// an explicit allowlist, not "every app TheAgent knows about", so a future addition to
// TheAgent's own APPS registry doesn't silently become something this pipeline can stop
// without a deliberate opt-in here.
const YIELD_APP_IDS = (process.env.AGENT_MANAGER_GPU_YIELD_APPS || 'comfyui,n8n')
  .split(',').map((s) => s.trim()).filter(Boolean);

function readFreeVramMb() {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 5000 },
    );
    // Multi-GPU boxes report one line per card; this pipeline only ever targets the one
    // Ollama is configured against, and nvidia-smi doesn't distinguish that for us here --
    // take the first line, matching how OLLAMA_URL/ornith-client.js is itself single-GPU
    // in every deployment this pipeline has actually run on.
    const first = out.trim().split('\n')[0];
    const mb = Number(first.trim());
    return Number.isFinite(mb) ? mb : null;
  } catch (e) {
    // No nvidia-smi (CPU-only box, or a driver hiccup) -- nothing to guard, not an error.
    return null;
  }
}

async function fetchJson(url, options = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

// Returns { checked, freeMb, minFreeMb, starved, yielded: [ids stopped], note }.
// Never throws -- every failure mode (no nvidia-smi, TheAgent not running, app already
// stopped, stop call itself fails) degrades to "did nothing" rather than blocking the
// caller's own tick.
async function ensureGpuHeadroom({
  minFreeMb = MIN_FREE_VRAM_MB,
  theAgentUrl = THEAGENT_URL,
  yieldAppIds = YIELD_APP_IDS,
  readFreeVram = readFreeVramMb,
  fetchJsonFn = fetchJson,
} = {}) {
  const freeMb = readFreeVram();
  if (freeMb === null) return { checked: false, freeMb: null, minFreeMb, starved: false, yielded: [], note: 'nvidia-smi unavailable' };
  if (freeMb >= minFreeMb) return { checked: true, freeMb, minFreeMb, starved: false, yielded: [], note: '' };

  // Starved: find which allowlisted apps TheAgent reports as actually running, and ask
  // it to stop each -- through its own tracked job lifecycle, not a raw kill.
  const statusResult = await fetchJsonFn(`${theAgentUrl}/api/automation/apps`);
  if (!statusResult.ok || !statusResult.body || !Array.isArray(statusResult.body.apps)) {
    return { checked: true, freeMb, minFreeMb, starved: true, yielded: [], note: `GPU starved (${freeMb}MB free) but could not reach TheAgent at ${theAgentUrl} to check for yieldable apps` };
  }

  const runningYieldable = statusResult.body.apps.filter((a) => yieldAppIds.includes(a.id) && a.running);
  const yielded = [];
  for (const app of runningYieldable) {
    const stopResult = await fetchJsonFn(`${theAgentUrl}/api/automation/apps/${app.id}/stop`, { method: 'POST' }, 15000);
    if (stopResult.ok) yielded.push(app.id);
  }

  return {
    checked: true,
    freeMb,
    minFreeMb,
    starved: true,
    yielded,
    note: runningYieldable.length === 0
      ? `GPU starved (${freeMb}MB free, need ${minFreeMb}MB) but no allowlisted app (${yieldAppIds.join(', ')}) is currently running -- contention is from something this pipeline has no control surface for`
      : `GPU starved (${freeMb}MB free, need ${minFreeMb}MB) -- asked TheAgent to stop: ${yielded.join(', ') || '(all stop attempts failed)'}`,
  };
}

module.exports = { ensureGpuHeadroom, readFreeVramMb };

if (require.main === module) {
  ensureGpuHeadroom().then((result) => {
    if (result.starved) {
      console.error(`[gpu-guard] ${result.note}`);
    } else if (result.checked) {
      console.error(`[gpu-guard] ${result.freeMb}MB free (>= ${result.minFreeMb}MB min) -- ok`);
    }
    process.exit(0);
  }).catch((e) => {
    // Never let this daemon-adjacent check itself become the reason a tick fails.
    console.error(`[gpu-guard] check failed (non-fatal): ${e.message}`);
    process.exit(0);
  });
}
