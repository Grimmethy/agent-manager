'use strict';
/*
 * Sanitizes model-emitted filenames before the apply queue touches disk.
 * Origin: aider's wholefile_coder.py get_edits. It strips `*`, backticks,
 * a trailing ':' and a leading '#', caps the length, and falls back to the
 * basename when a bogus path prefix precedes a known file.
 * Differences: over-length names are rejected, not truncated. The basename
 * fallback requires exactly one in-scope match. Pure function: no disk or
 * model access.
 */
const MAX_FILENAME_LENGTH = 255;

function sanitizeFilename(raw, inScopeSet) {
  if (typeof raw !== 'string') return { error: 'filename is not a string' };
  if (!(inScopeSet instanceof Set)) return { error: 'inScopeSet must be a Set' };

  let s = raw.trim().replace(/[`*]/g, '').trim();
  s = s.replace(/:+$/, '').trim();
  s = s.replace(/^#+/, '').trim();
  if (s.length === 0) return { error: 'empty filename' };
  if (s.length > MAX_FILENAME_LENGTH) {
    return { error: `filename longer than ${MAX_FILENAME_LENGTH} characters` };
  }

  s = s.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) {
    return { error: 'absolute paths are not allowed' };
  }

  const segments = s.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (segments.includes('..')) return { error: 'parent-directory segments are not allowed' };
  if (segments.length === 0) return { error: 'empty filename' };
  const cleaned = segments.join('/');

  if (inScopeSet.has(cleaned)) return { path: cleaned };

  const base = segments[segments.length - 1];
  const matches = [...inScopeSet].filter((p) => p.split('/').pop() === base);
  if (matches.length === 1) return { path: matches[0] };
  if (matches.length === 0) return { error: `not in scope: ${cleaned}` };
  return { error: `ambiguous basename "${base}": ${matches.join(', ')}` };
}

module.exports = { sanitizeFilename, MAX_FILENAME_LENGTH };
