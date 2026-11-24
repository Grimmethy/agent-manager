'use strict';

// Human-readable label for an agent-manager record. Prefers the config record's
// title; otherwise derives one from the id (strip a leading queen_ prefix, split
// on underscores, title-case each word, join with spaces).
function deriveLabel(id, record) {
  if (record && typeof record === 'object' && typeof record.title === 'string') {
    const title = record.title.trim();
    if (title) return title;
  }
  const raw = String(id ?? '');
  const stripped = raw.startsWith('queen_') ? raw.slice('queen_'.length) : raw;
  return stripped
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

module.exports = { deriveLabel };
