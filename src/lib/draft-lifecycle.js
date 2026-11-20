'use strict';

// draft-lifecycle.js -- extracted from src/local-draft.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const { appendHistoryEvent, setHistoryPersistHook } = require('../task-history.js');
const { resolveSourceName, getRegisteredSource } = require('../task-source-registry.js');

// Defined in ./ollama-lock-key.js (shared with the interactive chat); re-exported below under the same name.
const { localOllamaLockKey } = require('./ollama-lock-key.js');

const PREMIUM_KEYS = ['premiumPriority', 'premiumSetBy', 'premiumSetAt'];

function writeTaskJson(taskPath, task) {
  // Premium fields are carried forward from the on-disk record when the incoming task leaves
  // them undefined, so a stage move or persist-hook write cannot drop the flag. An explicit
  // value (including null/false) from the caller always wins. The caller's object is not mutated.
  const out = { ...task };
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`writeTaskJson: could not read existing record ${taskPath} for premium carry-forward: ${err.message}\n`);
    }
  }
  if (existing && typeof existing === 'object') {
    for (const k of PREMIUM_KEYS) {
      if (out[k] === undefined && existing[k] !== undefined) out[k] = existing[k];
    }
  }
  // Atomic write: the history persist hook (see main()) rewrites this file on every
  // checkpoint while a draft is in flight, and the dashboard polls it concurrently -- a
  // half-written file must never be observable. Same-dir tmp keeps the rename on one fs.
  const tmp = `${taskPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, taskPath);
}

function researchClaudeStatus(task, isClaudePausedFn) {
  const src = resolveSourceName(task) || task.source || 'research_task';
  const optedIn = (process.env.AGENT_MANAGER_CLAUDE_SOURCES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!optedIn.includes(src)) {
    return { ok: false, reason: `research_task drafting needs the Claude Code CLI (WebSearch/WebFetch) -- there is no local web-research capability. Add "${src}" to AGENT_MANAGER_CLAUDE_SOURCES (and set CLAUDE_CODE_OAUTH_TOKEN) to enable it.` };
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { ok: false, reason: 'research_task drafting needs Claude (WebSearch/WebFetch) but CLAUDE_CODE_OAUTH_TOKEN is not set.' };
  }
  if (isClaudePausedFn()) {
    return { ok: false, reason: 'research_task drafting needs Claude (WebSearch/WebFetch) but Claude is manually paused from the Workers tab.' };
  }
  return { ok: true };
}

function isResearchDomainTask(task) {
  return /^Research:/i.test((task && task.title || '').trim());
}

function draftDoneDetail(task) {
  const parts = [];
  if (task.adhocResolution) parts.push(`resolution=${task.adhocResolution}`);
  if (task.localRejectCount) parts.push(`retry ${task.localRejectCount}`);
  const model = task.draftModelDisplay || task.draftModel;
  if (model) parts.push(model);
  return parts.join(', ') || undefined;
}

function concludeDraft(task) {
  task.status = 'needs-review';
  appendHistoryEvent(task, 'draft-done', draftDoneDetail(task));
  appendHistoryEvent(task, 'needs-review');
}

module.exports = { localOllamaLockKey, writeTaskJson, researchClaudeStatus, isResearchDomainTask, draftDoneDetail, concludeDraft };
