'use strict';

// Synchronous atomic file write, ported from TheAgent's server/atomicStore.js
// (writeJsonAtomicSync) -- see the effects.js/apply-group-a.js investigation note. Every
// writer in apply-group-a.js follows a read-whole-file -> mutate -> write-whole-file
// pattern with a plain fs.writeFileSync, which a crash mid-write turns into a truncated,
// unparseable file -- not hypothetical for this pipeline: local-worker.sh's own comment
// documents 16+ tasks left claimed-but-undrafted by a mid-run crash on 2026-07-14, and a
// worker crashed on a live EPIPE during this same investigation (2026-08-16).
//
// The guarantee: write to a temp file in the SAME directory as the target (so the final
// rename is on one volume, hence atomic), fsync it so the bytes are actually on disk
// before the rename makes them visible, then rename over the target. A crash at any point
// before the rename leaves the old file untouched; a crash can never land a rename it
// hasn't durably written first. No per-path write queue (unlike the donor's async
// writeJsonAtomic) -- these callers are exclusively synchronous, and sync writes can't
// interleave with each other since they block the event loop.
const fs = require('fs');
const path = require('path');

function writeAtomicSync(file, contents) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function writeJsonAtomicSync(file, data) {
  writeAtomicSync(file, JSON.stringify(data, null, 2));
}

module.exports = { writeAtomicSync, writeJsonAtomicSync };
