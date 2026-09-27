'use strict';

// candidate-dedupe.js -- "is this candidate already in the doc?" for the finding-driven candidate docs
// (function_length / observability / performance).
//
// Why (2026-09-26): a requeued function_length_review task re-drafted a finding whose first copy was
// already on master (AC-51) and appended it again (AC-187), because applyArchDiscoveryCandidates only
// makes the AC id unique -- it never asks whether the same file + function is already there. The one
// upstream guard, taskIdExistsInQueue, keys on a task id that embeds the LINE number, so a moved
// function or a requeue looks new. This keys on what the candidate is ABOUT instead.
//
// Key = sorted normalized Files: paths + the first backticked identifier in the title. Line numbers and
// AC ids never enter it. A candidate with no files or no backticked identifier has no key and never
// matches (fail-open: hand-authored arch entries and anything we cannot identify are appended as before).

function normalizeFiles(filesLine) {
  return String(filesLine || '')
    .split(/[\s,;]+/)
    .map((p) => p.replace(/[`'"]/g, '').replace(/^\.\//, '').replace(/:\d+(?:-\d+)?$/, '').trim())
    .filter(Boolean)
    .sort();
}

function titleIdentifier(title) {
  const m = String(title || '').match(/`([^`]+)`/);
  if (!m) return '';
  return m[1].replace(/\(\)$/, '').trim().toLowerCase();
}

// { title, files } -> a stable string, or null when the candidate cannot be identified.
function candidateKey(candidate) {
  if (!candidate) return null;
  const files = normalizeFiles(candidate.files);
  const ident = titleIdentifier(candidate.title);
  if (files.length === 0 || !ident) return null;
  return `${files.join('|')}::${ident}`;
}

// A doc text -> [{ id: 'AC-51', key }] for every "### AC-N · Title" entry that has a key.
function entriesIn(text) {
  const out = [];
  const blocks = String(text || '').split(/(?=^###\s*AC-\d+)/m);
  for (const block of blocks) {
    const head = block.match(/^###\s*(AC-\d+)\s*(?:[·:—-]\s*)?(.+)$/m);
    if (!head) continue;
    const filesMatch = block.match(/^Files:\s*(.+)$/m);
    const key = candidateKey({ title: head[2], files: filesMatch ? filesMatch[1] : '' });
    if (key) out.push({ id: head[1], key });
  }
  return out;
}

// candidate + [{ ref, text }] -> { duplicateOf: 'AC-N', ref } for the first doc that already has the same
// key, else null. `ref` is a label only ('working-tree', 'master', 'agent/...'), used in the skip reason.
function findDuplicateCandidate(candidate, docTexts) {
  const key = candidateKey(candidate);
  if (!key) return null;
  for (const { ref, text } of docTexts || []) {
    const hit = entriesIn(text).find((e) => e.key === key);
    if (hit) return { duplicateOf: hit.id, ref };
  }
  return null;
}

module.exports = { candidateKey, entriesIn, findDuplicateCandidate, normalizeFiles, titleIdentifier };
