'use strict';

// Files-hint premise check (2026-10-02, HUB0122). Deterministic guard for brain-dump
// entries whose "Files hint" names files that have nothing to do with the entry's own
// description: the premise (these files are where the work happens) survived 9 drafting
// attempts unnoticed because nothing ever checked the hint against the files' actual
// content. Same deterministic-first, never-throw discipline as candidate-premise-check.js.
//
// Contract (confirmed against real code before implementing):
//   - ctx.resolveAccessibleRoots() is src/accessible-roots.js's resolveAccessibleRoots,
//     which is SYNCHRONOUS and returns string[] of absolute, realpath-deduped, existing
//     directory roots (roots[0] the primary repo). So this module is fully synchronous.
//   - "filesHint" appears NOWHERE else in the repo today (grep over all dirs returns zero
//     hits, as do "targetFiles" and "entry.files"). This field is new -- the sibling
//     tasks in HUB0122 define/parse it. We therefore read entry.filesHint first and fall
//     back to entry.files / entry.targetFiles so the check works under any of the three
//     candidate names the hub's decomposition used.

const fs = require('fs');
const path = require('path');

// Common English + domain filler words: distinctive enough in length to survive the
// >=6-char token filter on their own, but carrying zero topical signal for a grep.
const STOP_WORDS = new Set([
  'because', 'between', 'without', 'another', 'instead', 'nothing', 'something', 'anything',
  'everything', 'example', 'examples', 'instance', 'instances', 'default', 'defaults',
  'function', 'functions', 'parameter', 'parameters', 'property', 'properties', 'method',
  'methods', 'object', 'objects', 'value', 'values', 'string', 'strings', 'number',
  'numbers', 'boolean', 'array', 'arrays', 'state', 'states', 'context', 'contexts',
  'message', 'messages', 'request', 'requests', 'response', 'responses', 'content',
  'contents', 'handler', 'handlers', 'callback', 'callbacks', 'reference', 'references',
  'available', 'unavailable', 'necessary', 'unnecessary', 'different', 'differences',
  'following', 'previous', 'current', 'currently', 'general', 'generally', 'related',
  'relevant', 'specific', 'specifically', 'particular', 'particularl', 'possible',
  'possibly', 'certain', 'certainly', 'certainly', 'typically', 'usually', 'commonly',
  'especially', 'particularly', 'additionally', 'furthermore', 'meanwhile', 'otherwise',
  'themselves', 'itself', 'itself', 'yourselves', 'somebody', 'everybody', 'nobody',
  'everyone', 'someone', 'returning', 'returned', 'returns', 'return', 'handling',
  'handling', 'process', 'processing', 'processed', 'handled', 'handling', 'support',
  'supported', 'supporting', 'available', 'ensuring', 'guarantee', 'guarantees',
]);

const MAX_FILES_SCANNED = 2000; // walk safety cap so a huge plugin checkout cannot hang the tick

// -> entry.filesHint, falling back to entry.files / entry.targetFiles (see header).
// Accepts an array of path strings, or a single string (a sloppy producer).
function resolveHintFiles(entry) {
  const raw =
    (entry && (entry.filesHint ?? entry.files ?? entry.targetFiles)) ?? [];
  if (typeof raw === 'string') return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => (typeof f === 'string' ? f.trim() : null)).filter(Boolean);
}

// Distinctive keywords from the description: >=6 chars, non-stop-word, deduped, capped.
function extractDistinctiveKeywords(description) {
  const text = String(description || '');
  if (!text.trim()) return [];
  const seen = new Set();
  const out = [];
  for (const tok of text.toLowerCase().match(/[a-z0-9_][a-z0-9_]{5,}/g) || []) {
    if (STOP_WORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= 8) break; // plenty of signal; more keywords only multiply grep cost
  }
  return out;
}

// Synchronous resolveAccessibleRoots contract -> string[]; be forgiving about shape.
function getRoots(ctx) {
  if (ctx && typeof ctx.resolveAccessibleRoots === 'function') {
    try {
      const res = ctx.resolveAccessibleRoots();
      if (Array.isArray(res)) return res.filter((r) => typeof r === 'string' && r);
      if (typeof res === 'string') return [res];
    } catch { /* fail-open: no roots, skip the walk */ }
  }
  return [];
}

