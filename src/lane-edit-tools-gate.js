'use strict';

// Pure check: a lane session whose task requires file edits (mustEdit) but whose tool list
// contains no write-capable tool must be refused before any model call. Names mirror the
// WRITE_TOOLS list in local-tool-client.js. No I/O, no model call.

const EDIT_TOOL_NAMES = ['write_file', 'edit_file', 'run_bash'];

// -> null when the session may proceed, else { reason, lane, toolNames }.
function checkLaneEditTools({ lane, toolNames, mustEdit } = {}) {
  if (!mustEdit) return null;
  const names = Array.isArray(toolNames) ? toolNames : [];
  if (names.some((n) => EDIT_TOOL_NAMES.includes(n))) return null;
  const laneName = lane || 'unknown';
  const list = names.length ? names.join(',') : '(none)';
  return {
    reason: `lane-misconfigured: no edit tools for lane ${laneName}; tools=${list}`,
    lane: laneName,
    toolNames: names,
  };
}

module.exports = { EDIT_TOOL_NAMES, checkLaneEditTools };
