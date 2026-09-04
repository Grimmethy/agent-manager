'use strict';

// Coordinator sweep (2026-09-02). A RESOLUTION: decompose parent no longer goes to done/
// and is forgotten -- applyAdhocDiff routes it to queue/coordinating/ with a `subTasks`
// checklist, and its children flow through the normal adhoc pipeline. This sweep runs on
// the queue-watchdog tick: for each coordinating parent it re-derives every child's real
// state, writes the checklist + progress back onto the parent, and once every child has
// reached a terminal-good state (done / merged / gone) it moves the parent to done/.
//
// Cheap by construction -- one readdirSync of a small dir plus a bounded findTaskRecordById
// per child -- so it runs unconditionally every tick (no --check-due gate). Best-effort per
// file: a malformed parent JSON is skipped, never fatal, same discipline as
// reject-retry-check.js / blocked-drain.js.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { findTaskRecordById } = require('./forensic-bundle.js');
const { appendHistoryEvent } = require('./task-history.js');
const { runIntegrationGate } = require('./decompose-integration-gate.js');

// findTaskRecordById state -> the status shown on the parent's checklist.
function classifyChildStatus(rec) {
  if (!rec) return 'gone'; // not found anywhere -- completed and aged out, or hand-removed
  const state = rec.state;
  const merged = rec.task && rec.task.mergedAt;
  if (state === 'done') return merged ? 'merged' : 'done';
  if (state === 'archived') return 'merged'; // aged out of done/ into a month bucket -- it shipped
  if (state === 'archived_no_action') return 'abandoned';
  if (state === 'blocked' || state === 'needs-clarification' || state === 'awaiting-confirm') return state;
  return 'in-progress'; // pending / adhoc / drafting / review / approved / coordinating
}

// A child in one of these is finished as far as the parent is concerned. `abandoned` is
// deliberately terminal-good too: a human archived that sub-task on purpose, so it should
// not hold the parent open forever.
const TERMINAL_GOOD = new Set(['done', 'merged', 'gone', 'abandoned']);

// A child in one of these cannot progress on its own -- the pipeline has given up on it and
// is waiting for a human. If a sibling `dependsOn` one of these, that sibling is frozen
// forever (isDependencySatisfied never clears for a needs-clarification / blocked task, and
// an `abandoned` one has no branch on master either). Without this the hub just sits at
// partial progress silently -- caught live 2026-09-03: two coordinator hubs stuck at 0/2
// and 2/4 for days, every runnable child behind a sibling that had died in
// needs-clarification, while the workers ran observability tasks "instead".
const STUCK_STATES = new Set(['needs-clarification', 'blocked']);
const DEP_UNCLEARABLE = new Set(['needs-clarification', 'blocked', 'abandoned']);

function stuckEscalateMs() {
  const raw = process.env.AGENT_MANAGER_COORDINATOR_STUCK_ESCALATE_DAYS;
  const days = raw == null || raw === '' ? 3 : Number(raw);
  if (!Number.isFinite(days) || days < 0) return 3 * 86400000;
  return days * 86400000; // 0 -> never escalate (only stamp blockedReason)
}

// { subTasks:[{id,status}], recById: Map<id, rec|null> } -> [{ id, why }] for every
// non-terminal child that can't proceed: it is itself stuck, OR it depends on a sibling
// whose state can never clear.
function findStuckChildren(subTasks, recById) {
  const statusById = new Map(subTasks.map((st) => [st.id, st.status]));
  const out = [];
  for (const st of subTasks) {
    if (TERMINAL_GOOD.has(st.status)) continue;
    if (STUCK_STATES.has(st.status)) {
      out.push({ id: st.id, why: `child is in ${st.status}` });
      continue;
    }
    const rec = recById.get(st.id);
    const deps = (rec && rec.task && Array.isArray(rec.task.dependsOn)) ? rec.task.dependsOn : [];
    const badDeps = deps.filter((d) => DEP_UNCLEARABLE.has(statusById.get(d)));
    if (badDeps.length > 0) {
      out.push({ id: st.id, why: `waiting on ${badDeps.join(', ')} (state can never clear)` });
    }
  }
  return out;
}

// Stacked file-decompose hub: all children have committed to the shared branch, but a
// per-file py_compile and three diff-reading votes never actually imported the app. Run
// the real integration gate (decompose-integration-gate.js) ONCE, on the transition to
// all-children-done, before the hub is marked merged. Pass fails -> hub stays in
// coordinating/ with a blockedReason naming the failing check; a human requeues the wiring
// child with the detail as feedback. Set AGENT_MANAGER_DECOMPOSE_INTEGRATION_GATE=false to
// skip (the branch then merges on review alone, the pre-stacked behaviour).
function runStackedGate(parent, repoRoot) {
  if (process.env.AGENT_MANAGER_DECOMPOSE_INTEGRATION_GATE === 'false') return { ok: true, skipped: true };
  if (!repoRoot || !parent.branch || !parent.sourceFile) return { ok: true, skipped: true };
  let mainBranch = 'master';
  try { ({ mainBranch } = require('./git-runner.js').createRealGitRunner(repoRoot)); } catch (e) { console.error(`[coordinator-sweep] createRealGitRunner() failed, falling back to default: ${e.message}`); }
  try {
    return runIntegrationGate({ repoRoot, branch: parent.branch, mainBranch, sourceFile: parent.sourceFile });
  } catch (e) {
    return { ok: false, errored: true, checks: [{ name: 'gate', status: 'fail', detail: e.message }] };
  }
}

