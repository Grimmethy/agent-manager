'use strict';

// Deterministic hit-count gate for the review stage (2026-09-13, pipeline-debrief
// "Task 2 / Flag 2"): when an acceptance criterion asserts a SPECIFIC grep hit count
// (e.g. "`grep -n foo src/foo.js` returns exactly 3 hits" or "grep -n foo src/foo.js
// returns 3 hits"), that number is mechanically determinable -- `grep -c <symbol>
// <file>` -- yet the model reviewer kept burning real review calls re-discovering the
// same systematic mismatch (the draft repeats the symbol in comment AND code, so the
// count is 2 where the criterion says 3; Task 2 lost two blocked reviews that way).
// review-task.js calls checkHitCountGate() BEFORE its model-reviewer dispatch: on a
// mismatch it returns a `blocked` verdict and the draft never reaches a model call.
// Nothing here calls a model.
//
// Heuristic by design (same narrow-shape discipline as detectContradictoryLiteral
// Acceptance in acceptance-criteria.js): only the two documented criterion shapes are
// recognized, and a criterion that asserts a count but names no target file is SKIPPED
// (we cannot run the check) rather than guessed at -- an unresolvable file is far
// less dangerous than a false block.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 10_000;

function realGrepC(symbol, file, opts) {
  return execFileSync('grep', ['-c', symbol, file], {
    encoding: 'utf8',
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    ...opts,
  });
}

// criterion string -> { symbol, expected } | null
// Recognized shapes (symbol = a bare word/identifier or a quoted phrase; N = integer;
// "hit" or "hits", "exactly" optional -- both variants are documented in the task):
//   ... `grep -n SYMBOL [FILE]` ... [exactly] N hit(s) ...
//   ... `grep -n SYMBOL [FILE]` ... returns N hit(s) ...
const GRIP_RE = /grep\s+-n\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s+((?:\.{1,2}\/)?[\w./@-]+)/;
const EXACTLY_COUNT_RE = /\bexactly\s+(\d+)\s+hits?\b/i;
const RETURNS_COUNT_RE = /\breturns\s+(\d+)\s+hits?\b/i;

function extractHitCountAssertion(criterion) {
  const text = String(criterion || '');
  const g = GRIP_RE.exec(text);
  if (!g) return null;
  const symbol = g[1] || g[2] || g[3];
  const file = g[4];
  let expected = null;
  const exact = EXACTLY_COUNT_RE.exec(text);
  if (exact) expected = parseInt(exact[1], 10);
  else {
    const ret = RETURNS_COUNT_RE.exec(text);
    if (ret) expected = parseInt(ret[1], 10);
  }
  if (!Number.isInteger(expected) || expected < 0) return null;
  return { symbol, file, expected };
}

// criteria: string[] (or null/undefined) -> array of { symbol, file, expected }
function extractHitCountAssertions(criteria) {
  if (!Array.isArray(criteria)) return [];
  const out = [];
  for (const c of criteria) {
    const a = extractHitCountAssertion(c);
    if (a) out.push(a);
  }
  return out;
}

// The diff section (one `diff --git` block) that edits `file`, or null when the draft does not touch it.
function diffSectionFor(rawDiff, file) {
  if (typeof rawDiff !== 'string' || !rawDiff) return null;
  const want = String(file).replace(/^\.\//, '');
  for (const section of rawDiff.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(section);
    if (m && m[2] === want) return section;
  }
  return null;
}

// The criterion describes the file AFTER the draft, but repoRoot holds the file BEFORE it: counting there gives a false block on a
// correct draft (criterion "exactly 2 hits" against an unmodified checkout reads 0). When the draft's diff touches `file`, apply just
// that file's section to a scratch copy and count in the copy. Returns { dir, cleanup } or null when it cannot be applied (caller skips).
function postImageDir({ file, repoRoot, section }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hit-count-gate-'));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
  try {
    const rel = String(file).replace(/^\.\//, '');
    const src = path.join(repoRoot, rel);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(src, path.join(dir, rel));
    }
    fs.writeFileSync(path.join(dir, '.draft.patch'), section.endsWith('\n') ? section : `${section}\n`);
    execFileSync('git', ['apply', '--whitespace=nowarn', '.draft.patch'], { cwd: dir, stdio: 'ignore', timeout: DEFAULT_TIMEOUT_MS });
    if (!fs.existsSync(path.join(dir, rel))) { cleanup(); return null; } // the draft deletes the file
    return { dir, cleanup };
  } catch {
    cleanup();
    return null;
  }
}

// { symbol, file, expected, repoRoot, rawDiff?, grepC? } -> { ok, actual } | null
// null = the check could not run (missing file, grep itself failed, the draft's section does not apply) -- the caller
// treats that as "skip", never as a mismatch. Non-zero grep exit (no matches) is a legitimate actual count of 0, not an error.
function countSymbol({ symbol, file, repoRoot, rawDiff, grepC = realGrepC }) {
  let root = repoRoot;
  let post = null;
  const section = diffSectionFor(rawDiff, file);
  if (section) {
    post = postImageDir({ file, repoRoot, section });
    if (!post) return null;
    root = post.dir;
  }
  try {
    const out = grepC(symbol, String(file).replace(/^\.\//, ''), { cwd: root });
    const actual = parseInt(String(out).trim(), 10);
    if (!Number.isInteger(actual)) return null;
    return { ok: true, actual };
  } catch (e) {
    // grep -c prints "0" to stdout and exits 1 on zero matches -- honor that.
    const stdout = String((e && e.stdout) || '');
    if (stdout.trim() === '0') return { ok: true, actual: 0 };
    return null; // file missing/unreadable or grep unavailable -- caller skips
  } finally {
    if (post) post.cleanup();
  }
}

// { repoRoot, criteria, rawDiff?, grepC? } -> { verdict: 'blocked', blockedReason } | null
// null = nothing to block on (no recognized assertions, or every assertion's count
// matched) -- the caller falls through to its normal review path unchanged.
function checkHitCountGate({ repoRoot, criteria, rawDiff, grepC }) {
  const assertions = extractHitCountAssertions(criteria);
  if (!assertions.length) return null;
  const failures = [];
  let checked = 0;
  for (const a of assertions) {
    const r = countSymbol({ ...a, repoRoot, rawDiff, grepC });
    if (!r) continue; // unresolvable target -- deliberately skipped, never blocked on
    checked += 1;
    if (r.actual !== a.expected) {
      failures.push(`grep -c ${a.symbol} ${a.file} => actual ${r.actual}, expected ${a.expected}`);
    }
  }
  if (!failures.length) return null;
  return {
    verdict: 'blocked',
    blockedReason: `Deterministic hit-count gate: ${failures.join('; ')} -- the asserted grep hit count is mechanically checkable and does not match, so no local-model review call is spent on this draft.`,
  };
}

module.exports = { extractHitCountAssertion, extractHitCountAssertions, countSymbol, checkHitCountGate, DEFAULT_TIMEOUT_MS };
