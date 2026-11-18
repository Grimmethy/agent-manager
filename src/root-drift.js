'use strict';
// Pure path normalizer for task records when a project's repo root moves.
// Rewrites promptContext.files, the Files: lines in promptContext.body, and
// fetchedFiles[].path from oldRoot-relative to newRoot-relative. Never mutates input.
const posix = require('path').posix;

function cleanRoot(r) {
  if (typeof r !== 'string') return null;
  return r.trim().split(String.fromCharCode(92)).join('/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

// Segment-wise match: 'TaxHarvest/x.js' matches root 'TaxHarvest', 'TaxHarvestX/x.js' does not.
// Formula: the tail after the matched oldRoot segments is joined onto newRoot.
// (Assumed from the plan; confirm with the owner of sibling 3/3.)
function rebase(p, oldRoot, newRoot) {
  const norm = p.replace(/^(\.\/)+/, '');
  const oldSegs = oldRoot.split('/');
  const pSegs = norm.split('/');
  if (pSegs.length < oldSegs.length) return null;
  for (let i = 0; i < oldSegs.length; i++) {
    if (pSegs[i] !== oldSegs[i]) return null;
  }
  const tail = pSegs.slice(oldSegs.length).join('/');
  if (!newRoot) return tail;
  return tail ? posix.join(newRoot, tail) : newRoot;
}

function normalizeTaskPathsToRoot(task, oldRoot, newRoot) {
  const o = cleanRoot(oldRoot);
  const n = cleanRoot(newRoot);
  if (o !== null && n !== null && o === n) return { task, unresolved: [] };
  const valid = !!o && n !== null;
  const unresolved = [];
  const fix = (p) => {
    if (typeof p !== 'string') return p;
    const r = valid ? rebase(p, o, n) : null;
    if (r === null) { unresolved.push(p); return p; }
    return r;
  };
  if (!task || typeof task !== 'object') return { task, unresolved };
  const newTask = { ...task };
  const pc = task.promptContext;
  if (pc && typeof pc === 'object') {
    const newPc = { ...pc };
    if (Array.isArray(pc.files)) newPc.files = pc.files.map(fix);
    if (typeof pc.body === 'string') {
      newPc.body = pc.body.split('\n').map((line) => {
        const m = /^(Files:\s*)(.+)$/i.exec(line);
        if (!m) return line;
        const parts = m[2].split(',').map((part) => {
          const lead = part.match(/^\s*/)[0];
          const rest = part.slice(lead.length);
          const trail = rest.match(/\s*$/)[0];
          const token = rest.slice(0, rest.length - trail.length);
          if (!token) return part;
          return lead + fix(token) + trail;
        });
        return m[1] + parts.join(',');
      }).join('\n');
    }
    if (Array.isArray(pc.fetchedFiles)) {
      newPc.fetchedFiles = pc.fetchedFiles.map((f) =>
        f && typeof f === 'object' && 'path' in f ? { ...f, path: fix(f.path) } : f);
    }
    newTask.promptContext = newPc;
  }
  return { task: newTask, unresolved };
}

module.exports = { normalizeTaskPathsToRoot };
