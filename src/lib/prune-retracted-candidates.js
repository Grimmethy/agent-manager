'use strict';

// prune-retracted-candidates.js -- drop candidate blocks main has already retracted from the rolling triage branch.
//
// 2026-10-07 (TaxHarvest): a candidate retracted on main (AC-203, AC-262..265) kept coming back on agent/triage-queue. The pipeline merges main into
// that branch with the candidates-doc merge driver, which used to ignore deletions (fixed in src/candidates-doc-merge.js), and once a merge has
// happened the branch's merge base is a main that already lacks the block -- so even the fixed driver sees the stranded block as something the
// BRANCH added and keeps it. This is the paired repair for blocks already stranded.
//
// Signal (deterministic, history-based): a heading main REMOVED at some point (`-### AC-N · title` in the doc's `git log -p`) whose id is NOT
// present at main's tip any more was retracted. A branch block is dropped only when BOTH its id and its title match what main removed (ids are
// never reused, but the title check means a different candidate can never be swept up by an id coincidence). A heading that was merely reworded
// on main (removed then re-added under the same id) is still present at the tip, so it is not a retraction.
//
// Never throws: any git failure, timeout or unparsable doc means "prune nothing". AGENT_MANAGER_PRUNE_RETRACTED=off disables it.

const fs = require('fs');
const path = require('path');

const HEADING_SPLIT_RE = /(?=^#{1,6}\s*AC-\d+)/m;
const HEADING_RE = /^#{1,6}\s*AC-(\d+)\b\s*(?:[·.:\-–—]\s*)?(.*)$/;
const REMOVED_HEADING_RE = /^-(#{1,6}\s*AC-\d+\b.*)$/;
const DOC_PATHSPEC = 'Docs/*_CANDIDATES.md';
const HISTORY_MAX_BUFFER = 256 * 1024 * 1024;

const normTitle = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

function parseHeading(line) {
  const m = String(line || '').trim().match(HEADING_RE);
  return m ? { id: parseInt(m[1], 10), title: normTitle(m[2]) } : null;
}

function pruneEnabled(env = process.env) {
  return String(env.AGENT_MANAGER_PRUNE_RETRACTED || '').trim().toLowerCase() !== 'off';
}

// id -> Set(normalised titles) for every heading the doc's history removed, minus ids still present in `tipText`.
function retractedFromHistory(historyDiffText, tipText) {
  const present = new Set();
  for (const part of String(tipText || '').replace(/\r\n/g, '\n').split(HEADING_SPLIT_RE)) {
    const h = parseHeading(part.split('\n', 1)[0]);
    if (h) present.add(h.id);
  }
  const removed = new Map();
  for (const line of String(historyDiffText || '').replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(REMOVED_HEADING_RE);
    if (!m) continue;
    const h = parseHeading(m[1]);
    if (!h || present.has(h.id)) continue;
    if (!removed.has(h.id)) removed.set(h.id, new Set());
    removed.get(h.id).add(h.title);
  }
  return removed;
}

// -> { text, dropped: [id] }; every other byte of the doc is preserved exactly.
function pruneDocText(docText, retracted) {
  const dropped = [];
  const kept = String(docText || '').split(HEADING_SPLIT_RE).filter((part) => {
    const h = parseHeading(part.split('\n', 1)[0]);
    if (h && retracted.has(h.id) && retracted.get(h.id).has(h.title)) { dropped.push(h.id); return false; }
    return true;
  });
  return { text: kept.join(''), dropped };
}

/**
 * Prune retracted candidate blocks from the working tree's Docs/*_CANDIDATES.md and commit the removal.
 * @param {object} o
 * @param {string} o.repoRoot   working tree on the (already prepared) triage branch
 * @param {(args: string[], extra?: object) => string} o.git   runs git in repoRoot, returns stdout, throws on failure
 * @param {string} o.mainRef    e.g. 'origin/main'
 * @returns {{ pruned: Array<{doc: string, ids: number[]}>, committed: boolean }}
 */
function pruneRetractedCandidates({ repoRoot, git, mainRef, env = process.env }) {
  const result = { pruned: [], committed: false };
  if (!pruneEnabled(env)) return result;
  try {
    const docs = git(['ls-files', '--', DOC_PATHSPEC]).split('\n').map((s) => s.trim()).filter(Boolean);
    const touched = [];
    for (const doc of docs) {
      const abs = path.join(repoRoot, doc);
      if (!fs.existsSync(abs)) continue;
      let tip;
      let history;
      try {
        tip = git(['show', `${mainRef}:${doc}`]);
        history = git(['log', mainRef, '--format=', '-p', '-U0', '--no-color', '--', doc], { maxBuffer: HISTORY_MAX_BUFFER });
      } catch { continue; } // the doc is not on main yet (or git failed): nothing to compare against
      const retracted = retractedFromHistory(history, tip);
      if (retracted.size === 0) continue;
      const before = fs.readFileSync(abs, 'utf8');
      const { text, dropped } = pruneDocText(before, retracted);
      if (dropped.length === 0) continue;
      fs.writeFileSync(abs, text);
      result.pruned.push({ doc, ids: dropped });
      touched.push(doc);
    }
    if (touched.length === 0) return result;
    git(['add', '--', ...touched]);
    const subject = `Drop ${result.pruned.reduce((n, p) => n + p.ids.length, 0)} candidate(s) already retracted on main`;
    const body = result.pruned.map((p) => `- ${p.doc}: ${p.ids.map((i) => `AC-${i}`).join(', ')}`).join('\n');
    const msgPath = path.join(require('os').tmpdir(), `prune-retracted-msg-${process.pid}.txt`);
    fs.writeFileSync(msgPath, `${subject}\n\n${body}\n`);
    try { git(['commit', '-F', msgPath]); } finally { try { fs.unlinkSync(msgPath); } catch { /* best-effort */ } }
    result.committed = true;
  } catch (e) {
    // A write that never got committed must not leave the tree dirty for the next batch's clean-tree check. HEAD, not the index: the pruned text
    // may already be staged.
    try {
      if (result.pruned.length && !result.committed) git(['checkout', 'HEAD', '--', ...result.pruned.map((p) => p.doc)]);
    } catch { /* best-effort */ }
    result.pruned = [];
    console.error(`[prune-retracted-candidates] skipped: ${String(e && e.message).split('\n')[0].slice(0, 200)}`);
  }
  return result;
}

module.exports = { pruneRetractedCandidates, retractedFromHistory, pruneDocText, pruneEnabled };
