'use strict';

// staleness-audit-dedup.js -- extracted from src/staleness-audit.js ([[hub-task-integration]] node-module decompose).

const { normalizeTokens, jaccardSimilarity: jaccard, STOPWORDS: DUP_STOPWORDS, distinctivePhrases: sharedDistinctivePhrases } = require('./text-similarity.js');
// Reuse the path-extraction helper staleness-audit's own named-file checks use
// (candidateFilePaths -> fact-checker.js's extractFilePaths) rather than a second,
// possibly-inconsistent regex.
const { candidateFilePaths } = require('./staleness-audit-signals.js');
// Reuse the existing hub-membership resolver: parentHub (stamped by apply-task.js)
// wins, promptContext.decomposedFrom (written by every decompose producer) as fallback.
const { hubIdForTask } = require('./hub-priority.js');

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

// Two tasks related as hub and child in EITHER direction -- the child record's resolved
// hub id (parentHub or promptContext.decomposedFrom, via hubIdForTask) is the other
// record's id, or the hub's subTasks list contains the child's id. subTasks may carry
// the full record id or a shorter hub-token, so compare exact-match or '-'-bounded
// prefix in either direction. A hub and its own child legitimately share almost all
// their text (the child IS the decomposed restatement of the hub) -- that is
// coordination, not duplication, and must never be flagged as 'duplicate-of (retire)':
// retiring one of the pair would drop the only live record of work that is not done.
function relatedAsHubAndChild(a, b) {
  if (!a || !b) return false;
  const hubA = hubIdForTask(a);
  const hubB = hubIdForTask(b);
  if (hubA && String(b.id) && hubA === b.id) return true;
  if (hubB && String(a.id) && hubB === a.id) return true;
  const subTaskMatches = (entry, otherId) => {
    const e = String(entry || '').trim();
    if (!e) return false;
    return e === otherId || otherId.startsWith(e + '-') || e.startsWith(otherId + '-');
  };
  if (Array.isArray(a.subTasks) && a.subTasks.some((s) => subTaskMatches(s, b.id))) return true;
  if (Array.isArray(b.subTasks) && b.subTasks.some((s) => subTaskMatches(s, a.id))) return true;
  return false;
}

// Both tasks name at least one real source file, and the two named sets share NONE:
// the token overlap is shared boilerplate (a decompose hub's "Decompose
// <path> (N module(s))" title and prompt scaffolding), not shared subject matter --
// two hubs that split DIFFERENT files are different work. Only fires when BOTH sides
// name >= 1 file: a task that names no file at all is never dropped by this guard and
// still goes through the normal Jaccard/threshold decision, so a real twin whose
// rewording happens to name fewer (or zero) paths can't be silently skipped here.
function namesDisjointFiles(a, b) {
  let fa = [];
  let fb = [];
  try { fa = candidateFilePaths(a) || []; } catch { fa = []; }
  try { fb = candidateFilePaths(b) || []; } catch { fb = []; }
  if (fa.length === 0 || fb.length === 0) return false;
  const setA = new Set(fa);
  return !fb.some((p) => setA.has(p));
}

// `opts.relationCheck` / `opts.fileDisjointCheck` are test-only switches (default on):
// a mutation test flips them off to prove the new guards are what suppress the pair.
function findDuplicateTask(task, corpus, { relationCheck = true, fileDisjointCheck = true } = {}) {
  const mine = normalizeTaskTokens(task);
  if (mine.size < 4) return null;
  const myLineage = bdLineage(task.id);
  const threshold = dupSimilarityThreshold();
  let best = null;
  for (const other of corpus || []) {
    if (!other || !other.id || other.id === task.id) continue;
    if (/(^|-)(brain-dump-sort|product-spec-outline)-/.test(other.id)) continue;
    if (myLineage && bdLineage(other.id) === myLineage) continue; // same lineage, not a dup
    if (relationCheck && relatedAsHubAndChild(task, other)) continue; // hub/child, not a dup
    if (fileDisjointCheck && namesDisjointFiles(task, other)) continue; // different files, boilerplate overlap
    const sim = jaccard(mine, normalizeTaskTokens(other));
    if (sim >= threshold && (!best || sim > best.sim)) {
      best = { id: other.id, state: other.state || other.status || null, sim: Number(sim.toFixed(2)) };
    }
  }
  return best;
}

module.exports = { normalizeTaskTokens, dupSimilarityThreshold, bdLineage, findDuplicateTask, relatedAsHubAndChild, namesDisjointFiles };
