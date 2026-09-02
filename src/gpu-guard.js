'use strict';

// GPU headroom guard: before spending a local-model call, check whether the GPU actually has
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
// pipeline can identify AND has a real, sanctioned control surface for:
//   1. ComfyUI's own POST /free -- unloads models + frees VRAM without stopping the
//      server (it reloads on the next prompt). Same as its "Unload Models" button.
//      This is the usual case now that PromptForge and manual launches run ComfyUI
//      standalone, where TheAgent's app registry never saw it.
//   2. TheAgent's automation-apps API (server/automationApps.js, see docs there), which
//      tracks n8n/ComfyUI as managed jobs with a proper start/stop lifecycle -- calling
//      its /stop is the same action a human clicking "Stop" in TheAgent's UI would take.
// Neither is a raw `kill` on a process this pipeline doesn't own.
//
// It also treats Ollama's own resident model (GET /api/ps -> size_vram) as *expected*
// occupancy: once the local model is loaded there is always less than minFreeMb free,
// and that's the pipeline running, not starvation -- so that state reports "ok", not a
// per-tick "still starved" line.
//
// CLI: node gpu-guard.js   -- best-effort, always exits 0; callers (local-worker.sh,
// review-runner.sh) run this once per tick and never let its outcome block the tick
// itself, same "network/external state is unreliable, log and move on" treatment
// project-search-fetch.js's own try/catch gives its own external call.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ComfyUI GPU lease (2026-08-30). PromptForge writes this file only when starting
// ComfyUI would collide with the resident local model on a single GPU. While it's held
// (fresh), this guard must NOT unload ComfyUI or Ollama -- PromptForge owns the card for
// that generation, and local-worker.sh / review-runner.sh are yielding their ticks too.
// Absent / expired / stomped -> returns false and the existing /free reclaim path runs
// unchanged (that is the pipeline-reclaims-an-idle-ComfyUI direction, already working).
const COMFY_LEASE_PATH = process.env.AGENT_MANAGER_COMFY_LEASE_PATH
  || path.join(os.homedir(), '.local', 'state', 'agent-manager', 'comfyui-lease.json');
const COMFY_LEASE_TTL_S = Number(process.env.AGENT_MANAGER_COMFY_LEASE_TTL_S) || 90;
// Hard ceiling: a stuck/runaway generation can never keep the pipeline yielded past this,
// no matter how fresh its refreshedAt looks.
const COMFY_LEASE_MAX_S = Number(process.env.AGENT_MANAGER_COMFY_LEASE_MAX_S) || 900;

function comfyuiLeaseHeld(leasePath = COMFY_LEASE_PATH) {
  try {
    const d = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    const now = Date.now();
    const refreshed = Date.parse(d.refreshedAt);
    const acquired = Date.parse(d.acquiredAt);
    if (!Number.isFinite(refreshed) || !Number.isFinite(acquired)) return false;
    return (now - refreshed) <= COMFY_LEASE_TTL_S * 1000
      && (now - acquired) <= COMFY_LEASE_MAX_S * 1000;
  } catch (e) {
    // No file / unreadable / malformed -- not held. Fail open.
    return false;
  }
}

const MIN_FREE_VRAM_MB = Number(process.env.AGENT_MANAGER_MIN_FREE_VRAM_MB) || 4096;
const THEAGENT_URL = process.env.AGENT_MANAGER_THEAGENT_URL || 'http://localhost:4519';
// ComfyUI exposes its own POST /free -- it unloads models and frees VRAM without
// stopping the server (it reloads on the next prompt). That's the usual contention
// case: ComfyUI started standalone (PromptForge, a manual launch) that TheAgent's
// app registry never saw, so the TheAgent /stop path below finds nothing to stop.
// Hitting /free is the same action as ComfyUI's own "Unload Models" button, not a
// raw kill -- so it fits this guard's "sanctioned control surface only" charter.
const COMFY_URL = process.env.AGENT_MANAGER_COMFY_URL || process.env.COMFY_URL || 'http://127.0.0.1:8188';
// Ollama's own resident model is *expected* GPU occupancy, not contention -- once the
// local model is loaded there will always be less than minFreeMb free, and that's the
// pipeline working, not a problem. Ask Ollama what it has resident (GET /api/ps ->
// models[].size_vram) so the guard can tell "the model is loaded and running" apart
// from "something foreign is sitting on the card".
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
// Below this, a /api/ps entry is a rounding artefact / tiny embed model, not "the model
// is resident" -- a real LLM is multiple GB.
const OLLAMA_RESIDENT_MIN_MB = 1024;
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
    // take the first line, matching how OLLAMA_URL/local-client.js is itself single-GPU
    // in every deployment this pipeline has actually run on.
    const first = out.trim().split('\n')[0];
    const mb = Number(first.trim());
    return Number.isFinite(mb) ? mb : null;
  } catch (e) {
    // No nvidia-smi (CPU-only box, or a driver hiccup) -- nothing to guard, not an error.
    return null;
  }
}

