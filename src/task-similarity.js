'use strict';

// BM25 ranking module for task deduplication and similarity search.
// Each task becomes two token sets (title and rawText). Candidates are ranked
// against a query with BM25 over those sets, plus a distinctive-phrase bonus.

const { normalizeTokens, jaccardSimilarity, sharesDistinctivePhrase } = require('./text-similarity.js');

// Placeholder threshold for "this is a duplicate" -- higher than any real BM25 score a
// unique task would get, so a real duplicate (same topic, same scope) reliably clears it.
// Sibling task HUB0383 6/6 will replace this with the real F1-optimal threshold.
const DUPLICATE_SCORE = 8.0;

// Bonus added when the query shares a distinctive phrase with the candidate title.
const PHRASE_BONUS = 2.0;

// Standard BM25 parameters.
const K1 = 1.2;
const B = 0.75;

// Per-field term-frequency weights: a title hit counts three times a rawText hit.
const TITLE_WEIGHT = 3;
const RAW_WEIGHT = 1;

// Only the first N characters of promptContext.rawText are indexed.
const RAW_TEXT_CHARS = 1500;

// Build the two token sets for a task: title, and rawText (body plus Files: paths).
// The id is not part of either set; rankTasks tokenizes it separately for matchedOn.
function buildDoc(task) {
  const title = normalizeTokens(task.title || '');
  const bodyText = String((task.promptContext && task.promptContext.rawText) || '').slice(0, RAW_TEXT_CHARS);
  const filesText = extractFilesLine(bodyText) || extractFilesLine(task.title || '') || '';
  const rawText = normalizeTokens(`${bodyText} ${filesText}`);
  return { title, rawText };
}

// Extract the comma-separated paths from a "Files: ..." line in text, or null if absent.
function extractFilesLine(text) {
  const m = /^Files:\s*(.+)$/im.exec(String(text || ''));
  if (!m) return null;
  return m[1].trim();
}

// Rank candidates against a query using BM25 with a distinctive-phrase bonus.
// Returns [{id, score, matchedOn, state}] sorted descending by score.
//
// matchedOn precedence (design choice): 'id' > 'phrase' > 'title' > 'body'.
// A query token hitting the task id wins over everything, even when the id hit
// contributes less to the score than a title hit. Then a distinctive-phrase match
// wins over field attribution. Otherwise the field with the larger BM25 share
// (title over rawText, ties to 'body') is reported.
function rankTasks(query, candidates, { limit = 10 } = {}) {
  const queryTokens = normalizeTokens(query || '');
  if (queryTokens.size === 0 || !candidates || candidates.length === 0) return [];

  const docs = candidates.map((task) => ({
    task,
    doc: buildDoc(task),
    idTokens: normalizeTokens(task.id || ''),
  }));

  const N = docs.length;
  const docLength = ({ doc }) => doc.title.size + doc.rawText.size;
  const avgdl = docs.reduce((sum, d) => sum + docLength(d), 0) / N || 1;

  // IDF per query token over the candidate set.
  const idf = new Map();
  for (const token of queryTokens) {
    const n = docs.filter(({ doc, idTokens }) =>
      doc.title.has(token) || doc.rawText.has(token) || idTokens.has(token)).length;
    idf.set(token, Math.log((N - n + 0.5) / (n + 0.5) + 1));
  }

  const bm25 = (token, tf, dl) =>
    idf.get(token) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgdl))));

  const results = docs.map(({ task, doc, idTokens }) => {
    const dl = docLength({ doc });
    let titleScore = 0;
    let rawScore = 0;
    let idScore = 0;
    let idHit = false;

    for (const token of queryTokens) {
      if (doc.title.has(token)) titleScore += bm25(token, TITLE_WEIGHT, dl);
      if (doc.rawText.has(token)) rawScore += bm25(token, RAW_WEIGHT, dl);
      if (idTokens.has(token)) {
        idHit = true;
        idScore += bm25(token, 1, dl);
      }
    }

    let score = titleScore + rawScore + idScore;
    const phraseHit = Boolean(sharesDistinctivePhrase(query, task.title || ''));
    if (phraseHit) score += PHRASE_BONUS;

    let matchedOn;
    if (idHit) matchedOn = 'id';
    else if (phraseHit) matchedOn = 'phrase';
    else matchedOn = titleScore > rawScore ? 'title' : 'body';

    return {
      id: task.id,
      score: Math.round(score * 100) / 100,
      matchedOn,
      state: task.state || task.status || 'unknown',
    };
  });

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = { DUPLICATE_SCORE, buildDoc, rankTasks };
