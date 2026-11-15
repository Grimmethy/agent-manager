'use strict';

// The advisory and deterministic checks runReview runs after the executed verification and before the vote (roadmap step 1, piece P6.2): inert additions,
// mock seams, content overlap, undefined-after-removal, skip paths and policy-change classification. Each check records its finding on the task and either
// returns a blocked review result or null; runAdvisoryChecks runs them in the original order and returns the first block. Moved out of review-task.js with
// the helpers only they use; review-task.js imports and re-exports them, so every other importer is unchanged.

const { getConfig } = require('./config.js');
const { parseJsonMaybeFenced } = require('./json-fence.js');
const { resolveSourceName } = require('./task-source-registry.js');
const { resolveGroundingRef } = require('./stacked-grounding.js');
const { appendHistoryEvent } = require('./task-history.js');
const { analyzeMockSeams } = require('./review-mock-seam.js');
const { isHubChildTask } = require('./review-executed-verification.js');

// --- inert additions, as the voters see them (brain dump #1665) -------------------------------------------------------------------------------------
// review-inert.js lists NEW functions/classes/files in the diff that nothing else references (not another added line, not code already on the base; a use only in
// a test, an export list or a comment does not count). Four of ten needs-work branches examined on 2026-09-30 were half a feature of exactly this kind. It is
// advisory: a hub slice may be wired by a later sibling, and a library helper may be what the task asked for, so it goes to the voters as evidence and never blocks.
const INERT_MAX_ITEMS = 8;

// A ref `git grep` can search: the remote-tracking branch the draft was based on, else the local one, else null (not a git checkout).
function resolveInertBaseRef(repoRoot, branch) {
  const { execFileSync } = require('child_process');
  for (const ref of [`origin/${branch}`, branch]) {
    try {
      execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore', timeout: 10000 });
      return ref;
    } catch { /* try the next */ }
  }
  return null;
}

// Undefined-identifier-after-removal (src/review-undefined-after-removal.js, brain dump #1768): a change that deletes a declaration but leaves a use of the name in the
// post-change file. The draft is read from whichever shape it has: an adhoc rawDiff, or a Group B edit array (the arch_review / *_fix lanes carry no rawDiff).
// AGENT_MANAGER_REVIEW_UNDEFINED_CHECK: 'false' = off, 'advisory' = evidence for the voters only, anything else (default) = block.
function editsOfImplementResponse(task) {
  try {
    const parsed = parseJsonMaybeFenced(task && task.implementResponse);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const isOp = (i) => i && typeof i === 'object' && typeof i.file === 'string'
      && ((i.mode === 'edit' && typeof i.find === 'string' && typeof i.replace === 'string') || (i.mode === 'create' && typeof i.content === 'string') || i.mode === 'delete');
    return items.length && items.every(isOp) ? items : null;
  } catch { return null; }
}

function summariseUndefinedRemoval(r) {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const uses = Array.isArray(r && r.uses) ? r.uses : [];
  return {
    at: new Date().toISOString(), considered: n(r && r.considered), unknown: n(r && r.unknown), total: uses.length,
    uses: uses.slice(0, 8).map((u) => ({
      file: String((u && u.file) || '').slice(0, 160), name: String((u && u.name) || '').slice(0, 120),
      lines: (Array.isArray(u && u.lines) ? u.lines : []).slice(0, 5).map((l) => ({ line: n(l && l.line), text: String((l && l.text) || '').slice(0, 140) })),
    })),
  };
}

function undefinedRemovalWhere(u) {
  return `\`${u.name}\` in ${u.file} (${u.lines.map((l) => `line ${l.line}: ${l.text}`).join(' | ')})`;
}

function undefinedRemovalBlockReason(summary) {
  const items = (summary && summary.uses) || [];
  return `Deterministic gate: undefined identifier after removal -- the change deletes the declaration of ${items.length} name(s) that the file still uses, so the code would throw a ReferenceError when that line runs: ${items.map(undefinedRemovalWhere).join('; ')}. Either keep the declaration, or replace every remaining use with the new form.`;
}

