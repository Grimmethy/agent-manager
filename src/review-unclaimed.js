'use strict';

// Does queue/review/ hold an item no live review daemon has claimed? (feature cloud-agent-pool, FF-2: a cloud worker reviews before it drafts, and when every waiting
// review is already claimed it drafts instead.)
//
// The claim rule is scripts/review-runner.sh claim_review_item, mirrored here read-only: a claim is the directory <instancesDir>/review-claims/<file name>.d holding an
// `owner` file "<pid> <instance id>"; it is LIVE when that pid is alive and the directory is younger than 3 hours (10800 s). A missing directory, a dead pid, an unreadable
// owner file or an old directory is NOT a live claim (the runner takes such a claim over). This module never creates, changes or removes a claim.
//
// Only *.json files that are non-empty count, like the runner's own listing (an empty file is mid-write). Fail closed to "nothing to review": a missing or unreadable
// review/ directory returns false, so a broken read can never make a worker skip drafting for a review that is not there.
//
// CLI: node src/review-unclaimed.js [<pipelineDir> [<instancesDir>]]  exit 0 when at least one unclaimed review exists, 1 otherwise; prints nothing. The directories default
// to AGENT_MANAGER_PIPELINE_DIR and AGENT_MANAGER_INSTANCES_DIR (default <pipelineDir>/instances), the same variables scripts/orc-common.sh uses.

const fs = require('fs');
const path = require('path');

const CLAIM_MAX_AGE_S = 10800;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // alive but owned by another user
  }
}

// True when a live claim holds this review file name.
function isClaimed(claimDir, name, now = Date.now(), alive = pidAlive) {
  const dir = path.join(claimDir, `${name}.d`);
  let st;
  try { st = fs.statSync(dir); } catch (e) { return false; }
  if ((now - st.mtimeMs) / 1000 >= CLAIM_MAX_AGE_S) return false;
  let owner;
  try { owner = fs.readFileSync(path.join(dir, 'owner'), 'utf8'); } catch (e) { return false; }
  const pid = parseInt(String(owner).trim().split(/\s+/)[0], 10);
  return alive(pid);
}

// The review file names with no live claim, oldest first by modification time.
function unclaimedReviews(pipelineDir, instancesDir, opts = {}) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  const alive = opts.alive || pidAlive;
  const reviewDir = path.join(pipelineDir, 'queue', 'review');
  const claimDir = path.join(instancesDir || path.join(pipelineDir, 'instances'), 'review-claims');
  let names;
  try { names = fs.readdirSync(reviewDir); } catch (e) { return []; }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let st;
    try { st = fs.statSync(path.join(reviewDir, name)); } catch (e) { continue; }
    if (!st.isFile() || st.size === 0) continue;
    if (isClaimed(claimDir, name, now, alive)) continue;
    rows.push({ name, mtimeMs: st.mtimeMs });
  }
  return rows.sort((a, b) => a.mtimeMs - b.mtimeMs).map((r) => r.name);
}

function hasUnclaimedReview(pipelineDir, instancesDir, opts = {}) {
  return unclaimedReviews(pipelineDir, instancesDir, opts).length > 0;
}

module.exports = { CLAIM_MAX_AGE_S, isClaimed, unclaimedReviews, hasUnclaimedReview };

if (require.main === module) {
  const pipelineDir = process.argv[2] || process.env.AGENT_MANAGER_PIPELINE_DIR || '';
  const instancesDir = process.argv[3] || process.env.AGENT_MANAGER_INSTANCES_DIR || '';
  let found = false;
  try { found = pipelineDir !== '' && hasUnclaimedReview(pipelineDir, instancesDir || undefined); } catch (e) { found = false; }
  process.exit(found ? 0 : 1);
}
