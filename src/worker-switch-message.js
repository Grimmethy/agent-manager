'use strict';

// The one-line reason a worker is not claiming, for the log line scripts/local-worker.sh prints when a worker goes off (worker_switch_message in
// agent-manager-common.sh). A per-worker marker is the operator's Workers tab toggle; _pause-node / _pause-global are machine pauses (site-traffic monitor,
// dashboard buttons) and name their reason and start time from the marker itself, read through worker-switch.js readPause.
//   node src/worker-switch-message.js <worker id>   prints the message

const fs = require('fs');
const path = require('path');
const { switchDir, readPause } = require('./worker-switch.js');

const OPERATOR_TEXT = 'switched off by the operator (Workers tab) -- claiming nothing until it is switched back on.';

function two(n) { return String(n).padStart(2, '0'); }

function localTime(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '';
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

function pauseText(scope, marker) {
  const reason = marker.reason ? String(marker.reason) : 'reason not recorded';
  const at = localTime(marker.setAt);
  const source = marker.source && marker.source !== 'operator' ? `${marker.source}: ` : '';
  return `paused by the ${scope} pause (${source}${reason}${at ? `, since ${at}` : ''}) -- claiming nothing until the pause clears.`;
}

function switchMessage(id, env = process.env, now = Date.now()) {
  try {
    if (id && fs.existsSync(path.join(switchDir(env), id))) return OPERATOR_TEXT;
    for (const scope of ['node', 'global']) {
      const marker = readPause(scope, env, now);
      if (marker) return pauseText(scope, marker);
    }
  } catch (e) {
    // fall through to the generic text
  }
  return OPERATOR_TEXT;
}

module.exports = { switchMessage, OPERATOR_TEXT };

if (require.main === module) process.stdout.write(`${switchMessage(process.argv[2])}\n`);
