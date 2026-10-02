'use strict';

// Reports how review classified finished drafts under the policy-change routing (src/policy-change.js). Run it after a week of shadow mode (escalation off) to read the
// escalation rate before turning AGENT_MANAGER_POLICY_CHANGE_ROUTING on: the plan is to tighten the classifier first if more than ~15% of reviewed drafts would escalate.
//
//   node scripts/policy-change-report.js [pipelineDir]
//
// Counts every task under queue/* that review stamped with task.policyChange, by route and by kind. "Reviewed" = tasks carrying the stamp (adhoc drafts with a diff).

const fs = require('fs');
const path = require('path');

function readReport(pipelineDir) {
  const out = { reviewed: 0, policy: 0, byRoute: {}, byKind: {}, escalateRate: 0, policyRate: 0, escalated: [] };
  const queue = path.join(pipelineDir || '', 'queue');
  let dirs = [];
  try { dirs = fs.readdirSync(queue, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(queue, dir)).filter((n) => n.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      let t;
      try { t = JSON.parse(fs.readFileSync(path.join(queue, dir, name), 'utf8')); } catch { continue; }
      const pc = t && t.policyChange;
      if (!pc || typeof pc !== 'object') continue;
      out.reviewed += 1;
      if (pc.policy) {
        out.policy += 1;
        out.byRoute[pc.route] = (out.byRoute[pc.route] || 0) + 1;
        for (const k of pc.kinds || []) out.byKind[k] = (out.byKind[k] || 0) + 1;
        if (pc.route === 'escalate' && out.escalated.length < 20) out.escalated.push({ id: String(t.id || name), state: dir, kinds: pc.kinds });
      }
    }
  }
  out.policyRate = out.reviewed ? out.policy / out.reviewed : 0;
  out.escalateRate = out.reviewed ? (out.byRoute.escalate || 0) / out.reviewed : 0;
  return out;
}

function main() {
  const dir = process.argv[2] || process.env.AGENT_MANAGER_PIPELINE_DIR || process.cwd();
  const r = readReport(dir);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  console.log(`reviewed drafts with a policy-change stamp: ${r.reviewed}`);
  console.log(`policy-affecting: ${r.policy} (${pct(r.policyRate)})   would escalate: ${r.byRoute.escalate || 0} (${pct(r.escalateRate)})   replay-settled: ${r.byRoute['replay-settled'] || 0}   already decided: ${r.byRoute.decided || 0}`);
  console.log(`by kind: ${Object.entries(r.byKind).map(([k, n]) => `${k}=${n}`).join(' ') || '(none)'}`);
  if (r.escalateRate > 0.15) console.log('escalation rate is above 15%: tighten the classifier before enabling AGENT_MANAGER_POLICY_CHANGE_ROUTING');
  for (const e of r.escalated) console.log(`  would escalate: ${e.id} [${e.state}] ${(e.kinds || []).join(',')}`);
}

if (require.main === module) main();
module.exports = { readReport };
