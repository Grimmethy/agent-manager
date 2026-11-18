'use strict';

// Pure plan-skip check: decides whether an ask is an explicit, mechanical edit that
// can skip the planning step. No model calls, no fs/process/network I/O. The only
// environment input is the repoFiles array passed by the caller.
// Defaults to skip: false whenever uncertain.

const REJECT_WORDS = ['investigate', 'whether', 'why', 'review', 'decide', 'or'];

function findRejectTerm(ask) {
  if (ask.includes('?')) return '?';
  for (const w of REJECT_WORDS) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(ask)) return w;
  }
  if (/\bcheck if\b/i.test(ask)) return 'check if';
  return null;
}

function canSkipPlan(ask, repoFiles) {
  try {
    if (typeof ask !== 'string' || !Array.isArray(repoFiles)) {
      return { skip: false, reason: 'invalid input', matched: {} };
    }

    const reject = findRejectTerm(ask);
    if (reject) {
      return { skip: false, reason: `contains reject term: ${reject}`, matched: { reject } };
    }

    const verbs = ask.match(/\b(add|replace|remove|rename|update|delete)\b/gi) || [];
    const lineRefs = ask.match(/\bline \d+\b/gi) || [];
    const pairs = ask.match(/"[^"]+"\s*(?:->|→|to|with)\s*"[^"]+"/g) || [];
    const targets = [...lineRefs, ...pairs];

    if (verbs.length < 1) {
      return { skip: false, reason: 'no edit verb', matched: { verbs, targets, paths: [] } };
    }
    if (targets.length < verbs.length) {
      return {
        skip: false,
        reason: `fewer explicit targets (${targets.length}) than edit verbs (${verbs.length})`,
        matched: { verbs, targets, paths: [] },
      };
    }

    const rawPaths = ask.match(/[\w.\-\/]+\/[\w.\-\/]+|[\w.\-]+\.[a-z]{1,5}\b/gi) || [];
    const paths = rawPaths.map((p) => p.replace(/^\.\//, ''));
    if (paths.length === 0) {
      return { skip: false, reason: 'no referenced path', matched: { verbs, targets, paths } };
    }

    const fileSet = new Set(repoFiles);
    const creating = /\b(add|create)\b/i.test(ask);
    for (const p of paths) {
      if (fileSet.has(p) || creating) continue;
      return {
        skip: false,
        reason: `referenced path not in repoFiles: ${p}`,
        matched: { verbs, targets, paths },
      };
    }

    return {
      skip: true,
      reason: 'explicit edits to existing paths',
      matched: { verbs, targets, paths },
    };
  } catch (e) {
    return { skip: false, reason: `error: ${e.message}`, matched: {} };
  }
}

module.exports = { canSkipPlan };
