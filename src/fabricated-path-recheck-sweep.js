'use strict';

// fabricated-path-recheck-sweep.js -- requeue a task the candidate grounding gate blocked for "fabricated file path(s)" when every one of those
// paths in fact exists on origin/<main>. Deterministic (git object store, no model).
//
// Why (2026-09-21, PF arch-discovery-community-5): the gate judged paths against the shared checkout's working tree, which had been left on a stale
// branch, so three real files read as invented. The classifier makes a fabricated-path block NON-retryable (a redraft cannot make an invented path
// real), so the task sat in blocked/ for good although its citations were right. candidate-path-grounding.js now also consults origin/<main>, which
// stops new false alarms; this sweep recovers ones already parked and any that still slip through (e.g. a verdict reached before a fetch).
//
// Unlike fix-signature-sweep.js there is no "failed before the fix" guard: a false alarm can happen again, and the check is decisive on its own
// (the paths are there). It is bounded instead by ONCE PER TASK (task.requeuedForFixes): if the redraft is blocked again with the same paths still
// present on main, something other than the stale tree is wrong and a human should look. Never touches a task that was applied to a branch or a genuine
// design question that did not exhaust its retries. It DOES take reviewInconclusive tasks: local-draft.js stamps that flag on exactly this gate's
// blocks (a "stochastic harness gate") and blocked-drain.js defers them to "a fresh grounding re-check, a different mechanism" -- this is it.
// Kill switch: AGENT_MANAGER_FABRICATED_PATH_RECHECK=false. CLI: node fabricated-path-recheck-sweep.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { failureText } = require('./known-fixed-failures.js');
const { destinationDir, freshShape } = require('./fix-signature-sweep.js');
const { parseFabricatedPaths, resolveCitedFileAtMain } = require('./candidate-path-grounding.js');

const ENTRY = {
  id: 'fabricated-path-exists-on-main',
  fixedIn: 'agent-manager: candidate grounding gate now checks origin/<main>, 2026-09-21',
};
const DIRS = ['blocked', 'needs-clarification'];

const enabled = () => process.env.AGENT_MANAGER_FABRICATED_PATH_RECHECK !== 'false';
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

// existsAtMain(claimedPath) -> truthy is injectable so tests need no real repo.
function sweepFabricatedPathRecheck({ pipelineDir, repoRoot, mainBranch = 'main', extraRoots = [], now = new Date(), dryRun = false, existsAtMain, fetch = true } = {}) {
  const summary = { checked: 0, requeued: [], skipped: 0 };
  if (!enabled() || !pipelineDir) return summary;
  const queueDir = path.join(pipelineDir, 'queue');
  const nowIso = now.toISOString();
  const probe = existsAtMain || ((p) => (repoRoot ? resolveCitedFileAtMain(repoRoot, p, extraRoots, mainBranch) : null));
  let fetched = false;

  for (const dir of DIRS) {
    const stateDir = path.join(queueDir, dir);
    let names;
    try { names = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      const filePath = path.join(stateDir, name);
      const task = readJson(filePath);
      if (!task || typeof task !== 'object') continue;
      const paths = parseFabricatedPaths(failureText(task));
      if (!paths.length) continue;
      summary.checked += 1;

      const already = Array.isArray(task.requeuedForFixes) && task.requeuedForFixes.includes(ENTRY.id);
      const design = task.needsClarification && task.needsClarification.reason === 'design-decision';
      const exhausted = Array.isArray(task.history) && task.history.some((h) => (h.stage || h.status) === 'exhausted');
      const hasBranch = Array.isArray(task.history) && task.history.some((h) => h && h.stage === 'applied');
      if (already || (design && !exhausted) || hasBranch) { summary.skipped += 1; continue; }

      // A stale origin/<main> would make a brand-new file look missing: refresh it once per run, before the first real check.
      if (!fetched && fetch && repoRoot && !dryRun) {
        fetched = true;
        try { require('./derived-premise-sweep.js').refreshMain(repoRoot, mainBranch, path.join(queueDir, '.fabricated-path-fetch'), now.getTime()); } catch { /* best effort */ }
      }
      let allThere = false;
      try { allThere = paths.every((p) => !!probe(p)); } catch { allThere = false; } // an error is "unknown", never "exists"
      if (!allThere) { summary.skipped += 1; continue; }

      const dest = path.join(destinationDir(queueDir, task), name);
      // Same rule as fix-signature-sweep: a stale same-name copy in derived/ is this task's own origin record; in pending/ or adhoc/ it is a real duplicate.
      if (fs.existsSync(dest) && path.basename(path.dirname(dest)) !== 'derived') { summary.skipped += 1; continue; }
      if (!dryRun) {
        const fresh = freshShape(task, ENTRY, dir, nowIso);
        fresh.history[fresh.history.length - 1].detail = `auto-requeued from ${dir}/: every path the grounding gate called fabricated (${paths.join(', ')}) exists on origin/${mainBranch}, so the block was a stale-checkout false alarm`;
        writeJson(dest, fresh);
        fs.unlinkSync(filePath);
      }
      summary.requeued.push({ id: task.id, from: dir, paths });
    }
  }
  return summary;
}

module.exports = { sweepFabricatedPathRecheck, ENTRY };

if (require.main === module) {
  const { getConfig } = require('./config.js');
  const { detectDefaultBranch } = require('./git-runner.js');
  const cfg = getConfig();
  const dryRun = process.argv.includes('--dry-run');
  const s = sweepFabricatedPathRecheck({
    pipelineDir: cfg.pipelineDir, repoRoot: cfg.repoRoot, mainBranch: detectDefaultBranch(cfg.repoRoot), extraRoots: cfg.grepAllowedDirs || [], dryRun,
  });
  process.stdout.write(`checked=${s.checked} requeued=${s.requeued.length}${s.requeued.length ? ` [${s.requeued.map((r) => r.id).join(', ')}]` : ''} skipped=${s.skipped}${dryRun ? ' (dry run)' : ''}\n`);
}