function summariseInertAdditions(r, hubChild) {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const inert = Array.isArray(r && r.inert) ? r.inert : [];
  return {
    at: new Date().toISOString(), considered: n(r && r.considered), unknown: n(r && r.unknown), hubChild: !!hubChild, total: inert.length,
    inert: inert.slice(0, INERT_MAX_ITEMS).map((i) => ({
      kind: ['function', 'class', 'file'].includes(i && i.kind) ? i.kind : 'function', name: String((i && i.name) || '').slice(0, 120), file: String((i && i.file) || '').slice(0, 160), line: n(i && i.line),
    })),
  };
}

// --- skip / dismiss / early-exit paths, as the voters see them (brain dump #1667) --------------------------------------------------------------------
// review-skip-paths.js lists the places a diff ADDS code that can archive, dismiss, skip or short-circuit work. Three of ten needs-work branches examined on
// 2026-09-30 did that and wrongly dropped real cases while their tests passed (a startup exemption ahead of a hot-path check, a gate that archived a genuine finding
// whose snippet lacked the loop header, a zero-result early exit shared by every project). Advisory: the voters are told what the draft must then show.
const SKIP_PATH_MAX_ITEMS = 8;

function summariseSkipPaths(r) {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const paths = Array.isArray(r && r.paths) ? r.paths : [];
  return {
    at: new Date().toISOString(), total: Math.max(n(r && r.total), paths.length),
    paths: paths.slice(0, SKIP_PATH_MAX_ITEMS).map((p) => ({
      kind: ['status-label', 'skip-flag', 'early-exit', 'gate-function'].includes(p && p.kind) ? p.kind : 'status-label',
      file: String((p && p.file) || '').slice(0, 160), line: n(p && p.line), text: String((p && p.text) || '').slice(0, 120),
    })),
  };
}

function inertAdditionsCheck({ task, repoRoot, factCheckVerdict, recordModelOutcome, findInertFn }) {
  // Inert additions (see formatInertAdditionsSection): a cheap diff + git-grep check, independent of the executed-verification switch.
  // AGENT_MANAGER_REVIEW_INERT_BLOCK: 'off' = advisory only (no history event change), 'shadow' (default) = append a 'would block (shadow):' line,
  // anything else (default on) = block the task before any vote is spent. Exempt when isHubChildTask (a later sibling may wire it), when the task
  // text says 'foundation only' / 'inert until' / 'no caller yet', or when the task is stacked (already covered by isHubChildTask).
  const inertBlockMode = process.env.AGENT_MANAGER_REVIEW_INERT_BLOCK || 'shadow';
  if (process.env.AGENT_MANAGER_REVIEW_INERT_CHECK !== 'false'
      && resolveSourceName(task) === 'adhoc'
      && task.adhocResolution === 'implemented'
      && typeof task.rawDiff === 'string' && task.rawDiff.trim()) {
    try {
      const find = findInertFn || require('./review-inert.js').findInertAdditions;
      const branch = resolveGroundingRef(task, repoRoot) || require('./git-runner.js').detectDefaultBranch(repoRoot);
      const baseRef = resolveInertBaseRef(repoRoot, branch) || (findInertFn ? branch : null);
      if (baseRef) {
        const r = find({ rawDiff: task.rawDiff, repoRoot, baseRef });
        if (r && Array.isArray(r.inert)) {
          task.inertAdditions = summariseInertAdditions(r, isHubChildTask(task));
          if (r.inert.length) {
            const names = r.inert.slice(0, 4).map((i) => i.name).join(', ') + (r.inert.length > 4 ? ', ...' : '');
            const exempt = isHubChildTask(task)
              || (typeof task.promptContext?.rawText === 'string' && /foundation only|inert until|no caller yet/i.test(task.promptContext.rawText));
            if (inertBlockMode === 'off' || exempt) {
              // Exempt cases and off mode: behave exactly as today (advisory only).
              appendHistoryEvent(task, 'advisory', `inert-addition check: ${r.inert.length} unreferenced addition(s) (${names})${task.inertAdditions.hubChild ? ' -- hub slice, a sibling may wire it' : ''}`);
            } else if (inertBlockMode === 'shadow') {
              // Shadow mode: append a history event noting it would block, but never block.
              appendHistoryEvent(task, 'advisory', `would block (shadow): ${r.inert.length} unreferenced addition(s): ${names}`);
            } else {
              // On mode: block the task before any vote is spent.
              const inertItems = task.inertAdditions.inert.slice(0, INERT_MAX_ITEMS);
              const reason = `Blocked: ${r.inert.length} unreferenced addition(s) with no caller in this change:\n${inertItems.map((i) => `- ${i.file}:${i.line} ${i.name}`).join('\n')}\nFix: add the caller in this change, or put "foundation only" in the task text if nothing should call it yet.`;
              task.reviewProvider = 'deterministic-inert-addition';
              task.blockedReason = reason;
              recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
              appendHistoryEvent(task, 'blocked', `inert addition blocked: ${r.inert.length} unreferenced addition(s)`);
              appendHistoryEvent(task, 'info', reason);
              return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
            }
          }
        }
      }
    } catch (e) {
      console.error(`[review] inert-addition check errored for ${task.id} (non-fatal, continuing to the vote): ${e && e.message}`);
    }
  }
  return null;
}

