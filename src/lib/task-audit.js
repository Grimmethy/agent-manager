'use strict';

// task-audit.js -- extracted from src/task-sources.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../config.js');
const pipelineForensics = require('../pipeline-forensics.js');

function markPipelineHealthAuditChecked() {
  const { pipelineDir } = getConfig();
  const instancesDir = path.join(pipelineDir, 'instances');
  require('../pipeline-health-audit.js').markChecked(instancesDir);
}

function markUiVisibilityAuditChecked() {
  const { pipelineDir } = getConfig();
  const instancesDir = path.join(pipelineDir, 'instances');
  require('../ui-visibility-audit.js').markChecked(instancesDir);
}

function coverageEntryActiveLocal(entry, now) {
  return pipelineForensics.coverageEntryActive(entry, now);
}

function markPipelineDebriefReported(task) {
  const { debriefCoveragePath } = getConfig();
  const windowEnd = task.promptContext && task.promptContext.windowEnd;
  if (!windowEnd) return;
  fs.mkdirSync(path.dirname(debriefCoveragePath), { recursive: true });
  fs.writeFileSync(debriefCoveragePath, JSON.stringify({ lastDebriefedAt: windowEnd, taskId: task.id, reportedAt: new Date().toISOString() }, null, 2));
}

module.exports = { markPipelineHealthAuditChecked, markUiVisibilityAuditChecked, coverageEntryActiveLocal, markPipelineDebriefReported };
