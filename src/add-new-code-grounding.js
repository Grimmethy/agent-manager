'use strict';

const fs = require('fs');
const { quotedSymbolsFromSection } = require('./sdk/lib/candidate-doc-parsing');

const ADD_SHAPE_RE = /^\s*(Add|Create|Introduce)\b/i;

function firstNonEmptyLine(text) {
  for (const line of String(text || '').split('\n')) {
    if (line.trim()) return line;
  }
  return '';
}

/**
 * Decide whether a candidate that adds NEW code is exempt from the modify-grounding check.
 *
 * @param {object} args
 * @param {string} args.section      Candidate section text; backtick symbols are extracted from it.
 * @param {string} args.title        Candidate title.
 * @param {string} args.problem      Candidate Problem text (first non-empty line is tested).
 * @param {string} args.filePath     The `Files:` path, exactly as given (checked with fs.existsSync).
 * @param {() => Iterable<string>} args.readTreeSources
 *   Function returning an iterable of source-file strings for the whole tree. Called lazily,
 *   only after at least one symbol was found. Each item must be a string.
 * @returns {{exempt: boolean, why: string, symbols: string[]}}
 */
function decideAddNewCodeExemption({ section, title, problem, filePath, readTreeSources }) {
  const symbols = quotedSymbolsFromSection(section);
  if (symbols.length === 0) return { exempt: false, why: 'no-symbols', symbols };

  // Materialize once so multi-symbol checks do not exhaust a one-shot iterable.
  const sources = typeof readTreeSources === 'function' ? Array.from(readTreeSources()) : [];
  for (const symbol of symbols) {
    for (const src of sources) {
      if (typeof src === 'string' && src.includes(symbol)) {
        return { exempt: false, why: `symbol-present-in-tree:${symbol}`, symbols };
      }
    }
  }

  if (!fs.existsSync(filePath)) return { exempt: false, why: 'file-missing', symbols };

  if (!ADD_SHAPE_RE.test(title || '') && !ADD_SHAPE_RE.test(firstNonEmptyLine(problem))) {
    return { exempt: false, why: 'not-add-shaped', symbols };
  }

  // 'add-new-code-exempt' is a naming choice made here; the spec does not fix this string.
  return { exempt: true, why: 'add-new-code-exempt', symbols };
}

module.exports = { decideAddNewCodeExemption };
