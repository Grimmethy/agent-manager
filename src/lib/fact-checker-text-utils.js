'use strict';

// fact-checker-text-utils.js -- extracted from src/fact-checker.js ([[hub-task-integration]] node-module decompose).

function lineRangeOf(fileText, substring) {
  const idx = fileText.indexOf(substring);
  if (idx === -1) return null;
  const startLine = fileText.slice(0, idx).split('\n').length;
  const endLine = startLine + substring.split('\n').length - 1;
  return { startLine, endLine };
}

function extractChangedSpan(oldText, newText) {
  let i = 0;
  while (i < oldText.length && i < newText.length && oldText[i] === newText[i]) i += 1;
  let j = 0;
  while (
    j < oldText.length - i && j < newText.length - i
    && oldText[oldText.length - 1 - j] === newText[newText.length - 1 - j]
  ) j += 1;
  return {
    oldMiddle: oldText.slice(i, oldText.length - j).trim(),
    newMiddle: newText.slice(i, newText.length - j).trim(),
  };
}

function normalizeCode(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

module.exports = { lineRangeOf, extractChangedSpan, normalizeCode };
