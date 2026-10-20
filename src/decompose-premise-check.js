'use strict';

// Stale-decompose-premise check (2026-09-15, filed as brain-dump bd-1789433484305,
// "pipeline hardening 3/5"). A sub-task filed by an internal decompose can cite a file --
// often with a specific ~line N -- that was accurate when the PARENT task was written, but
// has since moved, been removed, or been restructured by a LATER, independent decompose or
// redesign. The sub-task's own premise goes stale even though nothing about the sub-task
// record itself changed. Root-caused live, 3 separate real incidents this session:
//   - a sub-task cited src/local-draft.js "~line 2178" for a grounding gate; decompose
//     #226 had already split that file down to 1327 lines total by the time the sub-task
//     drafted -- the cited site could not possibly still be there
//   - a sub-task named src/apply-group-a.js as a "dispatch/enqueue loop" wiring target
//     that never existed there (a conceptual claim, not a line-count one -- NOT caught by
//     this check; see the header's "what this does not catch" note below)
//   - a sub-task named a pidfile-liveness mechanism a later PR replaced with a different,
//     bash-side design (also conceptual, also not caught here)
// Each burned a real draft attempt before a model correctly, but only reactively,
// diagnosed the drift and asked a human. This check is proactive for the ONE sub-case that
// is cheaply, deterministically checkable without any judgment call: a cited line number
// that has become impossible given the file's real, current length.
//
// What this does NOT catch (deliberately, matching candidate-premise-check.js's own
// posture of "cheap, high-confidence, not a judgment call" over completeness): a claim
// that some construct/mechanism exists or doesn't (needs real understanding of the file's
// content, not just its size), or a citation with no line number at all. Two of the three
// real incidents above are exactly that shape and are NOT caught by this check -- it closes
// one real, recurring, cheaply-detectable slice of the problem, not the whole thing.
//
// Deliberately narrow scope, same reasoning: only fires for a sub-task with
// promptContext.decomposedFrom set (an internal decompose product -- never a fresh manual
// task, avoiding false positives on a task that simply hasn't been drafted yet).

const fs = require('fs');
const path = require('path');

// A file path mentioned in prose, optionally backtick-quoted, optionally followed by a
// line reference (":N", "line N", "~line N"). No backtick requirement -- adhoc task text
// overwhelmingly writes "In src/foo.js, ..." in plain prose, unlike the more disciplined
// backtick-per-citation convention candidate-fulfillment markdown docs use.
const PATH_RE = /`?((?:src|python|scripts|lib|docs)\/[\w./-]+\.\w{1,5})`?/g;
// The bare ":NN" alternative used to fire on ANY colon-digits pair, not just a real file:line
// citation -- confirmed live (2026-09-18, filed as adhoc-guard-line-ref-re-against-bare-key-
// digits): a sub-task whose own task text illustrated the bug it asked to fix by quoting the
// example `num_ctx:49152` got wrongly flagged as a stale premise against src/decompose-
// premise-check.js itself (148 real lines), because ":49152" parsed as a bogus "line 49152"
// citation -- self-referentially blocking the very fix meant to prevent this class of false
// positive. Same family as the ISO-timestamp masking above; a settings/config key:value pair
// ("num_ctx:49152", "port:8080") is common in this pipeline's own task prose and looks
// identical to a real line citation without a path immediately before the colon. Now requires
// a `.ext:` immediately before the digits (`path.js:22` still matches; `num_ctx:49152` does
// not), leaving the "line N" alternative untouched.
const LINE_REF_RE = /(?:~?\s*line\s+|\.\w{1,5}:)(\d{2,6})\b/gi;

// ISO-8601 timestamps (as appended by the "HUMAN DESIGN DECISION (answered directly from
// the Needs Clarification picker/Discuss/Chat, <timestamp>):" answer stamps -- see
// task.py's api_task_answer_clarification/api_task_resolve_clarification and
// api_discuss_end) look exactly like a real line citation to LINE_REF_RE's bare ":NN"
// alternative: "2026-09-16T23:19:11.363748+00:00" contains ":19", ":11", ":00" -- each a
// spurious "line 19"/"line 11"/"line 00" match. Root-caused live: a decompose sub-task
// with no real line reference anywhere in its OWN task text ("Create scripts/check-doc-
// link.sh...") was wrongly flagged stale-premise purely because its OWN answer stamp's
// timestamp supplied the phantom line references, which then attributed (via
// nearestPathFor) to the one real path mentioned in the text -- a file the task's whole
// point was to CREATE, so of course it "does not exist in the repo" yet. Masked out
// (same length, so match indices used by nearestPathFor stay aligned with the original
// text) before line-ref matching.
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
function maskTimestamps(text) {
  return text.replace(ISO_TIMESTAMP_RE, (m) => 'x'.repeat(m.length));
}

