'use strict';

// Ornith drafts intended as raw JSON (county index files, Group B change objects) sometimes
// wrap the JSON in a markdown code fence (```json ... ``` or plain ```), and sometimes add
// trailing prose commentary AFTER the closing fence (confirmed live 2026-07-14 on a
// state_targets draft: "```json\n{...}\n```\n\nNOTE: Flag #7 was applied by..."). Shared by
// apply-group-a.js and apply-group-b.js so both appliers tolerate a fenced block ANYWHERE in
// the text, not just a bare string that IS the fence, instead of throwing "Unexpected token
// '`'" on the leading fence marker or including trailing prose in what gets parsed.
function parseJsonMaybeFenced(text) {
  const trimmed = (text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

module.exports = { parseJsonMaybeFenced };
