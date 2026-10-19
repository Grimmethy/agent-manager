'use strict';

// Context compaction (HUB0155 · 1/3): a small, dependency-free pair of helpers for
// squeezing long text sections into a bounded preamble before it is appended to a
// conversation that is already nearly out of context room -- the intended caller
// is the forced-summary turn (HUB0155 · 2/3). The failure class this exists for
// is already root-caused at that call site: the forced-summary prompt is sent at
// the exact moment remaining room is tightest, so the payload it carries must be
// capped.
//
// The compaction shape is tail-keeping: a section that exceeds its cap keeps its
// HEAD (the part the section opens with -- instructions, framing, the request
// itself) and its TAIL (the most recent lines, which carry the freshest state),
// and the middle is cut and replaced by TRUNC_MARKER so a reader -- human or
// model -- can see the cut rather than reading two unrelated fragments as one.
//
// Pure functions, no I/O, no project-internal imports: this module must stay
// loadable (and load side-effect-free) anywhere, including in test sandboxes.

// The visible seam where a section's middle was cut. Deliberately short and
// unmistakable; tests and callers anchor on this exact string.
const TRUNC_MARKER = '[...truncated...]';

// Default per-section cap in characters: enough for a full task plan or a file
// window to survive uncut in most cases, small enough to fit a forced-summary
// prompt even with several sections.
const DEFAULT_SECTION_CAP = 2000;

// Default head kept when a section is cut: the opening of the section (its
// framing/lead-in) is worth keeping even though the tail is worth more.
const DEFAULT_KEEP = 200;

/**
 * Compact one text section to at most `cap` characters, keeping the head and the
 * tail and replacing the cut middle with TRUNC_MARKER.
 *
 * - null/undefined/other values are coerced to strings (null -> '').
 * - text.length <= cap (or cap <= 0 handled below) -> returned unchanged.
 * - cap <= 0 -> '' (a zero budget keeps nothing).
 * - cap smaller than TRUNC_MARKER -> the first `cap` characters (the marker
 *   itself would not fit).
 *
 * The result is ALWAYS exactly `cap` characters long when the input is longer
 * than the cap -- callers can plan their budget on the returned length.
 *
 * @param {string} [text]    the section text to compact.
 * @param {number} [cap]     maximum characters to return (default DEFAULT_SECTION_CAP).
 * @param {number} [keep]    characters of the HEAD to preserve before the marker
 *                           (default DEFAULT_KEEP; clamped to fit the cap).
 * @returns {string}
 */
function compactTailKeep(text, cap = DEFAULT_SECTION_CAP, keep = DEFAULT_KEEP) {
  const s = text == null ? '' : String(text);
  if (!Number.isFinite(cap) || cap <= 0) return '';
  if (s.length <= cap) return s;

  const markerLen = TRUNC_MARKER.length;
  if (cap <= markerLen) return s.slice(0, cap);

  const headLen = Math.max(0, Math.min(Number.isFinite(keep) && keep > 0 ? keep : 0, cap - markerLen));
  const tailLen = cap - headLen - markerLen;
  return s.slice(0, headLen) + TRUNC_MARKER + s.slice(s.length - tailLen);
}

/**
 * Assemble one capped block from several sections.
 *
 * Each section is either a raw string, or an object `{ label, text }` (label is
 * rendered as its own line above the section body). Every section body is passed
 * through compactTailKeep with the same cap/keep, empty sections are dropped,
 * and the survivors are joined with a blank line.
 *
 * Throws TypeError when `sections` is not an array -- a single mis-shaped call
 * site is worth a loud failure over a silently-wrong block.
 *
 * @param {Array<string|{label?: string, text: string}>} sections
 * @param {number} [cap]  per-section cap (default DEFAULT_SECTION_CAP).
 * @param {number} [keep] head kept per section (default DEFAULT_KEEP).
 * @returns {string}
 */
function assembleCappedBlock(sections, cap = DEFAULT_SECTION_CAP, keep = DEFAULT_KEEP) {
  if (!Array.isArray(sections)) {
    throw new TypeError('assembleCappedBlock: `sections` must be an array');
  }
  return sections
    .map((section) => {
      const label = section != null && typeof section === 'object' ? section.label : null;
      const text = section != null && typeof section === 'object' ? section.text : section;
      const body = compactTailKeep(text, cap, keep);
      if (!body) return '';
      return label ? `${label}\n${body}` : body;
    })
    .filter((part) => part !== '')
    .join('\n\n');
}

module.exports = { TRUNC_MARKER, DEFAULT_SECTION_CAP, compactTailKeep, assembleCappedBlock };
