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
// per-item safety checks; the whole task fails if ANY item fails, including ones after an
// earlier item already succeeded on disk -- and unlike relying on apply-task.js's git-branch
// cleanup alone (checkoutMain + deleteBranch, which does nothing for UNCOMMITTED working-
// tree writes: an untracked `create` persists regardless of branch, and an `edit` to a file
// identical on both branches just rides along as a dirty change on whichever branch git ends
// up on -- the exact "abandon the branch" failure mode TheAgent's server/effects.js was
// written to replace), this file now undoes its own already-applied items itself before
// propagating the failure. Every applied item's inverse (prior bytes, or "didn't exist" for
// a create) is computed AT APPLY TIME from what was actually on disk, not guessed from the
// forward change -- see applyOneChange's own comment on why an edit's inverse can't just be
// find/replace swapped back.

const fs = require('fs');
const path = require('path');
const { parseJsonMaybeFenced } = require('./json-fence.js');
const { writeAtomicSync } = require('./atomic-write.js');

// Look-ahead used by apply-task.js's awaiting-confirm gate: does this batch contain a
// `delete`, WITHOUT executing anything. Best-effort and non-throwing on purpose -- this
// runs before the real apply, purely to decide whether to hold for a human first; a
// malformed implementResponse here just means "can't tell, don't hold it up," since the
// real, authoritative parse-and-fail-loudly already happens inside applyGroupB itself.
function batchContainsDeleteMode(implementResponse) {
  let parsed;
  try {
    parsed = parseJsonMaybeFenced(implementResponse);
  } catch {
    return false;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.some((item) => item && item.mode === 'delete');
}

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
    // Inverse of a create is "this file didn't exist" -- delete it back out, not restore
    // content (there was none).
    return { mode: 'create', file: relFile, inverse: { file: fullPath, kind: 'absent' } };
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
    // Inverse restores the exact prior bytes captured just above, NOT a find/replace swap
    // (replace: find, find: replace) -- swapping back can't be trusted to still be unique,
    // or even present, after the forward edit ran (e.g. the replacement text coincidentally
    // duplicating something already elsewhere in the file).
    return { mode: 'edit', file: relFile, inverse: { file: fullPath, kind: 'content', content: text } };
  }

  if (parsed.mode === 'delete') {
    const killSwitchPath = path.join(pipelineDir, 'queue', '.delete-mode-disabled');
    if (fs.existsSync(killSwitchPath)) {
      throw new Error(`Delete mode is currently disabled (queue/.delete-mode-disabled marker present) -- refusing to delete ${relFile}`);
    }
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File does not exist, cannot delete: ${relFile}`);
    }
    const text = fs.readFileSync(fullPath, 'utf8');
    fs.unlinkSync(fullPath);
    return { mode: 'delete', file: relFile, inverse: { file: fullPath, kind: 'content', content: text } };
  }

  throw new Error(`Unknown or missing mode in Group B implementResponse: ${parsed.mode}`);
}

// Restores one file to the state an applyOneChange inverse record describes. 'absent' undoes
// a create (delete it back out); 'content' restores the exact prior bytes for an edit or
// delete. Atomic (temp+fsync+rename, see atomic-write.js) specifically because a rollback
// writing corrupt-on-crash bytes back would be worse than the original failure it's trying
// to clean up after -- the forward writes above stay plain fs.writeFileSync, matching the
// Edit tool's own semantics this file otherwise mirrors; only the restore path needs the
// extra guarantee.
function revertOne(inverse) {
  if (inverse.kind === 'absent') {
    fs.unlinkSync(inverse.file);
  } else {
    fs.mkdirSync(path.dirname(inverse.file), { recursive: true });
    writeAtomicSync(inverse.file, inverse.content);
  }
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
  const inverses = []; // in commit order; unwound in reverse order on a later item's failure
  for (const item of items) {
    let result;
    try {
      result = applyOneChange(item, repoRoot, pipelineDir);
    } catch (err) {
      // ALL-OR-NOTHING: undo every item already applied earlier in THIS batch before
      // propagating, so a caller that can only abandon the git branch (apply-task.js) isn't
      // left relying on that alone for working-tree correctness -- see the file header.
      // Best-effort: a revert failure is reported in the thrown message rather than masking
      // the original failure or being silently swallowed.
      const revertErrors = [];
      for (const inv of [...inverses].reverse()) {
        try {
          revertOne(inv);
        } catch (revertErr) {
          revertErrors.push(`${inv.file}: ${revertErr.message}`);
        }
      }
      const suffix = revertErrors.length
        ? ` (rollback of ${inverses.length} already-applied item(s) had ${revertErrors.length} failure(s): ${revertErrors.join('; ')})`
        : inverses.length ? ` (rolled back ${inverses.length} already-applied item(s))` : '';
      throw new Error(`${err.message}${suffix}`);
    }
    files.push(result.file);
    inverses.push(result.inverse);
  }

  return { files };
}

module.exports = { applyGroupB, batchContainsDeleteMode };