function coordinatorSweep({ pipelineDir, repoRoot, runGate = runStackedGate } = {}) {
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  let resolvedRepoRoot = repoRoot;
  if (resolvedRepoRoot === undefined) { try { ({ repoRoot: resolvedRepoRoot } = getConfig()); } catch { resolvedRepoRoot = null; } }
  const summary = { checked: 0, updated: 0, completed: 0, errors: 0 };

  let names;
  try {
    names = fs.readdirSync(coordDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return summary; // no coordinating/ dir yet -- nothing to sweep
    summary.errors += 1;
    console.error(`[coordinator-sweep] readdirSync failed for ${coordDir}: ${err.code || 'UNKNOWN'} -- ${err.message}`);
    return summary;
  }

  for (const name of names) {
    const file = path.join(coordDir, name);
    let parent;
    try {
      parent = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue; // a malformed coordinating file is not this sweep's problem to fix
    }
    if (!Array.isArray(parent.subTasks) || parent.subTasks.length === 0) {
      // A coordinating parent with no checklist is a bug upstream -- complete it out so it
      // does not sit here forever.
      parent.status = 'done';
      parent.doneMarker = 'coordinator had no sub-tasks -- completed';
      stampHubMerged(parent);
      appendHistoryEvent(parent, 'done', parent.doneMarker);
      moveToDone(file, doneDir, name, parent);
      summary.checked += 1;
      summary.completed += 1;
      continue;
    }

    summary.checked += 1;
    let doneCount = 0;
    const recById = new Map();
    for (const st of parent.subTasks) {
      const rec = st && st.id ? findTaskRecordById(pipelineDir, st.id) : null;
      recById.set(st && st.id, rec);
      st.status = classifyChildStatus(rec);
      if (TERMINAL_GOOD.has(st.status)) doneCount += 1;
    }
    parent.progress = { done: doneCount, total: parent.subTasks.length };
    parent.lastReconciledAt = new Date().toISOString();

    // Stuck-chain detection: surface a hub that can never complete on its own instead of
    // leaving it frozen at partial progress. The hub STAYS in coordinating/ so the sweep
    // keeps reconciling it (and auto-clears / auto-completes if the children get unstuck);
    // what changes is a `coordinatorBlocked` marker + a `blockedReason` the dashboard
    // renders, and after a grace period an `escalated` flag + a louder history event.
    if (doneCount < parent.subTasks.length) {
      const stuck = findStuckChildren(parent.subTasks, recById);
      const now = new Date().toISOString();
      if (stuck.length > 0) {
        const signature = stuck.map((s) => `${s.id}:${s.why}`).sort().join(' | ');
        if (!parent.coordinatorBlocked || parent.coordinatorBlocked.signature !== signature) {
          parent.coordinatorBlocked = { signature, since: now, children: stuck, escalated: false };
          appendHistoryEvent(parent, 'blocked', `coordinator stuck: ${stuck.map((s) => `${s.id} -- ${s.why}`).join('; ')}`.slice(0, 500));
          summary.blocked = (summary.blocked || 0) + 1;
        }
        parent.blockedReason = `${stuck.length} sub-task(s) can't proceed: ${stuck.map((s) => `${s.id.replace(/^adhoc-/, '')} (${s.why})`).join('; ')}`.slice(0, 400);
        const escalateMs = stuckEscalateMs();
        const stuckForMs = Date.now() - Date.parse(parent.coordinatorBlocked.since || now);
        if (escalateMs > 0 && stuckForMs >= escalateMs && !parent.coordinatorBlocked.escalated) {
          parent.coordinatorBlocked.escalated = true;
          parent.coordinatorBlocked.escalatedAt = now;
          appendHistoryEvent(parent, 'advisory',
            `coordinator hub stuck ${Math.floor(stuckForMs / 86400000)}d -- needs a human: resolve/requeue/archive ${stuck.map((s) => s.id).join(', ')}, or archive this hub`);
          summary.escalated = (summary.escalated || 0) + 1;
        }
      } else if (parent.coordinatorBlocked) {
        delete parent.coordinatorBlocked;
        delete parent.blockedReason;
        appendHistoryEvent(parent, 'advisory', 'coordinator unblocked -- sub-tasks progressing again');
        summary.unblocked = (summary.unblocked || 0) + 1;
      }
    }

    const allChildrenDone = doneCount === parent.subTasks.length;

    // A child went back to work (e.g. a human requeued the wiring step after a gate
    // failure) -- re-arm the gate so the next all-done transition re-checks the branch.
    if (!allChildrenDone && parent.integrationGate
        && ['failed', 'errored'].includes(parent.integrationGate.status)) {
      parent.integrationGate = { status: 'pending', reArmedAt: new Date().toISOString() };
      delete parent.blockedReason;
      delete parent.coordinatorBlocked;
    }

    // Stacked decompose hub: children done is necessary but not sufficient -- the shared
    // branch must actually import and keep its route table. Gate runs once; its result is
    // cached on the hub so a quiet every-tick sweep never re-runs a worktree build.
    if (allChildrenDone && parent.mode === 'stacked' && parent.integrationGate
        && parent.integrationGate.status === 'pending') {
      const res = runGate(parent, resolvedRepoRoot);
      const now = new Date().toISOString();
      if (res.skipped) {
        parent.integrationGate = { status: 'skipped', at: now };
      } else if (res.ok) {
        parent.integrationGate = { status: 'passed', at: now, checks: res.checks || [] };
        appendHistoryEvent(parent, 'advisory', `integration gate passed on ${parent.branch} -- ${(res.checks || []).map((c) => `${c.name}:${c.status}`).join(' ')}`);
        summary.gatePassed = (summary.gatePassed || 0) + 1;
      } else {
        const failing = (res.checks || []).filter((c) => c.status === 'fail');
        parent.integrationGate = { status: res.errored ? 'errored' : 'failed', at: now, checks: res.checks || [] };
        parent.blockedReason = `decompose integration gate ${res.errored ? 'errored' : 'failed'} on ${parent.branch}: ${failing.map((c) => `${c.name} -- ${c.detail}`).join(' | ')}`.slice(0, 600);
        parent.coordinatorBlocked = {
          signature: `integration-gate:${failing.map((c) => c.name).sort().join(',')}`,
          since: now, escalated: false,
          children: [{ id: parent.subTasks[parent.subTasks.length - 1].id, why: `integration gate failed: ${failing.map((c) => c.name).join(', ')}` }],
        };
        appendHistoryEvent(parent, 'blocked', parent.blockedReason);
        summary.gateFailed = (summary.gateFailed || 0) + 1;
        // errored (not failed) -> let a later tick retry the gate itself.
        if (res.errored) parent.integrationGate.status = 'pending';
        try { fs.writeFileSync(file, JSON.stringify(parent, null, 2)); summary.updated += 1; }
        catch (err) { console.error(`coordinator-sweep: failed to write ${file}: ${err.message}`); summary.errors += 1; }
        continue;
      }
    }

    const gateClear = !(parent.mode === 'stacked' && parent.integrationGate
      && ['failed', 'pending'].includes(parent.integrationGate.status) && allChildrenDone);

    if (allChildrenDone && gateClear) {
      parent.status = 'done';
      parent.doneMarker = `coordinator complete: all ${parent.subTasks.length} sub-task(s) done`;
      stampHubMerged(parent);
      appendHistoryEvent(parent, 'done', parent.doneMarker);
      moveToDone(file, doneDir, name, parent);
      summary.completed += 1;
    } else {
      try {
        fs.writeFileSync(file, JSON.stringify(parent, null, 2));
        summary.updated += 1;
      } catch (err) {
        console.error(`coordinator-sweep: failed to write ${file}: ${err.message}`);
        summary.errors += 1;
      }
    }
  }

  return summary;
}

// A coordinator hub has no branch of its own -- it never applies a diff, it only tracks
// the sub-tasks it decomposed into. So the dashboard's merge button (the only thing that
// normally stamps `mergedAt`) can never fire for it. Without a `mergedAt`, any sibling
// task carrying `dependsOn: [<hubId>]` is blocked FOREVER by isDependencySatisfied()
// (task-sources.js), which treats "done but not merged" as unsatisfied. "Every sub-task
// reached a terminal-good state" IS the ship signal for a hub -- stamp it here so the
// dependency gate can clear. Confirmed live 2026-09-02: the plugins-marketplace
// coordinator chain, every downstream child frozen behind an unmergeable hub id.
function stampHubMerged(parent) {
  if (!parent.mergedAt) {
    parent.mergedAt = new Date().toISOString();
    parent.mergedAtSource = 'coordinator-hub-all-subtasks-done';
    // Close the hub's task log with a terminal event (task-disposition.js) -- a hub has no
    // branch of its own, so "every sub-task shipped" IS its merge.
    if (parent.terminalDisposition !== 'merged') {
      appendHistoryEvent(parent, 'merged', 'coordinator hub: every decomposed sub-task reached a terminal-good state');
      parent.terminalDisposition = 'merged';
    }
  }
}

function moveToDone(srcFile, doneDir, name, parent) {
  try {
    fs.mkdirSync(doneDir, { recursive: true });
    const dest = path.join(doneDir, name);
    if (fs.existsSync(dest)) return; // don't clobber -- something already put it there
    fs.writeFileSync(dest, JSON.stringify(parent, null, 2));
    fs.unlinkSync(srcFile);
  } catch { /* best-effort -- next tick retries */ }
}

module.exports = { coordinatorSweep, classifyChildStatus, findStuckChildren, TERMINAL_GOOD };

if (require.main === module) {
  const { pipelineDir, repoRoot } = getConfig();
  process.stdout.write(JSON.stringify(coordinatorSweep({ pipelineDir, repoRoot })));
}