function mockSeamCheck({ task, factCheckVerdict, recordModelOutcome }) {
  // Mock-seam check (HUB0321 · 2/3): detect when production code changes but tests mock
  // the very function being modified, indicating a double rather than real behaviour.
  // Honors AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK (false | advisory | block, default advisory).
  const mockSeamMode = getConfig().reviewMockSeamCheck;
  if (mockSeamMode !== 'false') {
    try {
      const { seams, advisory } = analyzeMockSeams({ diff: task.rawDiff, config: {} });
      if (seams.length > 0) {
        task.mockSeams = { count: seams.length, seams };
        const affectedFns = seams.map((s) => s.changedFn);
        appendHistoryEvent(task, mockSeamMode === 'block' ? 'blocked' : 'advisory',
          `mock-seam check: ${seams.length} seam(s) detected (${affectedFns.join(', ')}${seams.length > 3 ? ', ...' : ''}) -- ${advisory}`);
        if (mockSeamMode === 'block') {
          const reason = `Mock seam detected: ${seams.length} function(s) changed in production but mocked in tests (${affectedFns.join(', ')}). Review requires a real (non-mocked) test or manual review note.`;
          task.reviewProvider = 'deterministic-mock-seam';
          recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
          appendHistoryEvent(task, 'blocked', reason);
          return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
        }
      }
    } catch (e) {
      console.error(`[review] mock-seam check errored for ${task.id} (non-fatal, continuing to the vote): ${e && e.message}`);
    }
  }
  return null;
}

