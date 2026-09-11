'use strict';

// Detects whether a model's implement response was truncated (cut off mid-output)
// rather than being a clean refusal or a valid JSON envelope. Used by the review
// pipeline to reject broken drafts before the decode/apply step.
// Run: node --test src/validate-implement-truncation.test.js

const { parseJsonMaybeFenced } = require('./json-fence.js');

// Characters/markers that indicate the text contains code or JSON structure.
const CODE_MARKERS = /[{}\[\]`]/;
const CODE_KEYWORDS = /\b(return|function|const|let|var|import|export|class)\b/;

/**
 * Detect whether `rawText` looks like a truncated model output.
 *
 * @param {string|null|undefined} rawText - The raw implement response text.
 * @returns {{truncated: boolean, reason: string|null}}
 *   - `{ truncated: true, reason: 'truncated output' }` if the text appears truncated.
 *   - `{ truncated: false, reason: null }` if it looks like a valid (or clean refusal) response.
 */
function detectTruncatedImplementResponse(rawText) {
  // 1. Empty / whitespace-only guard.
  if (rawText == null || rawText.trim() === '') {
    return { truncated: true, reason: 'truncated output' };
  }

  const trimmed = rawText.trim();

  // 2. Attempt JSON parse via the shared helper (try first so valid envelopes
  //    are accepted regardless of internal whitespace).
  try {
    parseJsonMaybeFenced(trimmed);
    // Successfully parsed -- valid JSON envelope (possibly fenced).
    return { truncated: false, reason: null };
  } catch {
    // 3. Unparseable. Apply the trailing-unterminated-string heuristic:
    //    the last whitespace-delimited token has an odd number of unescaped
    //    double-quotes (e.g. ...return "Topology).
    const trailingToken = trimmed.split(/\s+/).pop();
    const unescapedQuotes = (trailingToken.match(/(?<!\\)"/g) || []).length;
    if (unescapedQuotes % 2 !== 0) {
      return { truncated: true, reason: 'truncated output' };
    }
    // 4. No code/JSON markers at all -- treat as a clean refusal.
    if (!CODE_MARKERS.test(trimmed) && !CODE_KEYWORDS.test(trimmed)) {
      return { truncated: false, reason: null };
    }
    // 5. Code markers present but unparseable -- truncated.
    return { truncated: true, reason: 'truncated output' };
  }
}

module.exports = { detectTruncatedImplementResponse };
