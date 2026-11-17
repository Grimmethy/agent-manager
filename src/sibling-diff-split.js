'use strict';

// splitSiblingDiff(parentPartialDiff, siblings, seededIndex) -> { seed, deferred, receiver }
//
// Pure and synchronous: no fs, no child processes, no timers, no network, no local-client.
//
// Assumed sibling shape: { id, files: [repo-relative paths] }. This is the plan's assumption;
// no caller exists in src/ yet, so it is unverified against a real call site.
//
// Routing, applied in order to each per-file hunk of the parent diff:
//  - file named by no sibling                       -> seed
//  - file named by two or more siblings             -> seed
//  - file named by exactly one sibling at or before
//    seededIndex                                    -> seed
//    (the spec does not cover this case; it is routed to seed so that files already
//    owned by seeded siblings stay with the seed)
//  - file named by exactly one sibling after
//    seededIndex                                    -> deferred, tagged { siblingId: owner.id }
//
// Deferred delivery: every deferred entry is handed to the last sibling. Each entry keeps
// its owning siblingId (per the spec's "tagged with the owning sibling id"), and the result
// carries `receiver` = the last sibling's id (null when there are no siblings).
// `seed` is one concatenated diff string; `deferred` is an array of { siblingId, diff }.
// Original diff order is preserved within both outputs.

// Path from the b/ side of a "diff --git a/<old> b/<new>" header.
function pathFromHeader(line) {
  const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  return m ? m[1] : line;
}

// Split the parent diff into units: one per hunk, each carrying its file's preamble
// (everything from the diff --git line up to the first @@). A file with no hunks becomes
// a single unit holding just its preamble, so nothing is dropped.
function parseDiff(text) {
  const lines = String(text == null ? '' : text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const sections = [];
  let section = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      section = { file: pathFromHeader(line), preamble: [line], hunks: [] };
      sections.push(section);
      continue;
    }
    if (section === null) continue; // text before the first file header
    if (line.startsWith('@@')) {
      section.hunks.push([line]);
      continue;
    }
    if (section.hunks.length) section.hunks[section.hunks.length - 1].push(line);
    else section.preamble.push(line);
  }

  const units = [];
  for (const sec of sections) {
    if (sec.hunks.length === 0) {
      units.push({ file: sec.file, text: sec.preamble.join('\n') + '\n' });
      continue;
    }
    for (const hunkLines of sec.hunks) {
      units.push({
        file: sec.file,
        text: sec.preamble.concat(hunkLines).join('\n') + '\n',
      });
    }
  }
  return units;
}

function splitSiblingDiff(parentPartialDiff, siblings, seededIndex) {
  const list = Array.isArray(siblings) ? siblings : [];

  // file -> indices of the siblings that name it
  const owners = new Map();
  list.forEach((sibling, i) => {
    const files = (sibling && Array.isArray(sibling.files)) ? sibling.files : [];
    for (const f of files) {
      if (!owners.has(f)) owners.set(f, []);
      owners.get(f).push(i);
    }
  });

  const receiver = list.length ? list[list.length - 1].id : null;
  const seed = [];
  const deferred = [];

  for (const unit of parseDiff(parentPartialDiff)) {
    const idx = owners.get(unit.file) || [];
    if (idx.length === 1 && idx[0] > seededIndex) {
      deferred.push({ siblingId: list[idx[0]].id, diff: unit.text });
    } else {
      seed.push(unit.text);
    }
  }

  return { seed: seed.join(''), deferred, receiver };
}

module.exports = { splitSiblingDiff };
