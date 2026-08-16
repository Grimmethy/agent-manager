'use strict';

// Anchor-resolution + file-path prefetch for adhoc brain-dump tasks
// (context-aware-file-path-prefetch-job.md -- design settled across a Grill Me +
// Discuss session on 2026-08-16). Runs once, right when applyBrainDumpSort queues a real
// adhoc task for a matched project -- BEFORE ornith-worker.sh ever claims and drafts it
// -- so the plan/implement passes already have real, validated file paths in context
// instead of the model searching (or worse, inventing) them from scratch on every call.
//
// Deliberately keyword/graph-matching only, no LLM call: this only ever runs against a
// small, cheap, deterministic signal (the project's own dependency graph, if one
// exists) -- spending a real model round-trip just to find candidate files would be the
// exact "expensive search" this feature exists to avoid in the first place.

const fs = require('fs');
const path = require('path');

// Deliberately short and generic -- filtering candidate keywords down to
// identifier-shaped tokens (see extractKeywords) already does most of the real
// discriminating work; this only needs to catch common English filler that would
// otherwise "match" some innocuous file by pure substring coincidence (e.g. bare "add"
// matching every file with "add" somewhere in its path).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'is', 'it',
  'this', 'that', 'we', 'need', 'needs', 'should', 'with', 'from', 'into', 'when', 'add',
  'fix', 'update', 'make', 'sure', 'file', 'files', 'code', 'task', 'tasks',
]);

// Pulls candidate anchor keywords out of a task's title/text. Identifier-shaped tokens
// (snake_case, kebab-case, camelCase, or a path/dotted segment) are ranked first --
// they're far more likely to be real file/symbol names than ordinary prose -- but a
// plain distinctive word is still a candidate (a real file can share a name with an
// ordinary word, e.g. "config"). Not a full NLP pass -- this is meant to stay cheap and
// deterministic, same reasoning as the module header.
function extractKeywords(text) {
  if (!text) return [];
  const tokens = text.match(/[A-Za-z0-9_.\/-]{3,}/g) || [];
  const seen = new Set();
  const keywords = [];
  for (const raw of tokens) {
    const token = raw.replace(/^[.\-_/]+|[.\-_/]+$/g, '');
    if (token.length < 3) continue;
    const lower = token.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    const looksLikeIdentifier = /[_\-./]/.test(token) || /[A-Z]/.test(token.slice(1));
    keywords.push({ token, lower, looksLikeIdentifier });
  }
  keywords.sort((a, b) => Number(b.looksLikeIdentifier) - Number(a.looksLikeIdentifier));
  return keywords;
}

function loadGraph(graphPath) {
  let text;
  try {
    text = fs.readFileSync(graphPath, 'utf8');
  } catch {
    return null; // no graph on disk at all -- caller treats this as greenfield, not an error
  }
  try {
    const graph = JSON.parse(text);
    if (!graph || !Array.isArray(graph.nodes)) return null;
    return graph;
  } catch {
    return null;
  }
}

// Matches one keyword against every source_file in the graph -- basename-stem match
// (case- and separator-insensitive: "path_prefetch" === "path-prefetch") first, since an
// exact filename hit is unambiguous; falls back to a substring match against the full
// relative path (catches a keyword naming a directory or a partial path) only when
// there's no exact-stem hit at all.
function matchKeyword(keyword, sourceFiles) {
  const normalize = (s) => s.toLowerCase().replace(/[_-]/g, '');
  const stemHits = sourceFiles.filter((f) => normalize(path.basename(f, path.extname(f))) === normalize(keyword.lower));
  if (stemHits.length > 0) return stemHits;

  return sourceFiles.filter((f) => f.toLowerCase().includes(keyword.lower));
}

// Cap on how many prefetched paths ever get injected into one task -- this is meant to
// save a search, not replace the whole codebase's worth of context; an unbounded list
// defeats the entire point (the same context-bloat problem this feature exists to fix).
const MAX_PREFETCHED_PATHS = 12;

// Resolves anchor keywords from a task's title/rawText against repoRoot's project graph
// (graphify-out/graph.json by default, same file arch_discovery already reads -- see
// config.js). Returns exactly one of:
//   { status: 'greenfield' }                                -- no graph exists yet for this
//                                                                project; NOT an error, see
//                                                                the Discuss session note.
//   { status: 'no-match' }                                  -- a graph exists but nothing in
//                                                                the task text matched any
//                                                                file in it (or the only
//                                                                matches were stale).
//   { status: 'ambiguous', candidates: {keyword: [f, ...]} } -- one or more keywords each
//                                                                matched multiple files;
//                                                                paths carries whatever
//                                                                UNAMBIGUOUS matches were
//                                                                also found, if any.
//   { status: 'matched', paths: [...] }                      -- every matched keyword
//                                                                resolved to exactly one
//                                                                real, on-disk file.
function resolveAnchors({ repoRoot, title, rawText, graphPathOverride }) {
  const graphPath = graphPathOverride || path.join(repoRoot, 'graphify-out', 'graph.json');
  const graph = loadGraph(graphPath);
  if (!graph) return { status: 'greenfield' };

  const sourceFiles = [...new Set(graph.nodes.map((n) => n.source_file).filter(Boolean))];
  if (sourceFiles.length === 0) return { status: 'greenfield' };

  const keywords = extractKeywords(`${title || ''} ${rawText || ''}`);
  if (keywords.length === 0) return { status: 'no-match' };

  const matchedPaths = new Set();
  const ambiguous = {};
  let anyMatch = false;

  for (const keyword of keywords) {
    const hits = matchKeyword(keyword, sourceFiles);
    if (hits.length === 0) continue;
    anyMatch = true;
    if (hits.length === 1) {
      matchedPaths.add(hits[0]);
    } else {
      ambiguous[keyword.token] = hits;
    }
  }

  if (!anyMatch) return { status: 'no-match' };

  // Validate every unambiguously-matched path still exists on disk -- the graph can be
  // stale (files renamed/deleted since it was last built) even when the keyword match
  // itself is sound; a prefetched path that 404s the moment someone opens it is worse
  // than no prefetch at all (see the Grill Me session's own "stale references" point).
  const validPaths = [...matchedPaths].filter((p) => {
    try {
      return fs.statSync(path.join(repoRoot, p)).isFile();
    } catch {
      return false;
    }
  });

  if (Object.keys(ambiguous).length > 0) {
    return { status: 'ambiguous', candidates: ambiguous, paths: validPaths };
  }
  if (validPaths.length === 0) return { status: 'no-match' };

  return { status: 'matched', paths: validPaths.slice(0, MAX_PREFETCHED_PATHS) };
}

module.exports = { extractKeywords, resolveAnchors, MAX_PREFETCHED_PATHS };
