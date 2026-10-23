'use strict';

// Which GPU card does the next Chat turn run on? (2026-10-23, Grimmethy: "if we're already using the forge have [chat] reserve a different GPU. It
// doesn't always have to be the 3090 ... flexibility is important to maintain.") The Chat panel used to run on the host GPU only. Now each message
// resolves a card: the one the session asked for (a lane id such as worker-3090), else the host lane; if the Forge family's comfyui-lease covers that
// card's Ollama endpoint, chat MOVES to the next free lane and says so, and if every card is held it reports that instead of reloading a model over
// the Forge. A manual pick is always tried first. The card is only an Ollama endpoint + model (+ context/batch pins), so the choice is returned as the
// env overrides the node child needs; the lane's own definition (src/lanes.js) stays the single source.

const gpuGuard = require('./gpu-guard.js');
const { getLanes } = require('./lanes.js');
const { ollamaLockKey } = require('./lib/ollama-lock-key.js');

// The only lane env keys a chat child may be given: the endpoint, the model and the per-card pins. Anything else in a lane's env stays out.
const CARD_ENV_KEYS = ['OLLAMA_URL', 'LOCAL_MODEL', 'AGENT_MANAGER_LANE_NUM_CTX', 'AGENT_MANAGER_LANE_NUM_BATCH'];

function cardEnv(lane) {
  const out = {};
  for (const k of CARD_ENV_KEYS) if (lane.env && lane.env[k]) out[k] = String(lane.env[k]);
  return out;
}

function laneUrl(lane, hostUrl) {
  return (lane.env && lane.env.OLLAMA_URL) || hostUrl;
}

// Pure. lanes: getLanes() shape. preferred: a lane id or ''/null. isHeld(url): is that endpoint under a fresh Forge lease.
// -> { lane, env, moved, from, note, blocked, local, lockKey }. lane is null only when blocked or the preferred id is unknown. local = the host GPU's lane;
// lockKey = the GPU arbiter's key for the card's Ollama endpoint (what chat_preempt cancels the lane's draft by).
function chooseChatCard({ lanes, preferred, hostUrl, isHeld }) {
  const all = (lanes || []).filter((l) => l && l.id);
  const host = all.find((l) => l.local) || null;
  const want = preferred ? String(preferred).trim() : '';
  if (want && !all.some((l) => l.id === want)) {
    return { lane: null, env: {}, moved: false, from: null, blocked: true, note: `Unknown card "${want}". Cards: ${all.map((l) => l.id).join(', ') || 'none'}.` };
  }
  const first = (want && all.find((l) => l.id === want)) || host || all[0] || null;
  if (!first) return { lane: null, env: {}, moved: false, from: null, blocked: true, note: 'No GPU card is configured for chat.' };
  const order = [first, ...(host && host !== first ? [host] : []), ...all.filter((l) => l !== first && l !== host)];
  const free = order.find((l) => !isHeld(laneUrl(l, hostUrl)));
  if (!free) {
    return { lane: null, env: {}, moved: false, from: first.id, blocked: true, note: 'Every GPU card is held by the Forge family right now, so chat cannot start a model. Try again when the render finishes.' };
  }
  const moved = free !== first;
  return {
    lane: free.id,
    local: !!free.local,
    lockKey: ollamaLockKey(laneUrl(free, hostUrl)),
    env: cardEnv(free),
    moved,
    from: moved ? first.id : null,
    blocked: false,
    note: moved ? `The Forge is using ${first.gpu || first.id}, so this reply runs on ${free.gpu || free.id}.` : '',
  };
}

// The real thing: lane definitions from src/lanes.js, the host endpoint from this process's env, held-ness from the real lease.
function resolveChatCard(preferred, env = process.env, deps = {}) {
  const lanes = (deps.getLanes || getLanes)(env);
  const hostUrl = env.OLLAMA_URL || 'http://localhost:11434';
  const isHeld = deps.isHeld || ((url) => gpuGuard.leaseHeldFor(url));
  return chooseChatCard({ lanes, preferred, hostUrl, isHeld });
}

module.exports = { chooseChatCard, resolveChatCard, cardEnv, CARD_ENV_KEYS };

if (require.main === module) {
  const i = process.argv.indexOf('--card');
  const preferred = i >= 0 ? process.argv[i + 1] : '';
  process.stdout.write(`${JSON.stringify(resolveChatCard(preferred))}\n`);
}