function contentOverlapCheck({ task, repoRoot, factCheckVerdict, recordModelOutcome, findOverlapFn }) {
  // Content overlap (see formatContentOverlapSection): the diff duplicates what another unmerged branch or the base already has. Advisory by default; 'block' blocks.
  const overlapMode = process.env.AGENT_MANAGER_REVIEW_OVERLAP_CHECK;
  if (overlapMode !== 'false'
      && resolveSourceName(task) === 'adhoc'
      && task.adhocResolution === 'implemented'
      && typeof task.rawDiff === 'string' && task.rawDiff.trim()) {
    try {
      const overlapLib = require('./review-content-overlap.js');
      const find = findOverlapFn || overlapLib.findContentOverlap;
      const branch = resolveGroundingRef(task, repoRoot) || require('./git-runner.js').detectDefaultBranch(repoRoot);
      const baseRef = resolveInertBaseRef(repoRoot, branch) || (findOverlapFn ? branch : null);
      if (baseRef) {
        const r = find({ rawDiff: task.rawDiff, repoRoot, baseRef, ownRefs: [`origin/agent/${task.id}`] });
        if (r && Array.isArray(r.overlaps)) {
          task.contentOverlap = overlapLib.summariseContentOverlap(r);
          if (r.overlaps.length) {
            appendHistoryEvent(task, 'advisory', `content-overlap check: ${task.contentOverlap.total} overlap(s) (${task.contentOverlap.overlaps.slice(0, 3).map((o) => `${o.file} <- ${o.ref}`).join('; ')})`);
            if (overlapMode === 'block') {
              const reason = overlapLib.contentOverlapBlockReason(task.contentOverlap);
              task.reviewProvider = 'deterministic-content-overlap';
              recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
              appendHistoryEvent(task, 'blocked', reason);
              return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
            }
          }
        }
      }
    } catch (e) {
      console.error(`[review] content-overlap check errored for ${task.id} (non-fatal, continuing to the vote): ${e && e.message}`);
    }
  }
  return null;
}

function undefinedRemovalCheck({ task, repoRoot, factCheckVerdict, recordModelOutcome, findUndefinedFn }) {
  // Undefined identifier after removal (see undefinedRemovalBlockReason): a declaration the change deletes whose name the file still uses. Covers an adhoc rawDiff and a
  // Group B edit array. Blocks by default; AGENT_MANAGER_REVIEW_UNDEFINED_CHECK=advisory only shows the voters; =false skips it. Never throws.
  const undefinedMode = process.env.AGENT_MANAGER_REVIEW_UNDEFINED_CHECK;
  if (undefinedMode !== 'false') {
    const rawDiffOk = resolveSourceName(task) === 'adhoc' && task.adhocResolution === 'implemented' && typeof task.rawDiff === 'string' && task.rawDiff.trim();
    const edits = rawDiffOk ? null : editsOfImplementResponse(task);
    if (rawDiffOk || edits) {
      try {
        const find = findUndefinedFn || require('./review-undefined-after-removal.js').findUndefinedAfterRemoval;
        const branch = resolveGroundingRef(task, repoRoot) || require('./git-runner.js').detectDefaultBranch(repoRoot);
        const baseRef = resolveInertBaseRef(repoRoot, branch) || (findUndefinedFn ? branch : null);
        if (baseRef) {
          const r = find({ rawDiff: rawDiffOk ? task.rawDiff : undefined, edits: edits || undefined, repoRoot, baseRef });
          if (r && Array.isArray(r.uses)) {
            task.undefinedAfterRemoval = summariseUndefinedRemoval(r);
            if (r.uses.length) {
              if (undefinedMode === 'advisory') {
                appendHistoryEvent(task, 'advisory', `undefined-after-removal check: ${r.uses.length} removed declaration(s) still used (${r.uses.slice(0, 4).map((u) => u.name).join(', ')})`);
              } else {
                const reason = undefinedRemovalBlockReason(task.undefinedAfterRemoval);
                task.reviewProvider = 'deterministic-undefined-after-removal';
                recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
                appendHistoryEvent(task, 'blocked', reason);
                return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
              }
            }
          }
        }
      } catch (e) {
        console.error(`[review] undefined-after-removal check errored for ${task.id} (non-fatal, continuing to the vote): ${e && e.message}`);
      }
    }
  }
  return null;
}

function skipPathCheck({ task, findSkipPathsFn }) {
  // Skip / dismiss paths (see formatSkipPathSection): a pure diff scan, independent of the other checks' switches. Advisory only.
  if (process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE !== 'false'
      && resolveSourceName(task) === 'adhoc'
      && task.adhocResolution === 'implemented'
      && typeof task.rawDiff === 'string' && task.rawDiff.trim()) {
    try {
      const find = findSkipPathsFn || require('./review-skip-paths.js').findSkipPaths;
      const r = find({ rawDiff: task.rawDiff });
      if (r && Array.isArray(r.paths)) {
        task.skipPaths = summariseSkipPaths(r);
        if (r.paths.length) {
          appendHistoryEvent(task, 'advisory', `skip-path rule: ${task.skipPaths.total} dismiss/skip path(s) in the diff (${[...new Set(r.paths.map((p) => p.kind))].join(', ')})`);
        }
      }
    } catch (e) {
      console.error(`[review] skip-path check errored for ${task.id} (non-fatal, continuing to the vote): ${e && e.message}`);
    }
  }
  return null;
}

