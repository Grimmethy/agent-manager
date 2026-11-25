'use strict';

// Counts only the pending/ task files that this node can actually claim. A file this node can never claim (leased to another node, or unleased on a
// non-ledger-owner node) is not work in flight here, so it must not throttle generation. Unreadable, unparseable or non-object files are still counted.

const fs = require('fs');
const { claimableOnNode } = require('./node-affinity.js');

function readTaskFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function claimablePendingFiles(files, nodeId = process.env.AGENT_MANAGER_NODE_ID, readTask = readTaskFile) {
  if (!Array.isArray(files)) return [];
  return files.filter((file) => {
    let task;
    try { task = readTask(file); } catch { return true; }
    if (task === null || typeof task !== 'object') return true;
    return claimableOnNode(task, nodeId);
  });
}

module.exports = { claimablePendingFiles };
