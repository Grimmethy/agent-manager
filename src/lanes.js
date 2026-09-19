'use strict';

// The pipeline's worker lanes -- ONE per GPU, named for the GPU (worker-3090, worker-p40).
//
// Replaces the old worker-1 / worker-reasoning / worker-p40 / worker-reasoning-p40 layout
// (2026-09-19, Grimmethy: "merge worker and reasoning... just turn them into GPU lanes. The lane
// name should be the GPU that is running it. All tasks are just tasks that get picked up based on
// the priority list."). The reasoning/worker split existed to route high-tier work to a different
// model; with every lane on a local model the only real difference is the GPU. Lane identity used
// to be hard-coded separately in launch.sh, dead-process-check.js and the dashboard; this is now
// the single definition all of them read.
//
// The local (host) lane is named from AGENT_MANAGER_LOCAL_GPU, else the first `nvidia-smi` GPU
// ("NVIDIA GeForce RTX 3090" -> 3090), else 'local'. A second lane, worker-p40, exists when
// AGENT_MANAGER_P40_OLLAMA_URL and AGENT_MANAGER_P40_MODEL are both set (a P40 passed through
// to a VM, with its own Ollama).

const { execFileSync } = require('child_process');

let detectedGpu; // cached per process

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// "NVIDIA GeForce RTX 3090" -> "3090"; "Tesla P40" -> "p40". Last name token containing a digit.
function gpuSlugFromName(name) {
  const tokens = String(name || '').trim().split(/\s+/).filter((t) => /\d/.test(t));
  return tokens.length ? slug(tokens[tokens.length - 1]) : '';
}

function detectLocalGpu() {
  if (detectedGpu !== undefined) return detectedGpu;
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    detectedGpu = gpuSlugFromName(out.split('\n')[0]);
  } catch {
    detectedGpu = '';
  }
  return detectedGpu;
}

// -> [{ id, gpu, env }]. `env` is the per-lane environment launch.sh / the watchdog must apply
// when spawning the lane ({} = inherit, i.e. the host's own Ollama).
function getLanes(env = process.env) {
  const local = slug(env.AGENT_MANAGER_LOCAL_GPU) || detectLocalGpu() || 'local';
  const lanes = [{ id: `worker-${local}`, gpu: local, env: {} }];
  if (env.AGENT_MANAGER_P40_OLLAMA_URL && env.AGENT_MANAGER_P40_MODEL) {
    lanes.push({
      id: 'worker-p40',
      gpu: 'p40',
      // GPU_YIELD_APPS emptied: the yield-to-ComfyUI check watches the HOST GPU, not the P40's.
      env: {
        OLLAMA_URL: env.AGENT_MANAGER_P40_OLLAMA_URL,
        LOCAL_MODEL: env.AGENT_MANAGER_P40_MODEL,
        AGENT_MANAGER_GPU_YIELD_APPS: '',
      },
    });
  }
  return lanes;
}

function laneById(id, env = process.env) {
  return getLanes(env).find((l) => l.id === id) || null;
}

module.exports = { getLanes, laneById, gpuSlugFromName };

if (require.main === module) {
  const [flag, arg] = process.argv.slice(2);
  const lanes = getLanes();
  if (flag === '--ids') {
    for (const l of lanes) console.log(l.id);
  } else if (flag === '--env') {
    // KEY=VALUE lines for one lane, for `env "${lane_env[@]}" bash local-worker.sh <id>`.
    const lane = lanes.find((l) => l.id === arg);
    if (!lane) { console.error(`unknown lane: ${arg}`); process.exit(1); }
    for (const [k, v] of Object.entries(lane.env)) console.log(`${k}=${v}`);
  } else {
    console.log(JSON.stringify(lanes));
  }
}