// MB of VRAM Ollama reports as resident (sum of loaded models' size_vram), or null if
// Ollama can't be reached / says nothing is loaded.
async function readOllamaVramMb(fetchJsonFn, ollamaUrl = OLLAMA_URL) {
  const res = await fetchJsonFn(`${ollamaUrl}/api/ps`, {}, 5000);
  if (!res || !res.ok || !res.body || !Array.isArray(res.body.models)) return null;
  const bytes = res.body.models.reduce((sum, m) => sum + (Number(m.size_vram) || 0), 0);
  return Math.round(bytes / (1024 * 1024));
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
  comfyUrl = COMFY_URL,
  ollamaUrl = OLLAMA_URL,
  yieldAppIds = YIELD_APP_IDS,
  readFreeVram = readFreeVramMb,
  fetchJsonFn = fetchJson,
  leaseHeld = comfyuiLeaseHeld,
} = {}) {
  // PromptForge holds the GPU for an image generation that wouldn't fit alongside the
  // resident local model. Don't touch ComfyUI or Ollama this tick -- the local-model
  // lanes are yielding too (see comfyui_lease_held in agent-manager-common.sh). An
  // absent/expired/stomped lease -> leaseHeld() is false and the normal path below runs.
  if (leaseHeld()) {
    return { checked: true, freeMb: null, minFreeMb, starved: false, yielded: [], freed: [],
             note: 'comfyui-lease held -- PromptForge owns the GPU; not touching ComfyUI or Ollama this tick' };
  }

  const freeMb = readFreeVram();
  if (freeMb === null) return { checked: false, freeMb: null, minFreeMb, starved: false, yielded: [], freed: [], note: 'nvidia-smi unavailable' };
  if (freeMb >= minFreeMb) return { checked: true, freeMb, minFreeMb, starved: false, yielded: [], freed: [], note: '' };

  // Starved. First the control surface that needs nothing else running: ask ComfyUI
  // to unload its models via its own POST /free. This covers a standalone ComfyUI
  // (the common case) and is a no-op 200 if it is already unloaded.
  const freed = [];
  const freeRes = await fetchJsonFn(
    `${comfyUrl}/free`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) },
    10000,
  );
  let freeAfterMb = freeMb;
  if (freeRes && freeRes.ok) {
    freed.push('comfyui');
    const afterMb = readFreeVram();
    if (afterMb !== null) freeAfterMb = afterMb;
    if (afterMb !== null && afterMb >= minFreeMb) {
      return { checked: true, freeMb: afterMb, minFreeMb, starved: false, yielded: [], freed, note: `GPU was starved (${freeMb}MB free) -- ComfyUI /free recovered it to ${afterMb}MB` };
    }
  }

  // Still below the target. If Ollama already has a model resident, that IS the
  // shortfall -- the local model is loaded and running, which is the goal, not
  // contention. Only escalate when the held VRAM isn't Ollama's own model.
  const ollamaMb = await readOllamaVramMb(fetchJsonFn, ollamaUrl);
  if (ollamaMb !== null && ollamaMb >= OLLAMA_RESIDENT_MIN_MB) {
    return {
      checked: true,
      freeMb: freeAfterMb,
      minFreeMb,
      starved: false,
      yielded: [],
      freed,
      note: `${freeAfterMb}MB free is under the ${minFreeMb}MB target, but ${ollamaMb}MB is Ollama's own resident model -- expected${freed.length ? `; freed ${freed.join(', ')}` : ''}`,
    };
  }

  // Still starved (or no standalone ComfyUI): find which allowlisted apps TheAgent
  // reports as actually running and ask it to stop each -- through its own tracked
  // job lifecycle, not a raw kill.
  const statusResult = await fetchJsonFn(`${theAgentUrl}/api/automation/apps`);
  if (!statusResult.ok || !statusResult.body || !Array.isArray(statusResult.body.apps)) {
    return { checked: true, freeMb, minFreeMb, starved: true, yielded: [], freed, note: `GPU starved (${freeMb}MB free)${freed.length ? ', ComfyUI /free did not free enough' : ''} -- could not reach TheAgent at ${theAgentUrl} to check for yieldable apps` };
  }

  const runningYieldable = statusResult.body.apps.filter((a) => yieldAppIds.includes(a.id) && a.running);
  const stopResults = await Promise.all(
    runningYieldable.map((app) =>
      fetchJsonFn(`${theAgentUrl}/api/automation/apps/${app.id}/stop`, { method: 'POST' }, 15000).catch(() => null),
    ),
  );
  const yielded = runningYieldable.filter((app, i) => stopResults[i] && stopResults[i].ok).map((app) => app.id);

  const acted = [...freed.map((f) => `${f} (/free)`), ...yielded];
  return {
    checked: true,
    freeMb,
    minFreeMb,
    starved: true,
    yielded,
    freed,
    note: acted.length === 0
      ? `GPU starved (${freeMb}MB free, need ${minFreeMb}MB) but no allowlisted app (${yieldAppIds.join(', ')}) is running or reachable -- contention is from something this pipeline has no control surface for`
      : `GPU starved (${freeMb}MB free, need ${minFreeMb}MB) -- acted on: ${acted.join(', ')}`,
  };
}

module.exports = { ensureGpuHeadroom, readFreeVramMb, comfyuiLeaseHeld };

if (require.main === module) {
  ensureGpuHeadroom().then((result) => {
    if (result.note) {
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
