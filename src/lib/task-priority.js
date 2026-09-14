'use strict';

// task-priority.js -- extracted from src/task-sources.js ([[hub-task-integration]] node-module decompose).

const { getConfig } = require('../config.js');

function taskPriority(name, def) {
  try {
    return getConfig().taskPriorityOverrides[name] ?? def;
  } catch {
    return def;
  }
}

module.exports = { taskPriority };
