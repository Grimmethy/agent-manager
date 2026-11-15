'use strict';

// Project options for the Unmerged Branches project dropdown.
// Pure function: no DOM, no timers, no mutation of its inputs.
// Entries are {label, repoRoot, realRoot?}; the identity of an entry is realRoot || repoRoot.
// Registered projects come first; Second Brain extras are appended only when their identity is new.
// The first entry for an identity wins and keeps its label.

function buildProjectOptions(registered, extras, activeRepoRoot) {
  const regList = Array.isArray(registered) ? registered : [];
  const extraList = Array.isArray(extras) ? extras : [];
  const seen = new Set();
  const options = [];

  const add = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const path = entry.realRoot || entry.repoRoot;
    if (!path || seen.has(path)) return;
    seen.add(path);
    options.push({ label: entry.label, path, selected: false });
  };

  regList.forEach(add);
  extraList.forEach(add);

  let matched = false;
  if (activeRepoRoot) {
    for (const opt of options) {
      if (opt.path === activeRepoRoot) {
        opt.selected = true;
        matched = true;
        break;
      }
    }
    // Nothing matched the active root: add a raw-path option for it and select that.
    if (!matched && typeof activeRepoRoot === 'string') {
      options.push({ label: activeRepoRoot, path: activeRepoRoot, selected: true });
    }
  }
  return options;
}

if (typeof module !== 'undefined') module.exports = { buildProjectOptions };
