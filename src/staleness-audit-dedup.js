'use strict';

// staleness-audit-dedup.js -- extracted from src/staleness-audit.js ([[hub-task-integration]] node-module decompose).

const { normalizeTokens, jaccardSimilarity: jaccard, STOPWORDS: DUP_STOPWORDS, distinctivePhrases: sharedDistinctivePhrases } = require('./text-similarity.js');

function normalizeTaskTokens(task) {
  const ctx = task.promptContext || {};
  return normalizeTokens(`${task.title || ''} ${(ctx.rawText || '').slice(0, 600)}`);
}

function dupSimilarityThreshold() {
  const raw = Number(process.env.AGENT_MANAGER_STALENESS_DUP_SIMILARITY);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.6;
}

function bdLineage(id) {
  const m = String(id || '').match(/bd-(\d{10,})/);
  return m ? m[1] : null;
}

function findDuplicateTask(task, corpus) {
  const mine = normalizeTaskTokens(task);
  if (mine.size < 4) return null;
  const myLineage = bdLineage(task.id);
  const threshold = dupSimilarityThreshold();
  let best = null;
  for (const other of corpus || []) {
    if (!other || !other.id || other.id === task.id) continue;
    if (/(^|-)(brain-dump-sort|product-spec-outline)-/.test(other.id)) continue;
    if (myLineage && bdLineage(other.id) === myLineage) continue; // same lineage, not a dup
    const sim = jaccard(mine, normalizeTaskTokens(other));
    if (sim >= threshold && (!best || sim > best.sim)) {
      best = { id: other.id, state: other.state || other.status || null, sim: Number(sim.toFixed(2)) };
    }
  }
  return best;
}

module.exports = { normalizeTaskTokens, dupSimilarityThreshold, bdLineage, findDuplicateTask };
