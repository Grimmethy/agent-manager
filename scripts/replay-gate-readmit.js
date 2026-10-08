#!/usr/bin/env node
'use strict';

// replay-gate-readmit.js -- which stuck tasks would needs-clarification-triage Buckets P and Q re-admit, and which stay?
//
//   node scripts/replay-gate-readmit.js --pipeline <dir> --repo <path>
//
// Runs the two pure predicates in src/lib/gate-readmit.js over every task in <pipeline>/queue/needs-clarification whose latest block reason is the
// plan-target guard ("plan cites missing-file target(s)") or the ungrounded-value gate ("appears nowhere in its real grounding source"):
//   P  the CURRENT plan-target guard no longer blocks the task's stored plan  -> would be requeued clean
//   Q  every flagged value is a fixture URL in a test file the draft adds     -> would be sent to review
//   stays  anything else (a genuinely fabricated path, a real ungrounded value, ...)
// Read-only. Exit 1 if a task that the gates DO still block (a "stays" row whose reason is a plan-target block with a path missing from --repo) were
// re-admitted by mistake -- i.e. never; the exit code is the safety tripwire for future edits to the predicates.

const fs = require('fs');
const path = require('path');
const { planTargetNoLongerBlocks, ungroundedUrlsAreTestFixtures, PLAN_TARGET_REASON_RE, UNGROUNDED_REASON_RE } = require('../src/lib/gate-readmit.js');
const { planTargetGuard } = require('../src/plan-target-guard.js');

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1]; };
const pipeline = arg('pipeline');
const repo = arg('repo');
if (!pipeline || !repo) { console.error('usage: replay-gate-readmit.js --pipeline <dir> --repo <path>'); process.exit(2); }

const dir = path.join(pipeline, 'queue', 'needs-clarification');
let considered = 0;
let mistakes = 0;
const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  let t;
  try { t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  const reason = String(t.blockedReason || (t.needsClarification && t.needsClarification.reason) || '');
  if (!PLAN_TARGET_REASON_RE.test(reason) && !UNGROUNDED_REASON_RE.test(reason)) continue;
  considered += 1;
  const p = planTargetNoLongerBlocks(t, repo);
  const q = ungroundedUrlsAreTestFixtures(t);
  // tripwire: a task the current guard STILL blocks must never be reported as P.
  const stillBlocked = PLAN_TARGET_REASON_RE.test(reason) && (t.planResponse || t.lastGoodPlan) && planTargetGuard(t, t.planResponse || t.lastGoodPlan, repo, []).blocked === true;
  if (p && stillBlocked) mistakes += 1;
  rows.push(`${p ? 'P     ' : q ? 'Q     ' : 'stays '} ${f.slice(0, 84)}`);
}
console.log(rows.join('\n') || '(no task is blocked by either gate)');
console.log(`considered ${considered}; re-admit P=${rows.filter((r) => r.startsWith('P')).length} Q=${rows.filter((r) => r.startsWith('Q')).length}; stay=${rows.filter((r) => r.startsWith('stays')).length}; mistakes=${mistakes}`);
process.exit(mistakes ? 1 : 0);
