'use strict';
// Batch-write bypass audit: a per-item write inside a loop bypasses the batch API.
// A site is dismissed ONLY on positive proof (balanced braces, no enclosing loop
// in the FULL file, not an unbraced loop body). Every dismissal is recorded.
// No timers: the caller invokes auditFile / auditFiles.

const DEFAULT_CALLEES = ['insertOne', 'insert', 'write', 'save', 'put'];
const LOOP_HEADER = /(\bfor\s*\(|\bwhile\s*\(|\.forEach\s*\(|\.map\s*\(|\bdo\s*\{)/;

function stripNoise(line) {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
}

function findCallSites(lines, callees) {
  const re = new RegExp(`\\.(${callees.join('|')})\\s*\\(`, 'g');
  const sites = [];
  lines.forEach((raw, i) => {
    for (const m of stripNoise(raw).matchAll(re)) sites.push({ idx: i, callee: m[1] });
  });
  return sites;
}

function bracesBalanced(lines) {
  let depth = 0;
  for (const raw of lines) {
    for (const ch of stripNoise(raw)) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

// Walk upward through the FULL file from the site line; return indexes of
// unmatched '{' (the block headers that enclose the site).
function enclosingOpeners(lines, idx) {
  const openers = [];
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const code = stripNoise(lines[i]);
    for (let c = code.length - 1; c >= 0; c--) {
      if (code[c] === '}') depth++;
      else if (code[c] === '{') {
        if (depth === 0) openers.push(i);
        else depth--;
      }
    }
  }
  return openers;
}

function loopEvidence(lines, idx) {
  const hits = [];
  const check = (i, why) => {
    if (i >= 0 && LOOP_HEADER.test(stripNoise(lines[i]))) hits.push({ line: i + 1, why });
  };
  check(idx, 'site line');
  let p = idx - 1;
  while (p >= 0 && lines[p].trim() === '') p--;
  // Unbraced loop body: the previous statement is a loop header with no '{' or ';'.
  if (p >= 0 && !/[{;}]\s*$/.test(stripNoise(lines[p]).trim())) check(p, 'unbraced body');
  for (const o of enclosingOpeners(lines, idx)) {
    const header = (o > 0 ? lines[o - 1] + ' ' : '') + lines[o];
    if (LOOP_HEADER.test(stripNoise(header))) hits.push({ line: o + 1, why: 'enclosing block header' });
  }
  return hits;
}

function auditFile({ file, text, callees = DEFAULT_CALLEES, history = [], counts = { dismissed: 0, findings: 0 } }) {
  const lines = String(text).split(/\r?\n/);
  const balanced = bracesBalanced(lines);
  const findings = [];
  const dismissals = [];
  for (const { idx, callee } of findCallSites(lines, callees)) {
    const key = `${file}:${idx + 1}:${callee}`;
    const hits = loopEvidence(lines, idx);
    if (!balanced || hits.length > 0) {
      const reason = !balanced
        ? 'unbalanced braces: cannot prove bypass-free'
        : `inside loop (${hits.map((h) => `${h.why} @${h.line}`).join(', ')})`;
      findings.push({ key, file, line: idx + 1, callee, reason });
      counts.findings++;
      continue;
    }
    const event = {
      type: 'batch-write-audit.dismissed',
      key,
      file,
      line: idx + 1,
      callee,
      reason: 'single write: no enclosing loop in full file, braces balanced',
    };
    history.push(event);
    counts.dismissed++;
    dismissals.push(event);
  }
  return { findings, dismissals };
}

// Each entry is audited independently; no cross-project state affects results.
function auditFiles(entries, opts = {}) {
  const history = opts.history || [];
  const counts = opts.counts || { dismissed: 0, findings: 0 };
  const results = entries.map((e) => auditFile({ ...e, callees: opts.callees, history, counts }));
  return { results, history, counts };
}

module.exports = { auditFile, auditFiles, findCallSites, DEFAULT_CALLEES };
