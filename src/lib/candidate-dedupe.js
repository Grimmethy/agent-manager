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
// Key = sorted normalized Files: paths + one identifier, resolved in this order: (1) an explicit `symbol`
// the source supplied (deterministic -- a doc entry carries it as a `Symbol:` line); (2) the first
// backticked identifier in the title; (3) a conservative fallback for an unbackticked title (see
// fallbackTitleIdentifier). Line numbers and AC ids never enter the key. A candidate with no files or no
// identifier has no key and never matches (fail-open: hand-authored arch entries and anything we cannot
// identify are appended as before).
//
// Why (2) alone was not enough (2026-10-03): backticks in a title are a formatting accident of the model.
// Of 72 function_length entries on master only 11 had a key, and AC-199 `renderHardwareTab` was appended
// again next to AC-52 (identical file and symbol) because neither title had backticks.
//
// Known limit, deliberate: Files stays in the key, so a function that MOVED to another file (AC-198
// applyBrainDumpSort: src/apply-group-a.js -> src/apply-group-a-brain-dump.js) is not matched. A symbol-only
// match is unsafe: distinct functions share names across files (getConfig, resolveGraphPath).

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

// Leading words that introduce the subject of a title ("Decompose applyBrainDumpSort ..."), skipped before
// looking for the identifier. Deliberately a fixed, short list: the fallback only fires when the symbol comes
// right after these, never by scanning the rest of a prose title.
const LEADING_WORDS = new Set([
  'decompose', 'extract', 'split', 'break', 'refactor', 'consolidate', 'unify', 'replace', 'remove', 'add',
  'fix', 'simplify', 'harden', 'guard', 'dedupe', 'wrap', 'move', 'rename', 'merge', 'introduce', 'create',
  'centralize', 'tighten', 'narrow', 'route', 'pull', 'make', 'use', 'the', 'a', 'an',
]);

function looksLikeIdentifier(tok) {
  return tok.length >= 4 && /^[A-Za-z_$][\w$]*$/.test(tok) && (/[a-z][A-Z]/.test(tok) || /[A-Za-z]_[A-Za-z]/.test(tok));
}

// Unbackticked title -> its subject identifier, or ''. Skip the leading verb/article tokens, then look ONLY at
// the first remaining token: it must itself be camelCase or snake_case. "Consolidate the retry logic" and
// "Extract repeated directory-traversal blocks ..." therefore have no identifier (fail-open), and a later
// identifier-like word in prose is never picked up.
function fallbackTitleIdentifier(title) {
  const tokens = String(title || '').split(/\s+/).map((t) => t.replace(/\(\)$/, '').replace(/^[^\w$]+|[^\w$]+$/g, '')).filter(Boolean);
  let i = 0;
  while (i < tokens.length && LEADING_WORDS.has(tokens[i].toLowerCase())) i++;
  const tok = tokens[i];
  return tok && looksLikeIdentifier(tok) ? tok.toLowerCase() : '';
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().replace(/^`+|`+$/g, '').replace(/\(\)$/, '').trim().toLowerCase();
}

// { title, files, symbol? } -> a stable string, or null when the candidate cannot be identified.
function candidateKey(candidate) {
  if (!candidate) return null;
  const files = normalizeFiles(candidate.files);
  const ident = normalizeSymbol(candidate.symbol) || titleIdentifier(candidate.title) || fallbackTitleIdentifier(candidate.title);
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
    const symbolMatch = block.match(/^Symbol:\s*(.+)$/m);
    const key = candidateKey({ title: head[2], files: filesMatch ? filesMatch[1] : '', symbol: symbolMatch ? symbolMatch[1] : '' });
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

module.exports = { candidateKey, entriesIn, findDuplicateCandidate, normalizeFiles, titleIdentifier, fallbackTitleIdentifier };
