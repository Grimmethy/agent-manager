'use strict';

// find-canonicalize.js -- make a Group B `find` string match the file's REAL text when it differs only by typographic characters.
//
// Why (2026-09-20, PropertyForager function-length-fix-ac-3): the file's JSX has a curly-quoted “Owner” (U+201C/U+201D) at char 983 of a
// 1,079-char block the candidate extracts. The local model cannot reproduce it inside a JSON string: it wrote straight quotes ("Owner"),
// then on a retry a literal backslash-u escape (“Owner”). Group B apply needs the find text to match EXACTLY, so every attempt
// died on two characters and the task escalated after five drafts. A find that matches the file once its typographic characters are
// normalised is unambiguous about WHICH text it means, so the fix belongs here: swap in the file's real span, and give the replacement
// the same characters back so moved text keeps its typography.
//
// Deliberately narrow: only 1:1 character maps (quotes, dashes, non-breaking/thin spaces) so indices of the normalised and real text stay
// aligned; only when EXACTLY ONE location matches; an exact match is never touched.

const { parseJsonMaybeFenced } = require('../json-fence.js');

const TYPO_MAP = new Map([
  ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"],
  ['“', '"'], ['”', '"'], ['„', '"'], ['‟', '"'],
  ['–', '-'], ['—', '-'], ['−', '-'],
  [' ', ' '], [' ', ' '], [' ', ' '],
]);
const TYPO_CHARS = new Set(TYPO_MAP.keys());
const ESCAPE_RE = /\\u([0-9a-fA-F]{4})/g;
const CONTEXT_RADIUS = 6;

function normalizeTypographic(s) {
  let out = '';
  for (const ch of String(s)) out += TYPO_MAP.has(ch) ? TYPO_MAP.get(ch) : ch; // 1:1 by UTF-16 unit for every mapped char (all are BMP)
  return out;
}

// `“` written as literal text (backslash, u, four hex digits) -> the character, but ONLY for the typographic set: that is the
// over-escaping the model does, and decoding anything else could turn a real source-code escape into something it is not.
function decodeTypographicEscapes(s) {
  return String(s).replace(ESCAPE_RE, (m, hex) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return TYPO_CHARS.has(ch) ? ch : m;
  });
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0; let i = hay.indexOf(needle);
  while (i !== -1) { n += 1; i = hay.indexOf(needle, i + 1); }
  return n;
}

// -> { status: 'exact' } | { status: 'normalized', real, candidate } | { status: 'missing' } | { status: 'ambiguous' }
function resolveFind(content, find) {
  if (typeof content !== 'string' || typeof find !== 'string' || !find) return { status: 'missing' };
  if (content.includes(find)) return { status: 'exact' };
  const nContent = normalizeTypographic(content);
  const candidates = [find];
  const decoded = decodeTypographicEscapes(find);
  if (decoded !== find) candidates.unshift(decoded);
  let ambiguous = false;
  for (const candidate of candidates) {
    const nCand = normalizeTypographic(candidate);
    const count = countOccurrences(nContent, nCand);
    if (count === 1) {
      const at = nContent.indexOf(nCand);
      return { status: 'normalized', real: content.slice(at, at + nCand.length), candidate };
    }
    if (count > 1) ambiguous = true;
  }
  return { status: ambiguous ? 'ambiguous' : 'missing' };
}

// The model's replacement carries the same ASCII-ified (or over-escaped) fragments as its find. Give each typographic character the file
// really has back, matched by its surrounding context so an unrelated straight quote elsewhere in the replacement is left alone.
function retypographize(replace, candidate, real) {
  const out = [...decodeTypographicEscapes(replace)]; // every mapped char is one UTF-16 unit, so array index === string index
  const nOut = normalizeTypographic(out.join(''));    // normalisation is 1:1, so it never moves an index even as `out` is edited
  const nReal = normalizeTypographic(real);
  for (let i = 0; i < real.length; i += 1) {
    if (!TYPO_CHARS.has(real[i]) || candidate[i] === real[i]) continue; // not typographic, or the model already had it right
    // Two anchors, tried separately: the text just BEFORE the character and the text just AFTER it. Requiring both at once fails when the
    // replacement wraps the block differently on one side (a closing quote followed by a newline in the file but by `</Card>` in the replace).
    const anchors = [
      { start: Math.max(0, i - CONTEXT_RADIUS), end: i + 1 },
      { start: i, end: Math.min(nReal.length, i + 1 + CONTEXT_RADIUS) },
    ];
    for (const { start, end } of anchors) {
      const pattern = nReal.slice(start, end);
      if (pattern.length < 3) continue;
      for (let at = nOut.indexOf(pattern); at !== -1; at = nOut.indexOf(pattern, at + 1)) out[at + (i - start)] = real[i];
    }
  }
  return out.join('');
}

// implementResponse (Group B JSON: an edit object or an array of them) + fetched files -> { text, changed, fixes }.
// Never throws; anything it cannot parse or resolve is left exactly as it was.
function canonicalizeEdits(implementResponse, fetchedFiles) {
  const unchanged = { text: implementResponse, changed: false, fixes: [] };
  const trimmed = String(implementResponse || '').trim();
  if (!trimmed) return unchanged;
  let parsed;
  try { parsed = parseJsonMaybeFenced(trimmed); } catch { return unchanged; }
  if (!parsed || typeof parsed !== 'object') return unchanged;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const byPath = new Map((fetchedFiles || []).map((f) => [f.path, f.content]));
  const fixes = [];
  for (const item of items) {
    if (!item || item.mode !== 'edit' || typeof item.find !== 'string' || !item.find) continue;
    const content = byPath.get(item.file);
    if (typeof content !== 'string') continue;
    const r = resolveFind(content, item.find);
    if (r.status !== 'normalized') continue;
    fixes.push({ file: item.file, findChars: item.find.length, changedChars: [...r.real].filter((ch, i) => ch !== r.candidate[i]).length });
    if (typeof item.replace === 'string') item.replace = retypographize(item.replace, r.candidate, r.real);
    item.find = r.real;
  }
  if (!fixes.length) return unchanged;
  return { text: JSON.stringify(Array.isArray(parsed) ? items : items[0], null, 2), changed: true, fixes };
}

module.exports = { normalizeTypographic, decodeTypographicEscapes, resolveFind, retypographize, canonicalizeEdits };
