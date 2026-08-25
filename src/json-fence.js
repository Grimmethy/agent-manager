'use strict';

// Local-model drafts intended as raw JSON (county index files, Group B change objects) sometimes
// wrap the JSON in a markdown code fence (```json ... ``` or plain ```), and sometimes add
// trailing prose commentary AFTER the closing fence (confirmed live 2026-07-14 on a
// state_targets draft: "```json\n{...}\n```\n\nNOTE: Flag #7 was applied by..."). Shared by
// apply-group-a.js and apply-group-b.js so both appliers tolerate a fenced block ANYWHERE in
// the text, not just a bare string that IS the fence, instead of throwing "Unexpected token
// '`'" on the leading fence marker or including trailing prose in what gets parsed.

// Scans `text` for the first '{' or '[' and returns the exact substring spanning to its
// matching closing bracket, tracking string literals (so a brace/bracket inside a JSON
// string value doesn't confuse the depth count) -- recovers JSON preceded (and/or followed)
// by conversational prose with NO code fence at all, which the fence regex above can't help
// with. Confirmed live 2026-07-25: an implementResponse of `Let me examine the file...` (no
// fence, real JSON later in the response) failed apply with "Unexpected token 'L'" even
// though the JSON itself, once located, was completely valid.
function extractBalancedJson(text) {
  const startMatch = text.match(/[[{]/);
  if (!startMatch) return null;
  const start = startMatch.index;
  const openChar = text[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\') { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced -- likely a truncated response, nothing recoverable
}

function parseJsonMaybeFenced(text) {
  const trimmed = (text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/i);
  if (fenced) return JSON.parse(fenced[1]);

  try {
    return JSON.parse(trimmed);
  } catch (directParseError) {
    const extracted = extractBalancedJson(trimmed);
    // Nothing recoverable -- surface the ORIGINAL parse error (on the full trimmed text),
    // not a confusing secondary error about the extraction attempt itself.
    if (!extracted) throw directParseError;
    return JSON.parse(extracted);
  }
}

module.exports = { parseJsonMaybeFenced, extractBalancedJson };