// A cited line more than this many lines past the file's real, current length is treated
// as impossible -- generous slack (a task citing "line 1651" against a 1600-line file is
// plausibly just a rough/rounded estimate, not a stale premise) rather than flagging
// every citation that's merely approximate.
const LINE_OVERSHOOT_SLACK = 50;

function isEnabled() {
  return process.env.AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK !== 'false';
}

// Injectable for tests -- default reads the real file from disk.
function realLineCount(repoRoot, relPath) {
  try {
    const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    return content.split('\n').length;
  } catch {
    return null; // file does not exist
  }
}

// Given a raw path string that may or may not include an allowed root prefix (src/, python/,
// scripts/, lib/, docs/), build a deduplicated list of candidate repo-relative paths and
// return the first one that actually exists on disk (per lineCountFn), or the raw form if
// none do. Used to normalize relative paths by existence before a line-count check.
function resolveExistingPath(raw, repoRoot, lineCountFn) {
  const ROOTS = ['src', 'python', 'scripts', 'lib', 'docs'];
  const probe = lineCountFn || realLineCount;

  // Strip any leading allowed root to get the bare path (e.g. "src/foo/bar.js" -> "foo/bar.js").
  let bare = raw;
  for (const root of ROOTS) {
    if (bare.startsWith(root + '/')) {
      bare = bare.slice(root.length + 1);
      break;
    }
  }

  // Build the candidate list: raw first, then bare prefixed with each root.
  const candidates = [raw];
  for (const root of ROOTS) {
    const c = root + '/' + bare;
    if (!candidates.includes(c)) candidates.push(c);
  }
  // Deduplicate preserving first-seen order.
  const seen = new Set();
  const deduped = candidates.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });

  // Probe each candidate; return the first that yields a non-null positive line count.
  for (const c of deduped) {
    const n = probe(repoRoot, c);
    if (n !== null && n > 0) return c;
  }
  // None existed -- fall back to the raw form.
  return raw;
}

