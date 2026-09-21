'use strict';

// draft-lifecycle.js -- extracted from src/local-draft.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const { appendHistoryEvent, setHistoryPersistHook } = require('../task-history.js');
const { resolveSourceName, getRegisteredSource } = require('../task-source-registry.js');

// Defined in ./ollama-lock-key.js (shared with the interactive chat); re-exported below under the same name.
const { localOllamaLockKey } = require('./ollama-lock-key.js');

function writeTaskJson(taskPath, task) {
  // Atomic write: the history persist hook (see main()) rewrites this file on every
  // checkpoint while a draft is in flight, and the dashboard polls it concurrently -- a
  // half-written file must never be observable. Same-dir tmp keeps the rename on one fs.
  const tmp = `${taskPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
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
