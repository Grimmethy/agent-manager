'use strict';

// JS port of the wikilink helpers in python/build_note_graph.py
// (_extract_wikilink_targets and resolve_wikilink). Keep the two in step.

// Same pattern as WIKILINK_RE in build_note_graph.py: `[[Name]]`, `[[Name|alias]]`,
// `[[Name#heading]]`. Only the text before the first `|` or `#` names the target.
const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

// Returns the raw note names referenced by every [[...]] span in `text`, trimmed.
// Duplicates are kept; de-duplication happens after resolution, as in the Python.
function extractWikilinkTargets(text) {
  const targets = [];
  for (const match of String(text).matchAll(WIKILINK_RE)) {
    const name = match[1].trim();
    if (name) targets.push(name);
  }
  return targets;
}

// Builds the basename index that resolveWikilink expects: a Map from lowercase
// basename (no .md suffix) to the list of relative paths that share it.
function buildBasenameIndex(relPaths) {
  const index = new Map();
  for (const rel of relPaths) {
    const base = rel.split('/').pop();
    const key = (base.endsWith('.md') ? base.slice(0, -3) : base).toLowerCase();
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(rel);
  }
  return index;
}

// Case-insensitive match of a wikilink name against the basename index.
// Returns the single matching relative path, or null when the name is unknown
// or ambiguous (matches more than one note). Mirrors resolve_wikilink in Python.
function resolveWikilink(name, basenameIndex) {
  let key = String(name).toLowerCase();
  if (key.endsWith('.md')) key = key.slice(0, -3);
  const matches = basenameIndex.get(key);
  if (!matches || matches.length !== 1) return null;
  return matches[0];
}

module.exports = { extractWikilinkTargets, buildBasenameIndex, resolveWikilink };