// Try reading a (possibly relative) hint path from each root, then from cwd.
function readHintFile(relPath, roots) {
  const candidates = [];
  if (path.isAbsolute(relPath)) {
    candidates.push(relPath);
  } else {
    for (const r of roots) candidates.push(path.join(r, relPath));
    candidates.push(path.resolve(process.cwd(), relPath));
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return { file: c, content: fs.readFileSync(c, 'utf8') };
    } catch { /* unreadable here -- try the next candidate */ }
  }
  return null;
}

function findKeywordIn(content, keywords) {
  const lower = String(content || '').toLowerCase();
  const hit = keywords.find((kw) => lower.includes(kw));
  return hit || null;
}

// Depth-limited walk: root = depth 0, a file counts as its RELATIVE path-segment count
// from the root (src/foo.js = depth 2). Descend only while depth < maxDepth (3), skip
// node_modules / dist / build / .git, read only .js/.ts. Per-file failures never abort.
function walkForKeyword(roots, keywords, maxDepth = 3) {
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);
  const hits = [];
  let scanned = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || scanned >= MAX_FILES_SCANNED) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir -- skip
    }
    for (const e of entries) {
      if (scanned >= MAX_FILES_SCANNED) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile() && /\.(js|ts)$/.test(e.name)) {
        scanned++;
        let content;
        try {
          content = fs.readFileSync(full, 'utf8');
        } catch {
          continue; // unreadable file -- skip
        }
        const kw = findKeywordIn(content, keywords);
        if (kw) hits.push({ file: full, keyword: kw });
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return hits;
}

// checkFilesHintPremise(entry, ctx) -> {verdict: 'ok'|'wrong-file'|'not-found', suggestedFiles?, evidence?}
//   ok          -- a distinctive keyword from entry.description IS present in a named hint file.
//   wrong-file  -- the named hint files exist but contain no keyword, yet one WAS found in
//                  another .js/.ts under the accessible roots (suggestedFiles = where).
//   not-found   -- keyword found in neither the named files nor anywhere in the walked roots
//                  (or there was nothing checkable at all). evidence = what was searched.
// Never throws. Synchronous (resolveAccessibleRoots is synchronous).
function checkFilesHintPremise(entry, ctx) {
  if (!entry || typeof entry !== 'object') {
    return { verdict: 'not-found', evidence: 'no entry provided' };
  }
  const keywords = extractDistinctiveKeywords(entry.description);
  if (!keywords.length) {
    return {
      verdict: 'not-found',
      evidence: entry.description
        ? 'no distinctive keywords extracted from description'
        : 'no description or no files hint present',
    };
  }

  const roots = getRoots(ctx);
  const hintFiles = resolveHintFiles(entry);

  // 1) Grep the named hint files for any keyword.
  const searchedFiles = [];
  for (const rel of hintFiles) {
    const hit = readHintFile(rel, roots);
    searchedFiles.push(rel);
    if (hit) {
      const kw = findKeywordIn(hit.content, keywords);
      if (kw) {
        return { verdict: 'ok', evidence: { file: hit.file, keyword: kw } };
      }
    }
  }

  if (!hintFiles.length) {
    return {
      verdict: 'not-found',
      evidence: { keywords, searchedFiles: [], note: 'no files hint present; nothing to verify' },
    };
  }

  // 2) Fallback: walk accessible roots for the same keywords.
  if (!roots.length) {
    return {
      verdict: 'not-found',
      evidence: {
        keywords,
        searchedFiles,
        note: 'named files contained no keyword; fallback walk unavailable (no accessible roots)',
      },
    };
  }

  const hits = walkForKeyword(roots, keywords);
  if (hits.length) {
    return {
      verdict: 'wrong-file',
      suggestedFiles: [...new Set(hits.map((h) => h.file))],
      evidence: hits.slice(0, 5).map((h) => ({ file: h.file, keyword: h.keyword })),
    };
  }

  return {
    verdict: 'not-found',
    evidence: { keywords, searchedFiles, note: 'no keyword found in named files or anywhere under the walked roots' },
  };
}

module.exports = { checkFilesHintPremise, extractDistinctiveKeywords, resolveHintFiles };
