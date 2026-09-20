'use strict';

const fs = require('fs');

// Same literals as src/sdk/candidate-fulfillment.js (the source these were moved out of)
// -- duplicated here rather than required back, so this module stays self-contained.
const QUOTED_SYMBOL_RE = /`([^`]{3,80})`/g;
const SNIPPET_FIELD_RE = /^Snippet:\s*\n```\n([\s\S]*?)\n```/m;

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function quotedSymbolsFromSection(section) {
  return [...(section || '').matchAll(QUOTED_SYMBOL_RE)].map((m) => m[1]).filter(Boolean);
}

function snippetFromSection(section) {
  const m = (section || '').match(SNIPPET_FIELD_RE);
  return m ? m[1] : null;
}

// The section without its `Snippet:` block. The Snippet is copied in by the HARNESS (the review-time flagged code, verbatim), not
// authored by the model, so it says nothing about how big a change the candidate proposes.
function stripSnippetField(section) {
  return (section || '').replace(SNIPPET_FIELD_RE, '');
}

function stripWhitespace(s) {
  return s.replace(/\s+/g, '');
}

function realIndexForStrippedIndex(content, targetStrippedCount) {
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (count === targetStrippedCount) return i;
    if (!/\s/.test(content[i])) count++;
  }
  return content.length;
}

module.exports = {
  readIfExists, quotedSymbolsFromSection, snippetFromSection, stripSnippetField, stripWhitespace, realIndexForStrippedIndex,
};
