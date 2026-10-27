'use strict';

// Core reconciliation module for brain-dump entries (2026-10-24).
//
// Reads the brain-dump JSON (same path as python/dashboard/routes/brain_dump.py's
// brain_dump_path()), iterates entries, and for each entry either:
//   - marks it actioned (status='actioned', queuedTaskId, queuedAt) when an existing
//     task already covers the work (mirrors api_brain_dump_prioritize in brain_dump.py ~line 200), or
//   - marks it possibly-resolved (status='possibly-resolved') when every cited path
//     is missing from the target repo.
//
// Edge cases:
//   - Empty array returns zero counts, no write.
//   - findExistingWorkForEntry / checkEntryTargets throw: log and skip.
//   - JSON parse error: throw with path.
//   - Write failure: log then throw.
//   - dryRun: log + record changes but do not write.

const fs = require('fs');
const path = require('path');
const { findExistingWorkForEntry } = require('./brain-dump-existing-work.js');
const { checkEntryTargets } = require('./brain-dump-target-check.js');

// Mirror python/dashboard/app.py's brain_dump_path() logic (line 689):
//   1. AGENT_MANAGER_BRAIN_DUMP_PATH env var (highest priority)
//   2. AGENT_MANAGER_BRAIN_DUMP_PATH from env file (fallback)
//   3. get_pipeline_dir() / "brain-dump.json"
// The JS side cannot read the Python env file directly, so we honor the env var and
// fall back to a pipeline-dir-relative path. Callers that need the env-file fallback
// should set the env var themselves before invoking this module.
function getBrainDumpPath() {
  if (process.env.AGENT_MANAGER_BRAIN_DUMP_PATH) {
    return process.env.AGENT_MANAGER_BRAIN_DUMP_PATH;
  }
  // Try to get pipeline dir from config (if available)
  try {
    const config = require('./config.js');
    const cfg = config.getConfig ? config.getConfig() : config;
    if (cfg && cfg.pipelineDir) {
      return path.join(cfg.pipelineDir, 'brain-dump.json');
    }
  } catch {
    // config not available, fall through
  }
  // Last resort: current working directory
  return path.join(process.cwd(), 'brain-dump.json');
}

function reconcileBrainDumpEntries(options) {
  const opts = options || {};
  const dryRun = opts.dryRun === true;
  const logger = opts.logger || console;

  if (typeof logger.info !== 'function' || typeof logger.warn !== 'function') {
    throw new Error('reconcileBrainDumpEntries: logger must have .info and .warn methods');
  }

  const brainDumpPath = getBrainDumpPath();
  if (!brainDumpPath) {
    throw new Error('Cannot determine brain-dump path: no active project configured');
  }

  // 1. Read and parse JSON -- throw on parse error with path
  let entries;
  try {
    const raw = fs.readFileSync(brainDumpPath, 'utf8');
    entries = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`brain-dump JSON not found at ${brainDumpPath}`);
    }
    if (err instanceof SyntaxError) {
      throw new Error(`brain-dump JSON parse error at ${brainDumpPath}: ${err.message}`);
    }
    throw err;
  }

  if (!Array.isArray(entries)) {
    throw new Error(`brain-dump JSON at ${brainDumpPath} does not contain an array`);
  }

  const counts = { actioned: 0, possiblyResolved: 0, checked: 0 };
  const changes = [];

  // Collect pipeline dirs for findExistingWorkForEntry
  let pipelineDirs = [];
  try {
    const config = require('./config.js');
    const cfg = config.getConfig ? config.getConfig() : config;
    if (cfg && cfg.pipelineDir) {
      pipelineDirs = [cfg.pipelineDir];
    }
  } catch {
    // config not available
  }

  // 2. Iterate entries
  for (const entry of entries) {
    counts.checked++;
    const entryId = entry.id;
    if (!entryId) {
      logger.warn(`Skipping entry with no id`);
      continue;
    }
    const entryText = entry.rawText || '';

    // 3. Try findExistingWorkForEntry -- log and skip on throw
    let taskId = null;
    try {
      if (pipelineDirs.length === 0) {
        logger.warn(`No pipeline dir available for entry ${entryId}, skipping`);
        continue;
      }
      const result = findExistingWorkForEntry(pipelineDirs, entry);
      if (result && result.taskId) {
        taskId = result.taskId;
      }
    } catch (err) {
      logger.warn(`findExistingWorkForEntry failed for entry ${entryId}: ${err.message}`);
      continue;
    }

    // 4. If a task exists, action it (mirrors api_brain_dump_prioritize field assignments)
    if (taskId) {
      if (!dryRun) {
        entry.status = 'actioned';
        entry.queuedTaskId = taskId;
        entry.queuedAt = new Date().toISOString();
      }
      counts.actioned++;
      changes.push({ entryId, action: 'actioned', taskId });
      continue;
    }

    // 5. Otherwise, check targets -- log and skip on throw
    let isSuspect = false;
    try {
      const repoRoot = pipelineDirs.length > 0 ? pipelineDirs[0] : process.cwd();
      const result = checkEntryTargets(entryText, { repoRoot });
      if (result && result.verdict === 'suspect') {
        isSuspect = true;
      }
    } catch (err) {
      logger.warn(`checkEntryTargets failed for entry ${entryId}: ${err.message}`);
      continue;
    }

    // 6. If suspect (every cited path missing, or archived, or hub-sequencing), mark possibly-resolved
    if (isSuspect) {
      if (!dryRun) {
        entry.status = 'possibly-resolved';
      }
      counts.possiblyResolved++;
      // Include the first cited path as the "symbol" that doesn't exist, or the entry text if none cited
      const cited = (result && result.cited && result.cited.length > 0) ? result.cited[0] : entryText;
      changes.push({ entryId, action: 'possibly-resolved', symbol: cited });
    }
  }

  // 7. Write back atomically when not dryRun (only if there were changes)
  if (!dryRun && changes.length > 0) {
    try {
      const tmpPath = brainDumpPath + '.tmp.' + process.pid;
      fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
      fs.renameSync(tmpPath, brainDumpPath);
    } catch (err) {
      logger.warn(`Failed to write brain-dump JSON to ${brainDumpPath}: ${err.message}`);
      throw new Error(`brain-dump write failure at ${brainDumpPath}: ${err.message}`);
    }
  }

  return { counts, changes };
}

module.exports = { reconcileBrainDumpEntries };
