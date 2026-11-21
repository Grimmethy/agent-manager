/**
 * path-validator.js
 *
 * Purpose: check whether file paths mentioned in a draft exist in a repository,
 * and suggest a close real path for any that do not.
 *
 * Method:
 *   - Path-like tokens are extracted with the regex
 *     /`([^`\s]+)`|([^\s`'"()\[\]{}<>,;!?]+)/ (backtick-quoted run, or a run of
 *     non-punctuation characters). A token is path-like when it contains "/" or
 *     ends in a known file extension. Trailing "." or ":" is stripped. Tokens
 *     containing "://" are skipped.
 *   - Tokens are deduped in first-seen order into allPaths.
 *   - validateDraftPaths returns { allPaths, valid, fabricated }. The keys
 *     "valid" and "fabricated" are the classification lists. A path is valid when
 *     fs.existsSync(path.resolve(repoRoot, p)) is true.
 *   - findCloseMatch scores each candidate as 1 - dist / max(len), using a
 *     two-row Levenshtein distance. It returns the highest score at or above 0.7,
 *     with ties going to the earlier entry, or null.
 *   - isDegenerateRevision assumes the revision text is in result.text.
 *
 * Known gaps: the token regex is heuristic. Paths containing spaces are not
 * detected. A slash-containing word such as "and/or" is treated as a path and
 * will show up as fabricated.
 */

const fs = require('fs');
const path = require('path');

const EXT_RE = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|md|json|ya?ml|sh|css|html?|txt|toml|cfg|lock)$/i;
const TRAILING_PUNCT_RE = /[.:]+$/;
const SIMILARITY_THRESHOLD = 0.7;

function levenshtein(a, b) {
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

function extractPathTokens(draft) {
  const re = /`([^`\s]+)`|([^\s`'"()\[\]{}<>,;!?]+)/g;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(draft)) !== null) {
    let tok = (m[1] || m[2] || '').replace(TRAILING_PUNCT_RE, '');
    if (!tok || tok.includes('://')) continue;
    if (!(tok.includes('/') || EXT_RE.test(tok))) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function validateDraftPaths(draft, repoRoot) {
  const allPaths = extractPathTokens(typeof draft === 'string' ? draft : '');
  const valid = [];
  const fabricated = [];
  for (const p of allPaths) {
    if (fs.existsSync(path.resolve(repoRoot, p))) valid.push(p);
    else fabricated.push(p);
  }
  return { allPaths, valid, fabricated };
}

function findCloseMatch(fabricatedPath, realPaths) {
  if (typeof fabricatedPath !== 'string') return null;
  if (!Array.isArray(realPaths) || realPaths.length === 0) return null;
  let bestPath = null;
  let bestScore = -Infinity;
  for (const real of realPaths) {
    const maxLen = Math.max(fabricatedPath.length, real.length);
    const score = maxLen === 0 ? 1 : 1 - levenshtein(fabricatedPath, real) / maxLen;
    if (score > bestScore) {
      bestScore = score;
      bestPath = real;
    }
  }
  return bestScore >= SIMILARITY_THRESHOLD ? bestPath : null;
}

function isDegenerateRevision(result) {
  if (result === null || typeof result !== 'object') return true;
  const text = result.text;
  if (typeof text !== 'string') return true;
  if (text.trim() === '') return true;
  if (result.original !== undefined && text === result.original) return true;
  return false;
}

module.exports = { validateDraftPaths, findCloseMatch, isDegenerateRevision };
