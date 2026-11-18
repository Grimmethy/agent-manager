'use strict';

// Read-only prior-art lookup for adhoc planning. Given free text or a diff, extract a few
// search terms, grep the repo roots for them as fixed strings, and render each hit with the
// nearest preceding comment block. Non-test hits come first, tagged [handled]; test hits come
// second, tagged [pinning] because they pin current behaviour. Kill-switch:
// AGENT_MANAGER_ADHOC_PRIOR_ART=false disables both builders, which then return '' without
// spawning any process. Roots are absolute directories; each is searched with cwd = root.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_TERMS = 6;
// Default cap on rendered hits when opts.max is not given. Kept small so the block stays short.
const DEFAULT_MAX_HITS = 5;
const MAX_COMMENT_LINES = 6;
const SEARCH_TIMEOUT_MS = 10_000;
const SEARCH_MAX_BUFFER = 4 * 1024 * 1024;
const NONE_BLOCK = 'PRIOR ART: none found';
const HEADER = 'PRIOR ART:';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'should', 'must', 'when',
  'then', 'not', 'are', 'was', 'were', 'have', 'has', 'will', 'make', 'add', 'use', 'set',
  'get', 'but', 'its', 'also', 'each', 'any', 'all', 'one', 'may', 'can', 'change', 'update',
  'fix', 'task', 'plan',
]);

const QUOTED_RE = /"([^"\n]{3,})"|'([^'\n]{3,})'/g;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const HIT_RE = /^(?:\.\/)?(.+?):(\d+):/;
const COMMENT_RE = /^\s*(\/\/|#|\/\*|\*|\*\/)/;

// Exact-'false' kill-switch, same convention as adhoc-staleness-flag.js.
function isPriorArtEnabled() {
  return process.env.AGENT_MANAGER_ADHOC_PRIOR_ART !== 'false';
}

// Quoted phrases first (in order), then identifiers from the remaining text.
// Deduplicated, stop-words dropped, capped at MAX_TERMS.
function extractTerms(text) {
  const s = String(text || '');
  const terms = [];
  const seen = new Set();
  const add = (t) => {
    if (!t || seen.has(t) || terms.length >= MAX_TERMS) return;
    seen.add(t);
    terms.push(t);
  };
  for (const m of s.matchAll(QUOTED_RE)) {
    const phrase = (m[1] || m[2] || '').trim();
    if (phrase) add(phrase);
  }
  const rest = s.replace(QUOTED_RE, ' ');
  for (const m of rest.matchAll(IDENT_RE)) {
    if (!STOP_WORDS.has(m[0].toLowerCase())) add(m[0]);
  }
  return terms;
}

// Promise wrapper around execFile. No shell is involved: file and args are passed as an array.
function execFileAsync(file, args, cwd) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: SEARCH_TIMEOUT_MS, maxBuffer: SEARCH_MAX_BUFFER, encoding: 'utf8' },
      (err, stdout) => resolve({ err, stdout: String(stdout || '') }),
    );
  });
}

function parseGrepOutput(stdout) {
  const hits = [];
  for (const line of stdout.split('\n')) {
    const m = HIT_RE.exec(line);
    if (m) hits.push({ rel: m[1], line: Number(m[2]) });
  }
  return hits;
}

// Returns [{ rel, line }] for one term under one root.
// Tries `git grep --no-index` first (working-tree files, tracked or not). Falls back to
// `grep -rnF` when git is missing or the root is not a repo. Exit 1 means no match, not an error.
async function searchRoot(term, root) {
  const git = await execFileAsync(
    'git',
    ['grep', '--no-index', '-n', '-F', '-e', term, '--', '.'],
    root,
  );
  if (!git.err) return parseGrepOutput(git.stdout);
  if (git.err.code === 1 || git.err.killed) return [];
  const grep = await execFileAsync('grep', ['-rnF', '-e', term, '.'], root);
  if (!grep.err) return parseGrepOutput(grep.stdout);
  return [];
}

function isTestFile(rel) {
  const base = path.posix.basename(rel);
  return /\.test\.js$/.test(base) || /^test_.*\.py$/.test(base) || /_test\.py$/.test(base);
}

async function collectHits(terms, roots) {
  const byKey = new Map();
  for (const term of terms) {
    for (const root of roots) {
      for (const h of await searchRoot(term, root)) {
        const abs = path.join(root, h.rel);
        const key = `${abs}:${h.line}`;
        if (!byKey.has(key)) {
          byKey.set(key, { rel: h.rel, abs, line: h.line, test: isTestFile(h.rel) });
        }
      }
    }
  }
  return [...byKey.values()];
}

function readLines(cache, abs) {
  if (!cache.has(abs)) {
    let text = '';
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      text = '';
    }
    cache.set(abs, text.split('\n'));
  }
  return cache.get(abs);
}

// Contiguous comment lines directly above the hit (1-indexed lineNo). Stops at the first
// non-comment line. Keeps the nearest MAX_COMMENT_LINES lines.
function commentBefore(lines, lineNo) {
  const out = [];
  for (let i = lineNo - 2; i >= 0 && out.length < MAX_COMMENT_LINES; i--) {
    if (!COMMENT_RE.test(lines[i])) break;
    out.unshift(lines[i].trim());
  }
  return out;
}

function renderHit(hit, cache) {
  const tag = hit.test ? '[pinning]' : '[handled]';
  const out = [`- ${hit.rel}:${hit.line} ${tag}`];
  for (const c of commentBefore(readLines(cache, hit.abs), hit.line)) {
    out.push(`    > ${c}`);
  }
  return out.join('\n');
}

// Returns '' when disabled, NONE_BLOCK when nothing matches, otherwise a HEADER block.
async function buildPriorArtBlock(text, roots = [], { max = DEFAULT_MAX_HITS } = {}) {
  if (!isPriorArtEnabled()) return '';
  const terms = extractTerms(text);
  const hits = terms.length ? await collectHits(terms, roots) : [];
  // Stable sort: non-test (handled) hits first, test (pinning) hits second.
  hits.sort((a, b) => Number(a.test) - Number(b.test));
  const shown = hits.slice(0, Math.max(0, max));
  if (!shown.length) return NONE_BLOCK;
  const cache = new Map();
  return [HEADER, ...shown.map((h) => renderHit(h, cache))].join('\n');
}

// Terms come from the added ('+') lines of a unified diff, excluding the '+++' file header.
// Removed and context lines are ignored.
async function buildPriorArtForDiff(diff, roots = [], opts = {}) {
  if (!isPriorArtEnabled()) return '';
  const added = String(diff || '')
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
  return buildPriorArtBlock(added, roots, opts);
}

module.exports = {
  isPriorArtEnabled,
  extractTerms,
  buildPriorArtBlock,
  buildPriorArtForDiff,
  NONE_BLOCK,
};
