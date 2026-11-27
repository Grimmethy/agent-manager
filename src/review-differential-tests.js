'use strict';

// Pure differential classifier for covering-test failures. No I/O: arrays in, values out.
//
// Failure records may be plain strings (current parser output, which carries no file) or
// {file, name} objects (the shared contract). Matching uses file plus name; a string
// record has an empty file.

const SEPARATOR = '\u0000';

function fileOf(record) {
  if (record && typeof record === 'object' && typeof record.file === 'string') return record.file;
  return '';
}

function nameOf(record) {
  if (typeof record === 'string') return record;
  if (record && typeof record === 'object' && typeof record.name === 'string') return record.name;
  return '';
}

function failureKey(record) {
  return fileOf(record) + SEPARATOR + nameOf(record);
}

// Failures on the branch that also fail on base go to advisory (pre-existing); the rest
// go to blocking. Entries are the original record references, in branch order. Base-only
// failures are not reported.
function classifyCoveringFailures(args) {
  const opts = args && typeof args === 'object' ? args : {};
  const branch = Array.isArray(opts.branchFailures) ? opts.branchFailures : [];
  const base = Array.isArray(opts.baseFailures) ? opts.baseFailures : [];
  const baseKeys = new Set(base.map(failureKey));
  const blocking = [];
  const advisory = [];
  for (const record of branch) {
    if (baseKeys.has(failureKey(record))) advisory.push(record);
    else blocking.push(record);
  }
  return { blocking, advisory };
}

// Returns a display string for a failure record. Never returns an object's string form.
function formatTestName(record) {
  if (typeof record === 'string') return record;
  if (record && typeof record === 'object') {
    const hasName = typeof record.name === 'string' && record.name.length > 0;
    const hasFile = typeof record.file === 'string' && record.file.length > 0;
    if (hasName && hasFile) return record.file + ' \u203A ' + record.name;
    if (hasName) return record.name;
    if (hasFile) return record.file;
  }
  return '(unnamed test)';
}

module.exports = { classifyCoveringFailures, formatTestName };
