'use strict';

// Pure create-intent classifier (HUB0395 1/5). No I/O: string and regex work only.
// The create-target regex sources below are copied verbatim from src/plan-target-guard.js,
// where the same constants are module-private. Keep the copies in sync until they are unified.

const CREATE_FILE_VERBS_RE = /\b(?:create|creates|creating|add(?:s|ing)?\s+a\s+new\s+file|new\s+file\s+(?:at|named)?)\b[^\n]{0,80}$/i;
const WRITE_FILE_PHRASE_RE = /\bwrite\s+(?:(?:the|a|an|one|single|new)\s+)+file[\s,:;(`'"*_-]*$/i;
const DIRECT_CREATE_RE = /\b(?:create|creates|creating|add|adds|adding)\s+(?:(?:the|a|an|one|single|new)\s+)*(?:file\s+)?[\s`'"*_(]*$/i;
const EXPLICIT_TYPE_RE = /\{[^}]*type\s*:\s*['"]?(create|modify)['"]?[^}]*path\s*:\s*['"]?([^'"}\s]+)['"]?[^}]*\}/gi;

// Verbs from the task spec, used for the proximity check (not part of the copied marker wording).
const CREATE_INTENT_VERB_RE = /\b(?:build|builds|building|add|adds|adding|create|creates|creating|new\s+module|new\s+file)\b/i;

function basenameOf(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

// every occurrence of needle in text, as start indexes
function mentionIndexes(text, needle) {
  const out = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

// Is there a create verb in the ~80 chars directly before this mention?
function createVerbBefore(text, idx) {
  const before = text.slice(Math.max(0, idx - 80), idx);
  return CREATE_INTENT_VERB_RE.test(before) || CREATE_FILE_VERBS_RE.test(before) || WRITE_FILE_PHRASE_RE.test(before) || DIRECT_CREATE_RE.test(before);
}

function hasCreateIntent(missingPath, taskText, planText) {
  if (typeof missingPath !== 'string' || !missingPath.trim()) return false;
  const target = missingPath.trim();
  const task = typeof taskText === 'string' ? taskText : '';
  const plan = typeof planText === 'string' ? planText : '';

  // Explicit create marker, same form the guard accepts: {type: 'create', path: '...'}
  const markerRe = new RegExp(EXPLICIT_TYPE_RE.source, 'gi');
  for (let m = markerRe.exec(plan); m !== null; m = markerRe.exec(plan)) {
    if (m[1].toLowerCase() === 'create' && m[2] === target) return true;
  }

  // Create verb near the path or its basename, in the task text or the plan steps.
  const base = basenameOf(target);
  const needles = base && base !== target ? [target, base] : [target];
  for (const text of [task, plan]) {
    for (const needle of needles) {
      for (const idx of mentionIndexes(text, needle)) {
        if (createVerbBefore(text, idx)) return true;
      }
    }
  }
  return false;
}

module.exports = { hasCreateIntent };