function policyChangeCheck({ task, factCheckVerdict, recordModelOutcome }) {
  // Policy-change classification (src/policy-change.js; brain dump "Pipeline yellow hardening 5/8, revised"): is this diff a change to how the pipeline itself behaves, and can a
  // replay over finished work settle it? Recorded on the task either way so the escalation rate can be measured; it only BLOCKS (escalating to a human) when
  // AGENT_MANAGER_POLICY_CHANGE_ROUTING=true. Never throws.
  if (process.env.AGENT_MANAGER_POLICY_CHANGE_CLASSIFY !== 'false'
      && resolveSourceName(task) === 'adhoc'
      && task.adhocResolution === 'implemented'
      && typeof task.rawDiff === 'string' && task.rawDiff.trim()) {
    try {
      const pc = require('./policy-change.js');
      const rawText = (task.promptContext && task.promptContext.rawText) || '';
      const classification = pc.classifyPolicyChange({ rawDiff: task.rawDiff, text: rawText, title: task.title });
      const decision = pc.decidePolicyRouting({ classification, gateReplay: task.gateReplay, task });
      task.policyChange = {
        at: new Date().toISOString(), policy: !!classification.policy, kinds: classification.kinds, pureMove: !!classification.pureMove, hint: !!classification.hint,
        route: decision.route, reason: decision.reason,
        signals: classification.signals.slice(0, 4).map((x) => ({ kind: x.kind, file: x.file, line: x.line, text: String(x.text || '').slice(0, 120) })),
      };
      if (classification.policy) {
        appendHistoryEvent(task, 'advisory', `policy change: ${classification.kinds.join(', ')} -> ${decision.route}${pc.policyRoutingEnabled() ? '' : ' (shadow: escalation is off)'}`);
      }
      if (decision.route === 'escalate') {
        task.policyChange.brief = pc.buildPolicyBrief({ classification, gateReplay: task.gateReplay, taskTitle: task.title });
        if (pc.policyRoutingEnabled()) {
          const reason = `Policy change: ${classification.kinds.join(', ')} -- ${decision.reason}. Escalated to a human instead of a vote.`.slice(0, 400);
          task.reviewProvider = 'deterministic-policy-change';
          recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
          appendHistoryEvent(task, 'blocked', reason);
          return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
        }
      }
    } catch (e) {
      console.error(`[review] policy-change classification errored for ${task.id} (non-fatal, continuing to the vote): ${e && e.message}`);
    }
  }
  return null;
}

// Runs the six checks in their original order. ctx: { task, repoRoot, factCheckVerdict, recordModelOutcome, findInertFn, findOverlapFn, findUndefinedFn, findSkipPathsFn }.
function runAdvisoryChecks(ctx) {
  for (const check of [inertAdditionsCheck, mockSeamCheck, contentOverlapCheck, undefinedRemovalCheck, skipPathCheck, policyChangeCheck]) {
    const blocked = check(ctx);
    if (blocked) return blocked;
  }
  return null;
}

module.exports = { INERT_MAX_ITEMS, SKIP_PATH_MAX_ITEMS, resolveInertBaseRef, editsOfImplementResponse, summariseUndefinedRemoval, undefinedRemovalWhere, undefinedRemovalBlockReason, summariseInertAdditions, summariseSkipPaths, inertAdditionsCheck, mockSeamCheck, contentOverlapCheck, undefinedRemovalCheck, skipPathCheck, policyChangeCheck, runAdvisoryChecks };
