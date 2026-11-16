'use strict';

// The cloud-agent dial (feature cloud-agent-pool, FF-3): ONE number for how many cloud lanes are allowed to run, with no upper bound.
//
// State is one file in a GLOBAL state directory, so it survives pipeline restarts and a change of active project (same idea as src/worker-switch.js):
//   $HOME/.local/state/agent-manager/cloud-dial.json      override the whole path with AGENT_MANAGER_CLOUD_DIAL_PATH (tests)
//   { count: non-negative integer | null, mode: 'manual' | 'auto', setAt, setBy }
// count null (or no file) means the dial is UNSET: today's behaviour, every enabled cloud lane runs. mode is carried for the burn manager (a later piece);
// nothing here acts on it.
//
// Lane order is defined ONCE, here: `cloud` first, then cloud2, cloud3 ... by NUMBER (cloud10 after cloud9, never after cloud1). A lane id may carry the
// `worker-` prefix of its instance id (worker-cloud3). isLaneOff(lane) is true only when a count is set and the lane's 0-based rank is >= count, so a dial
// of 3 keeps cloud, cloud2 and cloud3 and turns the rest off, a dial of 0 turns every cloud lane off, and a dial above the lane count turns none off.
//
// FAIL OPEN: a missing, unreadable or malformed file, a bad count, and a lane that is not in the cloud lane list all mean NOT off. A broken dial must
// never stall the swarm. Nothing calls this module yet, so merging it changes no behaviour.
//
// CLI (the bash worker and the dashboard shell out to it so the rule lives once):
//   node src/cloud-dial.js get                 JSON of the current state (count null when unset)
//   node src/cloud-dial.js set <n>             n is a non-negative integer, no maximum
//   node src/cloud-dial.js unset               back to today's behaviour
//   node src/cloud-dial.js mode <manual|auto>
//   node src/cloud-dial.js is-off <laneId>     exit 0 when the lane is off, 1 otherwise; prints nothing. Lane ids come from src/lanes.js getLanes()
//                                              filtered to enabled cloud lanes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomicSync } = require('./atomic-write.js');

const MODES = ['manual', 'auto'];
const LANE_RE = /^(?:worker-)?cloud(\d*)$/;

function dialPath(env = process.env) {
  const override = String(env.AGENT_MANAGER_CLOUD_DIAL_PATH || '').trim();
  if (override) return override;
  return path.join(env.HOME || os.homedir(), '.local', 'state', 'agent-manager', 'cloud-dial.json');
}

function isCount(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

// The state with defaults filled in. Never throws; an unreadable or malformed file reads as unset.
function read(env = process.env) {
  const unset = { count: null, mode: 'manual', setAt: null, setBy: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(dialPath(env), 'utf8'));
  } catch (e) {
    return unset;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unset;
  return {
    count: isCount(parsed.count) ? parsed.count : null,
    mode: MODES.includes(parsed.mode) ? parsed.mode : 'manual',
    setAt: typeof parsed.setAt === 'string' ? parsed.setAt : null,
    setBy: typeof parsed.setBy === 'string' ? parsed.setBy : null,
  };
}

function write(next, by, env, now) {
  const state = { count: next.count, mode: next.mode, setAt: new Date(now).toISOString(), setBy: by == null || String(by) === '' ? 'operator' : String(by) };
  const file = dialPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomicSync(file, state);
  return state;
}

// Sets how many cloud lanes may run. Rejects negative, fractional, non-numeric and boolean values (a numeric string such as "3" from the CLI is accepted
// when it is a plain non-negative integer). Returns the state written.
function setCount(n, by, env = process.env, now = Date.now()) {
  let count = n;
  if (typeof n === 'string' && /^\d+$/.test(n.trim())) count = Number(n.trim());
  if (!isCount(count)) throw new Error(`invalid dial count ${JSON.stringify(n)}: must be a non-negative integer`);
  return write({ count, mode: read(env).mode }, by, env, now);
}

// Back to today's behaviour (count null). Keeps the mode.
function unset(by, env = process.env, now = Date.now()) {
  return write({ count: null, mode: read(env).mode }, by, env, now);
}

function setMode(mode, by, env = process.env, now = Date.now()) {
  if (!MODES.includes(mode)) throw new Error(`invalid dial mode ${JSON.stringify(mode)}: must be ${MODES.join(' or ')}`);
  return write({ count: read(env).count, mode }, by, env, now);
}

// Position of a lane id in the one lane order, or null when it is not a cloud lane id. `cloud` is 1, `cloud2` is 2, ...
function laneNumber(laneId) {
  const m = LANE_RE.exec(String(laneId == null ? '' : laneId));
  if (!m) return null;
  return m[1] === '' ? 1 : Number(m[1]);
}

// 0-based rank of laneId among cloudLaneIds in the lane order (cloud, cloud2, cloud3 ... by number), or -1 when it is not among them.
function laneRank(laneId, cloudLaneIds) {
  const ids = (Array.isArray(cloudLaneIds) ? cloudLaneIds : []).filter((id) => laneNumber(id) !== null);
  const ordered = [...new Set(ids)].sort((a, b) => laneNumber(a) - laneNumber(b));
  return ordered.indexOf(laneId);
}

// The enabled cloud lane ids from the lanes registry. Never throws; [] when the registry cannot be read.
function defaultCloudLaneIds(env = process.env) {
  try {
    return require('./lanes.js').getLanes(env).filter((l) => l.cloud === true).map((l) => l.id);
  } catch (e) {
    return [];
  }
}

// Is this cloud lane turned off by the dial? Fails open (see the header).
function isLaneOff(laneId, env = process.env, cloudLaneIds = undefined) {
  try {
    const { count } = read(env);
    if (count === null) return false;
    const rank = laneRank(laneId, cloudLaneIds === undefined ? defaultCloudLaneIds(env) : cloudLaneIds);
    if (rank < 0) return false;
    return rank >= count;
  } catch (e) {
    return false;
  }
}

module.exports = { dialPath, read, setCount, unset, setMode, laneRank, isLaneOff, defaultCloudLaneIds };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'get') console.log(JSON.stringify(read()));
    else if (cmd === 'set') console.log(JSON.stringify(setCount(arg, 'cli')));
    else if (cmd === 'unset') console.log(JSON.stringify(unset('cli')));
    else if (cmd === 'mode') console.log(JSON.stringify(setMode(arg, 'cli')));
    else if (cmd === 'is-off') process.exit(isLaneOff(arg) ? 0 : 1);
    else { console.error('usage: cloud-dial.js get | set <n> | unset | mode <manual|auto> | is-off <laneId>'); process.exit(2); }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
