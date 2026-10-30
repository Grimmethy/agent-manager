'use strict';

// BM25 ranking module for task deduplication and similarity search.
// Builds document representations from task objects and ranks candidates against a query
// using BM25 with a distinctive-phrase bonus for near-duplicate detection.

const { normalizeTokens, sharesDistinctivePhrase } = require('./text-similarity.js');

// Placeholder threshold for "this is a duplicate" -- higher than any real BM25 score a
// unique task would get, so a real duplicate (same topic, same scope) reliably clears it.
// Sibling task HUB0262-2/3 will replace this with the real computed threshold.
const DUPLICATE_SCORE = 8.0;

// Build a BM25 document from a task object. Tokenizes title (weight 3), id slug (weight 1),
// first 1500 chars of promptContext.rawText (weight 1), and Files: line paths (weight 1).
// Returns {tokens: Map<string, number>, fieldScores: {title, id, body, files}} where
// fieldScores holds the raw token count per field (used as document length for BM25).
function buildDoc(task) {
  const tokens = new Map();
  const fieldScores = { title: 0, id: 0, body: 0, files: 0 };

  // Title (weight 3)
  const titleTokens = normalizeTokens(task.title || '');
  for (const token of titleTokens) {
    tokens.set(token, (tokens.get(token) || 0) + 3);
  }
  fieldScores.title = titleTokens.size;

  // ID slug (weight 1)
  const idTokens = normalizeTokens(task.id || '');
  for (const token of idTokens) {
    tokens.set(token, (tokens.get(token) || 0) + 1);
  }
  fieldScores.id = idTokens.size;

  // Body: first 1500 chars of promptContext.rawText (weight 1)
  const bodyText = String((task.promptContext && task.promptContext.rawText) || '').slice(0, 1500);
  const bodyTokens = normalizeTokens(bodyText);
  for (const token of bodyTokens) {
    tokens.set(token, (tokens.get(token) || 0) + 1);
  }
  fieldScores.body = bodyTokens.size;

  // Files: paths from a "Files:" line in the prompt text (weight 1)
  const filesText = extractFilesLine(bodyText) || extractFilesLine(task.title || '');
  const fileTokens = normalizeTokens(filesText || '');
  for (const token of fileTokens) {
    tokens.set(token, (tokens.get(token) || 0) + 1);
  }
  fieldScores.files = fileTokens.size;

  return { tokens, fieldScores };
}

// Extract the comma-separated paths from a "Files: ..." line in text, or null if absent.
function extractFilesLine(text) {
  const m = /^Files:\s*(.+)$/im.exec(String(text || ''));
  if (!m) return null;
  return m[1].trim();
}

// Rank candidates against a query using BM25 with a distinctive-phrase bonus.
// Returns [{id, score, matchedOn, state}] sorted descending by score.
// matchedOn is 'title', 'body', 'id', or 'phrase' (which field contributed most, or phrase if bonus applied).
function rankTasks(query, candidates, { limit = 10 } = {}) {
  const queryTokens = normalizeTokens(query);
  if (queryTokens.size === 0 || !candidates || candidates.length === 0) return [];

  // Build docs for all candidates
  const docs = candidates.map((task) => ({
    task,
    doc: buildDoc(task),
  }));

  const N = docs.length;
  const avgdl = docs.reduce(
    (sum, { doc }) =>
      sum + doc.fieldScores.title + doc.fieldScores.id + doc.fieldScores.body + doc.fieldScores.files,
    0,
  ) / N;

  // Compute IDF for each query token (over the candidate set)
  const idf = new Map();
  for (const token of queryTokens) {
    const n = docs.filter(({ doc }) => doc.tokens.has(token)).length;
    idf.set(token, Math.log((N - n + 0.5) / (n + 0.5) + 1));
  }

  // Compute BM25 scores for each candidate
  const results = docs.map(({ task, doc }) => {
    let score = 0;
    let matchedOn = 'body'; // default
    let matchedScore = 0;

    // Check each field separately to determine matchedOn
    const fields = [
      { name: 'title', tokens: [...normalizeTokens(task.title || '')], dl: doc.fieldScores.title },
      { name: 'body', tokens: [...normalizeTokens(String((task.promptContext && task.promptContext.rawText) || '').slice(0, 1500))], dl: doc.fieldScores.body },
      { name: 'id', tokens: [...normalizeTokens(task.id || '')], dl: doc.fieldScores.id },
    ];

    for (const { name, tokens: fieldTokens, dl } of fields) {
      let fieldScore = 0;
      for (const token of queryTokens) {
        const tf = fieldTokens.filter((t) => t === token).length;
        if (tf > 0) {
          const bm25Term =
            (idf.get(token) * (tf * (1.2 + 1))) /
            (tf + 1.2 * (1 - 0.75 + 0.75 * (dl / avgdl)));
          fieldScore += bm25Term;
        }
      }
      if (fieldScore > matchedScore) {
        matchedScore = fieldScore;
        matchedOn = name;
      }
      score += fieldScore;
    }

    // Check phrase bonus: +2.0 if sharesDistinctivePhrase(query, title) is true
    if (sharesDistinctivePhrase(query, task.title)) {
      score += 2.0;
      matchedOn = 'phrase';
    }

    return {
      id: task.id,
      score: Math.round(score * 100) / 100,
      matchedOn,
      state: task.status || 'unknown',
    };
  });

  // Sort descending by score and limit
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = { DUPLICATE_SCORE, buildDoc, rankTasks };
