'use strict';

// Node code refresh decision (multi-node plan, HUB0551 piece 1/2): a pure decision over values the caller already has.
// It makes at most one runner call (scripts/import-repo-bundle.sh) and never loops, sleeps or defers anything.
// It returns 'noop' | 'refused' | 'refreshed' | 'failed'. Nothing here reads the clock, the filesystem or git.

const path = require('path');

const IMPORT_SCRIPT = path.join(__dirname, '..', 'scripts', 'import-repo-bundle.sh');

// The runner is called once with IMPORT_SCRIPT and no retry; it reports success as { status: 0 }.
function refresh({ headSha, publishedSha, seq, fileMtimes, headTime, clean, onMaster, runner, audit, notify }) {
  // a. Already at the published sha: nothing to do.
  if (headSha === publishedSha) return 'noop';

  // b. Dirty tree or not on master: refuse with one audit line and one notice, change nothing.
  if (clean !== true || onMaster !== true) {
    audit(`refresh refused: clean=${clean} onMaster=${onMaster} headSha=${headSha} publishedSha=${publishedSha}`);
    notify('code refresh refused: the checkout is dirty or not on master');
    return 'refused';
  }

  // c. The clone is behind here (headSha differs from publishedSha). Refresh when stacked or a file is newer than headTime.
  const mtimes = Array.isArray(fileMtimes) ? fileMtimes : Object.values(fileMtimes || {});
  const stacked = seq > 1;
  const newer = mtimes.some((m) => m > headTime);
  if (!(stacked || newer)) return 'noop';

  // Exactly one runner call.
  let result;
  try {
    result = runner(IMPORT_SCRIPT);
  } catch (e) {
    return 'failed';
  }
  return result && result.status === 0 ? 'refreshed' : 'failed';
}

module.exports = { refresh, IMPORT_SCRIPT };
