'use strict';

// Task source: brain_dump_resolution_check
// Checks if brain-dump entries are already fixed on master.
// Deterministic evidence pack built before model call, capped at ~3000 chars.
// Deterministic validator downgrades 'yes' if evidence not grounded in pack.

const { buildEvidencePack } = require('./evidence-pack.js');
const { validateResolutionVerdict } = require('./validate-resolution.js');

const TASK_CLASS = 'brain_dump_resolution_check';
const EVIDENCE_CAP = 3000;
const CHECKED_META_KEY = 'resolutionCheck';

// Filter entries that should be checked
function shouldCheckEntry(entry) {
  if (entry.status !== 'sorted' && entry.status !== 'captured') return false;
  if (entry.suppressed) return false;
  if (!hasCodeReference(entry.rawText)) return false;
  if (looksLikeResearch(entry.rawText)) return false;
  if (isAlreadyChecked(entry)) return false;
  return true;
}

// Check if entry has backticked code references
function hasCodeReference(text) {
  return /`[^`]+`/.test(text || '');
}

// Check if entry looks like research/links
function looksLikeResearch(text) {
  return /https?:\/\//.test(text || '') || /\b(research|paper|link)\b/i.test(text || '');
}

// Check if entry already checked at current master SHA
function isAlreadyChecked(entry) {
  const meta = entry[CHECKED_META_KEY];
  if (!meta || !meta.masterSha) return false;
  return meta.masterSha === entry._currentMasterSha;
}

// Next function: yields entries ready for checking
function next(options) {
  const { entries, masterSha } = options;
  return entries
    .filter(shouldCheckEntry)
    .map(entry => ({
      entry,
      masterSha,
      evidencePack: buildEvidencePack(entry, masterSha, EVIDENCE_CAP),
    }));
}

// Apply function: sets possiblyResolved on validated 'yes', records check otherwise
function apply(options) {
  const { entry, verdict, evidence, masterSha } = options;
  
  if (verdict.resolved === 'yes') {
    entry.possiblyResolved = {
      evidence: evidence,
      masterSha: masterSha,
      checkedAt: new Date().toISOString(),
    };
  } else {
    entry[CHECKED_META_KEY] = {
      at: new Date().toISOString(),
      masterSha: masterSha,
      verdict: verdict.resolved,
    };
  }
}

// Validate verdict deterministically
function validate(options) {
  const { verdict, evidence, evidencePack } = options;
  return validateResolutionVerdict(verdict, evidence, evidencePack);
}

// Local call function (injected in tests)
function localCall(options) {
  const { entry, evidencePack } = options;
  // Default response: unclear
  return { resolved: 'unclear', evidence: '' };
}

module.exports = {
  TASK_CLASS,
  EVIDENCE_CAP,
  CHECKED_META_KEY,
  next,
  apply,
  validate,
  localCall,
  hasCodeReference,
  looksLikeResearch,
  isAlreadyChecked,
};
