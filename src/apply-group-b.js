'use strict';

// Deterministic (no-LLM) applier for "Group B" task sources -- ones whose implement draft
// is a real source-code change, expressed as grammar-constrained JSON rather than prose.
// Mirrors the Edit tool's own safety rule: an edit only proceeds on an EXACT, UNIQUE match
// of `find` in the target file -- zero matches or more than one both fail loudly rather
// than guessing. Part of removing an LLM from the apply step entirely -- see apply-task.js,
// which calls this after a task has already been reviewed and approved.
//
// implementResponse is EITHER a single change object or a JSON array of them (a candidate
// can legitimately span multiple files -- e.g. "extract shared code into a new file, plus
// update every file that now imports it"). Each item is applied in sequence with the same
// per-item safety checks; the whole task fails (nothing partial is left committed -- see
// apply-task.js's cleanup-on-failure) if ANY item fails, including ones after an earlier
// item already succeeded on disk.

const fs = require('fs');
const path = require('path');
const { parseJsonMaybeFenced } = require('./json-fence.js');

function resolveInRepo(repoRoot, relFile) {
  if (!relFile || typeof relFile !== 'string' || !relFile.trim()) {
    throw new Error('Group B implementResponse is missing a "file" path');
  }
  const resolved = path.resolve(repoRoot, relFile);
  const rootResolved = path.resolve(repoRoot);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`Refusing to write outside the repo root: ${relFile}`);
  }
  return resolved;
}

function applyOneChange(parsed, repoRoot, pipelineDir) {
  const fullPath = resolveInRepo(repoRoot, parsed.file);
  const relFile = parsed.file;

  if (parsed.mode === 'create') {
    if (fs.existsSync(fullPath)) {
      throw new Error(`File already exists, refusing to overwrite via create mode: ${relFile}`);
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, parsed.content || '');
    return { mode: 'create', file: relFile };
  }

  if (parsed.mode === 'edit') {
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File does not exist, cannot edit: ${relFile}`);
    }
    const text = fs.readFileSync(fullPath, 'utf8');
    const find = parsed.find || '';
    const matchCount = find ? text.split(find).length - 1 : 0;
    if (matchCount === 0) {
      throw new Error(`find string not found in ${relFile}`);
    }
    if (matchCount > 1) {
      throw new Error(`find string matches ${matchCount} times in ${relFile}, ambiguous -- refusing to guess which occurrence`);
    }
    const updated = text.replace(find, parsed.replace || '');
    fs.writeFileSync(fullPath, updated);
    return { mode: 'edit', file: relFile };
  }

  if (parsed.mode === 'delete') {
    const killSwitchPath = path.join(pipelineDir, 'queue', '.delete-mode-disabled');
    if (fs.existsSync(killSwitchPath)) {
      throw new Error(`Delete mode is currently disabled (queue/.delete-mode-disabled marker present) -- refusing to delete ${relFile}`);
    }
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File does not exist, cannot delete: ${relFile}`);
    }
    fs.unlinkSync(fullPath);
    return { mode: 'delete', file: relFile };
  }

  throw new Error(`Unknown or missing mode in Group B implementResponse: ${parsed.mode}`);
}

function applyGroupB({ implementResponse, repoRoot, pipelineDir }) {
  let parsed;
  try {
    parsed = parseJsonMaybeFenced(implementResponse);
  } catch (e) {
    throw new Error(`Invalid JSON in Group B implementResponse: ${e.message}`);
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) {
    throw new Error('Group B implementResponse is an empty array -- nothing to apply');
  }

  const files = [];
  for (const item of items) {
    const result = applyOneChange(item, repoRoot, pipelineDir);
    files.push(result.file);
  }

  return { files };
}

module.exports = { applyGroupB };