// A sub-task cites paths the way the task text wrote them ("src/routes/counties.js"), but a
// monorepo keeps its code under sub-roots (TaxHarvest-Cowork: TaxHarvest/backend/src/routes/
// counties.js, TaxHarvest/frontend/src/api/admin.ts), so probing repoRoot/<cited> alone calls
// a perfectly real file "missing" and the task blocks as a stale premise (2026-10-07: HUB0007-02,
// HUB0008-01 and HUB0012-02 on the TaxHarvest pipeline, nothing re-admitted them afterwards).
// Resolve the cited path by PATH-SUFFIX instead: a hit must equal the cited path or end with
// "/" + the cited path, so an unrelated file that merely shares a basename never counts.
// Returns { status: 'unique', relPath } (judge that file), { status: 'ambiguous', matches }
// (more than one real file ends with the cited path -- we cannot tell which the sub-task meant,
// and this check's posture is cheap and high-confidence, so the caller does not flag it) or
// { status: 'none' } (no such file anywhere: a real missing-file). Never throws.
const SUFFIX_MATCH_CAP = 200; // findByBasename defaults to 10; a common basename must not be truncated before the suffix filter
function resolveCitedFile(repoRoot, relPath, { findFn } = {}) {
  try {
    const find = findFn || require('./fact-checker.js').findByBasename;
    const cited = String(relPath).replace(/\\/g, '/').replace(/^\.?\//, '');
    const hits = find(repoRoot, path.basename(cited), SUFFIX_MATCH_CAP) || [];
    const matches = [...new Set(hits
      .map((h) => path.relative(repoRoot, h).replace(/\\/g, '/'))
      .filter((rel) => rel === cited || rel.endsWith('/' + cited)))];
    if (matches.length === 1) return { status: 'unique', relPath: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous', matches };
    return { status: 'none' };
  } catch {
    return { status: 'none' };
  }
}

// A bare filename (no directory prefix) mentioned in prose right before/after a line
// reference ("in counties.js at line 20", "`x.js:42`") -- previously invisible to PATH_RE
// (which requires a src/|python/|scripts/|lib/|docs/ root prefix), so its line ref silently
// pinned to the nearest preceding PREFIXED path via nearestPathFor and the verdict attached
// to the wrong file. Code-like extensions only (.js/.ts/.py/...) so prose fragments like
// "e.g." or "num_ctx:49152" never match.
const BARE_FILE_RE = /(?<![\w./-])([\w-]+\.(?:js|ts|jsx|tsx|py|sh|md|json|ya?ml|css|html|toml)\b)/g;

// Create-introducing verbs (2026-10-08, HUB0160): task prose that names a file whose whole
// point is to CREATE it ("Create src/foo.js ... line 20") must not be called "missing-file"
// -- of course it doesn't exist yet. Deliberately explicit verb FORMS (not an "add\w*"
// stem), so "address", "addendum", "writings" never count.
const CREATE_VERB_RE = /\b(?:created?|creating|createnew|add(?:ed|ing|s)?|writ(?:e|es|ing|ten)|new|generated?|generating|scaffold(?:ed|ing|s)?)\b/gi;
// Sentence boundaries for the guard's "same sentence" test (periods inside "src/foo.js"
// must not split, so an immediately-preceding word char disqualifies).
const SENTENCE_BREAK_RE = /[.!?\n;]/;

// Is `pathIndex` the path a create-verb INTRODUCES? Keyed on THIS specific path token, not
// "the sentence contains a create verb": the nearest create verb before the path (in the
// same sentence) must have NO other path token -- prefixed or bare -- between it and the
// path. "Create src/a.js and update src/b.js (1) ~line 42" suppresses a.js (the verb
// introduces it) but NOT b.js (a.js sits between verb and b.js, so the verb introduces
// a.js, not b.js) -- a genuinely-missing b.js must still be flagged. Returns the
// introducing verb or null.
function createVerbFor(rawText, pathIndex, allPaths) {
  let start = 0;
  for (let i = 0; i < pathIndex; i++) if (SENTENCE_BREAK_RE.test(rawText[i])) start = i + 1;
  const span = rawText.slice(start, pathIndex).toLowerCase();
  CREATE_VERB_RE.lastIndex = 0; // shared global regex -- reset before reuse
  let lastVerb = null;
  let vm;
  while ((vm = CREATE_VERB_RE.exec(span))) lastVerb = vm;
  if (!lastVerb) return null;
  const verbStart = start + lastVerb.index;
  for (const p of allPaths) {
    // Any OTHER path token (prefixed or bare) between the verb and this path: the verb
    // introduces that one, not this -- so this path is not verb-introduced.
    if (p.index !== pathIndex && p.index >= verbStart && p.index < pathIndex) return null;
  }
  return lastVerb[0];
}

// The sentence a path token sits in (same-sentence context for the suppressions audit
// trail). Never throws; falls back to the whole text.
function sentenceAround(text, index) {
  let a = 0;
  for (let i = 0; i < index; i++) if (SENTENCE_BREAK_RE.test(text[i])) a = i + 1;
  let b = text.length;
  for (let i = index; i < text.length; i++) if (SENTENCE_BREAK_RE.test(text[i])) { b = i; break; }
  return text.slice(a, b);
}

function detectStaleDecomposePremise(task, { repoRoot, lineCountFn = realLineCount, resolveFn = resolveCitedFile } = {}) {
  if (!isEnabled()) return null;
  const pc = (task && task.promptContext) || {};
  if (!pc.decomposedFrom) return null; // only ever a decompose product -- see header
  const rawText = String(pc.rawText || '');
  if (!rawText || !repoRoot) return null;

  const pathMap = new Map();
  let pm;
  PATH_RE.lastIndex = 0;
  while ((pm = PATH_RE.exec(rawText))) {
    pathMap.set(pm[1], pm.index);
  }
  const paths = [...pathMap.entries()]
    .map(([relPath, index]) => ({ relPath, index, bare: false }))
    .sort((a, b) => a.index - b.index);
  // Bare-filename citations (no directory prefix) -- see BARE_FILE_RE. Each is checked
  // against the prefixed-path list at its own match position, never a DIFFERENT path's,
  // so "e.g. src/foo.js:12" does not spawn a phantom bare "foo.js" token.
  const bare = [];
  let bm;
  BARE_FILE_RE.lastIndex = 0;
  while ((bm = BARE_FILE_RE.exec(rawText))) {
    const name = bm[1];
    if (!name.includes('/')) {
      // A prefixed path already captures this span (e.g. "src/foo.js" contains the bare
      // "foo.js"): keep ONE token for it, the prefixed one, never a phantom bare token
      // from the same mention (overlap test on both ends of the span).
      const covered = paths.some((p) => p.index <= bm.index + name.length && p.index + p.relPath.length >= bm.index);
      if (!covered) bare.push({ relPath: name, index: bm.index, bare: true });
    }
  }
  const allPaths = [...paths, ...bare].sort((a, b) => a.index - b.index);
  if (!allPaths.length) return null;

  // attached: true when the ref came from the "name.ext:NN" alternative (m[0] starts with
  // the dot) rather than the explicit "line N" keyword form -- the bare-name branch below
  // uses this to stay silent on the config-vs-citation ambiguity the num_ctx:49152
  // incident taught us about.
  const lineRefs = [...maskTimestamps(rawText).matchAll(LINE_REF_RE)].map((m) => ({ line: Number(m[1]), index: m.index, attached: m[0][0] === '.' }));
  if (!lineRefs.length) return null;

  // Rough association: a line reference belongs to the nearest file path mentioned at or
  // before it in the text -- matches the common "In <path>, ... (1) ~line N ... (2) ~line
  // M ..." shape every real incident this session used (one file named up front, several
  // line refs after it).
  function nearestPathFor(refIndex) {
    let best = null;
    for (const p of allPaths) {
      if (p.index <= refIndex && (!best || p.index > best.index)) best = p;
    }
    return best || allPaths[0];
  }

  const findings = [];
  const suppressions = [];
  const checkedFiles = new Map(); // relPath -> lineCount | null | 'ambiguous', avoid re-reading the same file per ref
  for (const ref of lineRefs) {
    const p = nearestPathFor(ref.index);
    const relPath = p.relPath;
    if (p.bare) {
      // Bare filename (no directory prefix): never pin to the nearest preceding PREFIXED
      // path (that was the old nearestPathFor misattribution). Resolve it on its own
      // merits instead: unique -> judge the resolved file; ambiguous -> cannot tell which
      // of several real files, do not flag, record the dismissal; none -> the line ref
      // is dropped, recorded (a create verb introducing it names the reason).
      if (!checkedFiles.has(relPath)) {
        let entry;
        const r = resolveFn(repoRoot, relPath);
        if (r && r.status === 'unique') {
          entry = { lines: lineCountFn(repoRoot, r.relPath), resolvedPath: r.relPath };
        } else if (r && r.status === 'ambiguous') {
          entry = { lines: 'ambiguous', resolvedPath: null };
        } else {
          entry = { lines: null, resolvedPath: null };
        }
        checkedFiles.set(relPath, entry);
      }
      const { lines, resolvedPath } = checkedFiles.get(relPath);
      if (lines === 'ambiguous') {
        suppressions.push({ path: relPath, reason: 'ambiguous-bare-filename', sentence: sentenceAround(rawText, p.index), lineRef: ref.line });
        continue;
      }
      if (lines === null) {
        if (createVerbFor(rawText, p.index, allPaths)) {
          suppressions.push({ path: relPath, reason: 'create-verb-introduced', sentence: sentenceAround(rawText, p.index), lineRef: ref.line });
        } else if (!ref.attached) {
          suppressions.push({ path: relPath, reason: 'unresolved-bare-filename', sentence: sentenceAround(rawText, p.index), lineRef: ref.line });
        }
        // Else (attached `name.ext:NN` on a bare name that resolves nowhere, no create
        // verb): stay silent -- bare names were invisible to this check before HUB0161,
        // and "ext:digits" right after a bare name is exactly the config-vs-citation pair
        // the num_ctx:49152 incident says to treat as not-a-citation. Dropping silently
        // here (no suppression record) is what keeps an illustrative sentence like
        // "... (e.g. `path.js:22` still matches ...)" from producing an audit-only result
        // where the pre-HUB0161 behavior was null.
        continue;
      }
      if (ref.line > lines + LINE_OVERSHOOT_SLACK) {
        findings.push({
          kind: 'line-overshoot', relPath, resolvedPath: resolvedPath || undefined, citedLine: ref.line, realLineCount: lines,
          detail: `cites line ${ref.line} of \`${relPath}\`${resolvedPath ? ` (resolved to \`${resolvedPath}\`)` : ''}, but that file is only ${lines} lines long now -- it has likely been restructured (a decompose, a split) since this citation was written`,
        });
      }
      continue;
    }
    // Prefixed path: existing behavior (probe cited location, fall back to suffix resolve).
    if (!checkedFiles.has(relPath)) {
      let lines = lineCountFn(repoRoot, relPath);
      let resolvedPath = null;
      if (lines === null) {
        // Not at the cited location -- look for it under a monorepo sub-root before calling it missing.
        const r = resolveFn(repoRoot, relPath);
        if (r && r.status === 'unique') {
          lines = lineCountFn(repoRoot, r.relPath);
          resolvedPath = r.relPath;
        } else if (r && r.status === 'ambiguous') {
          lines = 'ambiguous';
        }
      }
      checkedFiles.set(relPath, { lines, resolvedPath });
    }
    const { lines: lineCount, resolvedPath } = checkedFiles.get(relPath);
    if (lineCount === 'ambiguous') continue; // several real files end with the cited path: cannot tell which one, so do not flag
    if (lineCount === null) {
      // Create-verb guard, keyed on THIS path token (not "the sentence contains a create
      // verb"): "Create src/a.js and update src/b.js (1) ~line 42" suppresses a.js but
      // keeps the genuinely-missing b.js flagged -- see createVerbFor.
      if (createVerbFor(rawText, p.index, allPaths)) {
        suppressions.push({ path: relPath, reason: 'create-verb-introduced', sentence: sentenceAround(rawText, p.index), lineRef: ref.line });
        continue;
      }
      findings.push({ kind: 'missing-file', relPath, detail: `cites \`${relPath}\`, but that file does not exist in the repo` });
      continue;
    }
    if (ref.line > lineCount + LINE_OVERSHOOT_SLACK) {
      findings.push({
        kind: 'line-overshoot', relPath, resolvedPath: resolvedPath || undefined, citedLine: ref.line, realLineCount: lineCount,
        detail: `cites line ${ref.line} of \`${relPath}\`${resolvedPath ? ` (resolved to \`${resolvedPath}\`)` : ''}, but that file is only ${lineCount} lines long now -- it has likely been restructured (a decompose, a split) since this citation was written`,
      });
    }
  }
  // A file cited more than once (missing-file / same overshoot) is reported once, not per line ref.
  const dedupedFindings = [];
  const dedupSeen = new Set();
  for (const f of findings) {
    const key = f.kind === 'missing-file' ? `missing:${f.relPath}` : `overshoot:${f.relPath}`;
    if (dedupSeen.has(key)) continue;
    dedupSeen.add(key);
    dedupedFindings.push(f);
  }
  // Every dismissal (create-verb-introduced / ambiguous-bare-filename /
  // unresolved-bare-filename) is recorded once per (path, reason, lineRef) so a wrongly
  // dropped case is findable in the audit trail.
  const dedupedSuppressions = [];
  const suppSeen = new Set();
  for (const s of suppressions) {
    const key = `${s.reason}:${s.path}:${s.lineRef}`;
    if (suppSeen.has(key)) continue;
    suppSeen.add(key);
    dedupedSuppressions.push(s);
  }

  if (!dedupedFindings.length) {
    if (!dedupedSuppressions.length) return null;
    // Dismissals only, no blocking finding: consumers that gate on the verdict must
    // check .stale, not just truthiness (local-agentic-write-draft.js, lib/reject-
    // retry-check.js both do).
    return { stale: false, findings: [], suppressions: dedupedSuppressions, reason: null };
  }
  return {
    stale: true,
    findings: dedupedFindings,
    suppressions: dedupedSuppressions,
    reason: `This sub-task's premise may be stale (filed by an internal decompose, then the codebase moved on): ${dedupedFindings.map((f) => f.detail).join('; ')}.`,
  };
}

module.exports = { detectStaleDecomposePremise, resolveCitedFile, SUFFIX_MATCH_CAP, PATH_RE, LINE_REF_RE, LINE_OVERSHOOT_SLACK, maskTimestamps, resolveExistingPath };
