// src/labels.js -- shared label derivation for agent-manager display
// Placeholder until subtask 4 confirms the real location for this module.
// Contract: deriveLabel(id, record) -> string
//   - Returns record.title when non-empty (trimmed), otherwise derives from id.
//   - Id derivation: strip "queen_" prefix, split on "_", title-case each word,
//     join with spaces.

'use strict';

function titleCase(word) {
  if (!word) return '';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function deriveFromId(id) {
  let slug = id;
  if (slug.startsWith('queen_')) {
    slug = slug.slice('queen_'.length);
  }
  const parts = slug.split('_').filter(Boolean);
  return parts.map(titleCase).join(' ');
}

function deriveLabel(id, record) {
  if (record && typeof record === 'object' && record.title && typeof record.title === 'string') {
    const trimmed = record.title.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return deriveFromId(id);
}

module.exports = { deriveLabel };
