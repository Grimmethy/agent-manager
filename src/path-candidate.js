'use strict';

// The implement draft appends this marker to a path it will create.
const NEW_FILE_MARKER = '(new)';

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//;
const WWW_RE = /^www\./;
const GITHUB_PREFIX_RE = /^github\.com\//;
const BARE_LIBRARY_RE = /^[A-Z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
const URL_IN_TEXT_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s)<>]+/gi;
const KEYWORD_RE = /\b(github|npm|package)\b/i;
const KEYWORD_WINDOW = 40;

function isExactAt(text, token, idx) {
  const before = text[idx - 1] || '';
  const after = text[idx + token.length] || '';
  return !/[A-Za-z0-9_\/-]/.test(before) && !/[A-Za-z0-9_\/-]/.test(after);
}

function tokenInsideUrl(token, text) {
  const urls = text.match(URL_IN_TEXT_RE) || [];
  return urls.some((u) => u.includes(token));
}

function tokenBesideKeyword(token, text) {
  let idx = text.indexOf(token);
  while (idx !== -1) {
    if (isExactAt(text, token, idx)) {
      const before = text.slice(Math.max(0, idx - KEYWORD_WINDOW), idx);
      const after = text.slice(idx + token.length, idx + token.length + KEYWORD_WINDOW);
      if (KEYWORD_RE.test(before) || KEYWORD_RE.test(after)) return true;
    }
    idx = text.indexOf(token, idx + 1);
  }
  return false;
}

/**
 * Decide whether a token from a task's text should be treated as a repo path
 * that must exist (or be marked NEW_FILE_MARKER).
 * @param {string} token
 * @param {{ exists?: (t: string) => boolean, context?: string }} [opts]
 * @returns {boolean}
 */
function isRepoPathCandidate(token, { exists = () => false, context = '' } = {}) {
  if (typeof token !== 'string' || token.length === 0) return false;
  if (URL_SCHEME_RE.test(token) || WWW_RE.test(token) || GITHUB_PREFIX_RE.test(token)) {
    return false;
  }
  if (!token.includes('/') && BARE_LIBRARY_RE.test(token)) {
    return exists(token) === true;
  }
  if (token.includes('/')) {
    const text = typeof context === 'string' ? context : '';
    if (tokenInsideUrl(token, text) || tokenBesideKeyword(token, text)) return false;
  }
  return true;
}

module.exports = { isRepoPathCandidate, NEW_FILE_MARKER };
