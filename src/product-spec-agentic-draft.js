'use strict';

// Agentic drafting for BROWNFIELD product_spec tasks (2026-08-30). Mirrors
// research-agentic-draft.js's shape almost line-for-line: a real agentic Claude Code CLI
// call with read-only Read/Grep/Glob tool access against a throwaway clone of the target
// repo, whose markdown write-up IS the output.
//
// Why this exists: the normal product_spec path (prompts.js's productSpecPlanPrompt /
// productSpecImplementPrompt, run through local-draft.js's runPlanPass -> runImplementPass)
// hands the local model the request text + current spec doc as its ONLY context, no code
// access. That is correct for a GREENFIELD project (the spec invents entities from a
// concept). For a project that already has a real codebase, the request describes
// structure that already exists in code -- the local model, blind, returns an empty plan
// and the task hard-blocks ("Plan pass degenerate: empty") with zero signal. This module
// runs against the real code instead.
//
// The agentic pass emits the spec as plain markdown ending with a `SPEC:` sentinel -- it
// is NEVER asked to reproduce a Group-B JSON string (the "echo back a giant JSON blob"
// requirement is this pipeline's most repeated failure mode). draftProductSpecImplement
// wraps the markdown into a Group-B {"mode":"create"|"edit", ...} change deterministically.
//
// Limitation: `git clone --depth 1` captures the target repo's committed HEAD only --
// uncommitted working-tree changes in repoRoot are invisible to this pass. Acceptable: a
// product spec should be grounded in committed code, not local scratch.

const { call: defaultClaudeCall } = require('./claude-client.js');
const { recordCall: defaultRecordModelCall } = require('./model-stats-client.js');
const { getConfig } = require('./config.js');
const { buildProductSpecAgenticPrompt } = require('./prompts.js');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_CLONE_TIMEOUT_MS = 60_000;

// Sized independently and env-configurable, same convention as
// AGENT_MANAGER_RESEARCH_TIMEOUT_MS / _MAX_TURNS. A whole-document spec pass against a
// real codebase does more file reading than a web-research pass but less than adhoc's
// investigate/edit/test cycle -- 20 turns / 15 min covers a ~60-file repo comfortably.
const PRODUCT_SPEC_TIMEOUT_MS = Number(process.env.AGENT_MANAGER_PRODUCT_SPEC_TIMEOUT_MS) || 900_000;
const PRODUCT_SPEC_MAX_TURNS = Number(process.env.AGENT_MANAGER_PRODUCT_SPEC_MAX_TURNS) || 20;

const SPEC_RESULT_RE = /SPEC:\s*(written|insufficient-context)\b/i;

/**
 * Best-effort shallow clone of a LOCAL repo path into a fresh throwaway temp dir. Returns
 * the dir on success, null on any failure (never throws). Cloning (rather than pointing
 * Read/Grep/Glob straight at repoRoot) isolates this read pass from the apply loop's
 * concurrent fetch/reset on the same repoRoot -- same reasoning research-agentic-draft.js
 * and adhoc-agentic-draft.js already apply.
 */
function cloneRepoForSpec(repoRoot, taskId) {
  const dir = path.join(os.tmpdir(), `agent-manager-product-spec-clone-${taskId}-${Date.now()}`);
  try {
    execFileSync('git', ['clone', '--depth', '1', repoRoot, dir], { env: GIT_ENV, timeout: GIT_CLONE_TIMEOUT_MS, stdio: 'pipe' });
    return dir;
  } catch {
    return null;
  }
}

function cleanupClone(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Drafts task.implementResponse for a BROWNFIELD product_spec task via a read-only agentic
 * Claude Code CLI call. Mutates `task` in place (productSpecDoc, implementResponse) on
 * success.
 * @returns {Promise<{succeeded: boolean, blocked?: boolean, blockedReason?: string, reason?: string}>}
 */
async function draftProductSpecImplement(task, { claudeCall = defaultClaudeCall, recordModelCall = defaultRecordModelCall, cloneRepo = cloneRepoForSpec } = {}) {
  const { repoRoot } = getConfig();
  const ctx = task.promptContext || {};

  const cloneDir = cloneRepo(repoRoot, task.id);
  if (!cloneDir) {
    // Infra-style failure -> bounded requeue (phrasing matches local-worker.sh's
    // INFRA_FAILURE_PATTERN, same trick the adhoc/research branches use for the
    // Claude-paused case). Deliberately NOT degrading to the blind greenfield path: mode
    // detection already established this is a real codebase, and the blind path is
    // exactly what empty-blocks on one.
    return { succeeded: false, reason: 'product_spec brownfield: could not clone repo for the code-grounded spec pass (service unavailable) -- will retry.' };
  }

  try {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const result = await claudeCall({
      prompt: buildProductSpecAgenticPrompt(task, { dir: cloneDir }),
      allowedTools: 'Read,Grep,Glob',
      // Read/Grep/Glob resolve relative paths against the clone, not this pipeline's own repo.
      cwd: cloneDir,
      maxTurns: PRODUCT_SPEC_MAX_TURNS,
      permissionMode: 'dontAsk',
      timeoutMs: PRODUCT_SPEC_TIMEOUT_MS,
    });

    task.abCallId = recordModelCall({
      taskId: task.id,
      model: 'claude:product-spec-agentic',
      startedAt,
      latencyMs: Date.now() - startMs,
      result,
    });

    if (result.degenerate) {
      return { succeeded: true, blocked: true, blockedReason: `Product spec agentic pass degenerate: ${result.degenerate}` };
    }

    const response = result.response || '';
    const m = response.match(SPEC_RESULT_RE);
    const resolution = m ? m[1].toLowerCase() : null;
    const body = response.replace(SPEC_RESULT_RE, '').trim();

    if (!resolution) {
      // Same "fail loud, don't guess" reasoning as adhoc/research -- a response with no
      // sentinel is not silently treated as a finished spec.
      return { succeeded: true, blocked: true, blockedReason: `Product spec agentic pass did not end with a SPEC: line -- cannot determine outcome. Output so far: ${body.slice(0, 800)}` };
    }

    if (resolution === 'insufficient-context') {
      return { succeeded: true, blocked: true, blockedReason: `Product spec insufficient-context: ${body.slice(0, 800)}` };
    }

    if (!body.startsWith('#')) {
      return { succeeded: true, blocked: true, blockedReason: `Product spec agentic pass said SPEC: written but produced no markdown document (body does not start with a heading). Output: ${body.slice(0, 800)}` };
    }

    // Deterministic Group-B wrap. edit (spec already exists): full-document find/replace so
    // rollback restores the exact prior version -- `find` is the exact bytes read at task
    // creation (task-sources.js's nextProductSpecTask -> readIfExists), which trivially
    // satisfies apply-group-b.js's "find must be a substring of current content".
    const change = ctx.specExists
      ? { mode: 'edit', file: ctx.specRelPath, find: ctx.currentSpec, replace: body }
      : { mode: 'create', file: ctx.specRelPath, content: body };
    task.productSpecDoc = body;
    task.implementResponse = JSON.stringify(change);

    return { succeeded: true, blocked: false };
  } catch (e) {
    return { succeeded: false, reason: e.message };
  } finally {
    cleanupClone(cloneDir);
  }
}

module.exports = { draftProductSpecImplement, cloneRepoForSpec };
