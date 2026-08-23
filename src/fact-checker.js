'use strict';

// Deterministic, non-LLM pre-filter that runs on an Ornith draft before a Claude review
// pass spends any tokens on it. Per Docs/agents/local-delegation.md's own hard-won
// finding from the prior overnight run: "the file exists" is necessary but NOT
// sufficient -- a design once cited a real file and a real function name that were
// never actually connected (a different, similarly-named file made the real call).
// This checker therefore does two tiers, and is explicit that only the first is
// reliable on its own:
//   1. File-existence check (cheap, reliable) -- flags fabricated paths outright.
//   2. Best-effort claimed-relationship check ("`A` imports `B`" / "`A` calls `B`")
//      by grepping A's real content for B -- catches the SPECIFIC failure mode found
//      before, but is pattern-matching on prose, not a real import-graph parse. A
//      "relationship confirmed" result here is still corroborating evidence for
//      Claude's review pass, not a replacement for it.

const fs = require('fs');
const path = require('path');

const PATH_EXT_RE = /[A-Za-z0-9_.\-/\\]+\.(?:js|jsx|ts|tsx|py|json|md|csv)\b/g;
const RELATIONSHIP_RE = /`([^`]+)`\s+(?:imports?|calls?|reads?\s+from|uses?)\s+`?([A-Za-z0-9_.]+)`?/gi;

function extractFilePaths(text) {
  const matches = text.match(PATH_EXT_RE) || [];
  return [...new Set(matches)];
}

// Confirmed live 2026-08-20 (first real product_spec bootstrap run against a brand-new
// crm-plugin repo): a Group B `{"mode":"create", "file":"Docs/PRODUCT_SPEC.md", ...}`
// draft got auto-rejected in review because checkFilePaths flagged its OWN create target
// as a "missing file" -- which is exactly correct and expected for a create (the whole
// point is the file doesn't exist yet), not fabrication. extractFilePaths works on raw
// text with no notion of the draft's actual structure, so it can't tell "this path is
// claimed to already exist" (a real fabrication signal) apart from "this path is the
// thing about to be created" (the normal, common case for arch_review/arch_import/
// pipeline_self_audit/product_spec extracting or creating a new file, not just
// brain_dump_sort's secondBrainPath, which already had its own narrower carve-out in
// buildVerdictPrompt's wording alone -- a prompt-level carve-out doesn't stop the
// deterministic flag from being generated and handed to the model as "evidence toward
// fabrication" in the first place). Best-effort JSON parse; any failure (malformed JSON,
// not Group B shaped at all -- e.g. a brain_dump_sort/research prose draft) just means no
// targets get excluded, the exact same behavior as before this fix existed.
function extractCreateModeTargets(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.warn('[fact-checker] failed to parse targets input', err);
    return new Set();
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const targets = new Set();
  for (const item of items) {
    if (item && item.mode === 'create' && typeof item.file === 'string' && item.file.trim()) {
      targets.add(item.file.trim());
    }
  }
  return targets;
}

// Same skip-list unused-export-scan.js already uses for its own directory walk --
// deliberately not walking into these regardless of repo size.
// '.claude' skipped too -- confirmed live 2026-07-21: a stray leftover git worktree at
// .claude/worktrees/<name>/ (not created by this fix, pre-existing debris) contains
// duplicate copies of real source files, which otherwise makes an unambiguous match
// falsely look ambiguous (2 matches: the real file + its worktree copy) and blocks a
// resolution that should have succeeded cleanly.
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'queue', 'instances', 'dist', 'build', 'coverage', '.next', 'target', 'vendor']);

// Bounded recursive search for a file matching `basename` anywhere under `root`. Only
// used as a last-resort fallback (see resolveAgainstRepo below) -- deep_dive tasks review
// a CLONED external repo with an arbitrary, unknowable-in-advance layout, so no fixed
// extraRoots list can generalize the way it can for this package's own repo. Stops at
// maxResults finds; resolveAgainstRepo treats anything other than exactly one match as
// unresolved (0 = genuinely doesn't exist; >1 = ambiguous, don't guess which one).
function findByBasename(root, basename, maxResults = 2) {
  const found = [];
  function walk(dir) {
    if (found.length >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxResults) return;
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === basename) {
        found.push(path.join(dir, entry.name));
      }
    }
  }
  walk(root);
  return found;
}

// extraRoots: repoRoot-relative dirs to ALSO try prefixing the claimed path with, for
// when a draft writes a bare filename dropped of its real leading directory (e.g. "Files:
// local-client.js" instead of "src/local-client.js" -- confirmed live 2026-07-21: this
// repo's own arch_discovery drafts do exactly this routinely). Previously hardcoded to
// 'backend'/'backend/python_services' -- a DIFFERENT consumer project's layout baked into
// this package's own code, not generalized. This repo's real files live under 'src/',
// which was never tried, so EVERY bare-filename claim against a src/ file false-negatived
// as "missing" and got misreported to review as fabrication. Now sourced from
// getConfig().grepAllowedDirs (the same "consumer configures where real code lives"
// config every other path-scoped tool in this package already uses), not hardcoded.
//
// Falls back to findByBasename() when the direct joins above all miss -- confirmed live
// the SAME session, same root cause, different flavor: a deep_dive draft reviewing a
// CLONED external repo wrote "Files: SummaryCard.tsx" when the real file is nested three
// directories deep (desktop/src/components/ExecutionReport/SummaryCard.tsx). No fixed
// extraRoots list can be known in advance for an arbitrary external repo's layout, so this
// tier searches for it instead -- but only trusts a single, unambiguous match.
function resolveAgainstRepo(repoRoot, candidatePath, extraRoots = []) {
  const normalized = candidatePath.replace(/\\/g, '/').replace(/^\.?\//, '');
  const tryRoots = [repoRoot, ...extraRoots.map((r) => path.join(repoRoot, r))];
  for (const root of tryRoots) {
    const full = path.join(root, normalized);
    if (fs.existsSync(full)) return full;
  }

  const basename = path.basename(normalized);
  const matches = findByBasename(repoRoot, basename);
  if (matches.length === 1) return matches[0];

  return null;
}

function checkFilePaths(text, repoRoot, extraRoots = []) {
  return extractFilePaths(text).map((claimedPath) => {
    const resolved = resolveAgainstRepo(repoRoot, claimedPath, extraRoots);
    return { claimedPath, exists: !!resolved, resolvedPath: resolved };
  });
}

// Fabricated-commit-reference check (2026-08-23, Grimmethy: "use it to harden the
// pipeline" -- caught live via an adhoc task rejected TWICE by a human reviewer for the
// SAME fabrication: the draft claimed "commit 7261944" had already resolved the request,
// with no diff or evidence, and that hash does not exist anywhere in this repo's history.
// checkFilePaths already catches a fabricated FILE reference deterministically before a
// review pass ever spends a token on it -- a fabricated COMMIT reference is the exact same
// failure mode (a specific, checkable, concrete claim invented instead of verified) with
// no equivalent check, so it took two full reject cycles to catch by hand what `git log`
// could have answered in milliseconds on the first attempt.
const COMMIT_CLAIM_RE = /\bcommits?\s+`?([0-9a-f]{7,40})`?\b/gi;

function extractClaimedCommits(text) {
  const matches = [...(text || '').matchAll(COMMIT_CLAIM_RE)].map((m) => m[1].toLowerCase());
  return [...new Set(matches)];
}

const GIT_COMMIT_CHECK_TIMEOUT_MS = 15_000;

// Best-effort, same non-fatal treatment every other git call in this pipeline already
// follows (see staleness-audit.js's own findFilesTouchedSince): a repo with no .git dir,
// git itself unavailable, or any other lookup failure resolves to "unknown" (neither
// confirmed nor flagged as fabricated) rather than a false-positive fabrication flag on
// an environment problem that has nothing to do with the draft's own honesty.
function checkCommitClaims(text, repoRoot) {
  const { execFileSync } = require('child_process');
  return extractClaimedCommits(text).map((hash) => {
    let exists;
    try {
      execFileSync('git', ['cat-file', '-e', `${hash}^{commit}`], {
        cwd: repoRoot, timeout: GIT_COMMIT_CHECK_TIMEOUT_MS, stdio: ['ignore', 'ignore', 'pipe'],
      });
      exists = true;
    } catch (e) {
      // git exits non-zero both for "not a valid object name" (the real fabrication
      // signal, exit 128) AND for "not a git repository at all" (also exit 128) -- the
      // exit code alone can't tell those apart, only the message can. Confirmed live:
      // `git cat-file -e X^{commit}` outside any repo prints "fatal: not a git
      // repository (or any of the parent directories): .git", never mentioning the hash
      // itself -- an environment problem, not evidence about the claim, so it must not
      // read as false the same way an unresolved find-string bug would misreport a
      // config problem as a content problem.
      const stderr = (e.stderr || '').toString();
      // e.code === 'ENOENT' (git binary itself not found) or a timeout (e.signal set)
      // also carries no evidence about the hash -- same unknown treatment.
      exists = (e.code === 'ENOENT' || e.signal || /not a git repository/i.test(stderr)) ? null : false;
    }
    return { claimedHash: hash, exists };
  });
}

function extractClaimedRelationships(text) {
  const out = [];
  let match;
  const re = new RegExp(RELATIONSHIP_RE);
  while ((match = re.exec(text)) !== null) {
    out.push({ from: match[1], to: match[2] });
  }
  return out;
}

function checkRelationships(text, repoRoot, extraRoots = []) {
  return extractClaimedRelationships(text).map((rel) => {
    const resolvedFrom = /\.[a-z]+$/i.test(rel.from) ? resolveAgainstRepo(repoRoot, rel.from, extraRoots) : null;
    if (!resolvedFrom) {
      return { ...rel, checked: false, reason: 'claimed source is not a resolvable file path' };
    }
    const content = fs.readFileSync(resolvedFrom, 'utf8');
    const found = content.includes(rel.to);
    return { ...rel, checked: true, resolvedFrom, found };
  });
}

// Third tier, added 2026-07-08 from the agenticloops-ai eval-harness plan (case 6 of the
// golden-dataset design): a documented Ornith failure mode is proposing the architecturally
// heavier/riskier fix over a narrow one with no apparent sense of blast radius (see
// Docs/agents/local-delegation.md, "What Ornith is bad at"). This is a cheap keyword-adjacency
// heuristic, not a real risk analysis -- same "necessary but not sufficient" caveat as the two
// checks above. It flags drafts that use broad/heavy-change language without ANY nearby
// scoping or risk-acknowledgment language, so Claude's review pass looks at blast radius first
// on exactly the drafts most likely to need it.
const HEAVY_CHANGE_RE = [
  /\brewrite\b/i,
  /\brefactor(?:ing)?\s+the\s+shared\b/i,
  /\bacross all counties\b/i,
  /\bentire (?:registry|codebase|pipeline)\b/i,
  /\ball counties\b/i,
  /\bevery county\b/i,
  /\bglobal(?:ly)?\s+(?:rename|change|refactor)\b/i,
];
const SCOPE_ACK_RE = [
  /\bblast radius\b/i,
  /\bnarrow(?:ly)?[- ]scoped\b/i,
  /\bscoped to\b/i,
  /\bsingle[- ]file\b/i,
  /\bone[- ]file\b/i,
  /\bminimal(?:ly)?[- ]invasive\b/i,
  /\btargeted (?:fix|change)\b/i,
  /\blow[- ]risk\b/i,
];

function checkBlastRadiusBias(text) {
  const heavyHit = HEAVY_CHANGE_RE.find((re) => re.test(text));
  if (!heavyHit) return null;
  if (SCOPE_ACK_RE.some((re) => re.test(text))) return null;
  return {
    pattern: heavyHit.source,
    note: 'draft proposes a broad/heavy change with no visible blast-radius or scoping justification nearby',
  };
}

// Fourth tier, added 2026-07-08: the grounded-value check. This attacks the failure mode that
// constrained decoding structurally CANNOT prevent -- confident fabrication of a plausible,
// grammatically-valid value (a made-up GIS URL or field name). Docs/agents/local-delegation.md
// records this as the worst, most-repeated failure ("fabricated a specific vendor attribution",
// "invented classification codes/filenames"). The prompts explicitly instruct Ornith to use a
// placeholder + note rather than invent an unverified URL/field -- an instruction it is
// documented to ignore. This check flags any URL or GIS-style field token in the draft that does
// NOT appear verbatim in the source material Ornith was actually given, so a hallucinated value
// surfaces for Claude's review pass instead of riding through as plausible-looking JSON.
//
// Scope is deliberately high-precision (flag-only, necessary-not-sufficient, same as the tiers
// above): URLs (a fabricated one is almost never a false positive) and ALLCAPS_UNDERSCORE tokens
// (the shape of real GIS column names like FCV_CUR / MAIL_ADDR1 -- canonical output field names
// are lowerCamelCase and won't match). Obvious placeholders are exempt because the prompt WANTS
// Ornith to use them when it can't verify. A value that appears anywhere in the source (even in a
// sibling example) is treated as grounded -- this catches wholesale invention, not the subtler
// case of copying a real value from the wrong sibling.
const URL_RE = /https?:\/\/[^\s"'`)\]}<>]+/gi;
const GIS_FIELD_RE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g;
const PLACEHOLDER_RE = /placeholder|example\.(?:com|org|net)|\bTODO\b|\bFIXME\b|\bTBD\b|XXXX?/i;

function checkGroundedValues(draftText, sourceText) {
  if (!sourceText) return [];
  const flags = [];

  const urls = [...new Set(draftText.match(URL_RE) || [])];
  for (const raw of urls) {
    const url = raw.replace(/[.,;:]+$/, ''); // strip trailing sentence punctuation
    if (PLACEHOLDER_RE.test(url)) continue;
    if (!sourceText.includes(url)) {
      flags.push({ type: 'ungrounded-url', detail: url });
    }
  }

  const fields = [...new Set(draftText.match(GIS_FIELD_RE) || [])];
  for (const field of fields) {
    if (PLACEHOLDER_RE.test(field)) continue;
    if (!sourceText.includes(field)) {
      flags.push({ type: 'ungrounded-field', detail: field });
    }
  }

  return flags;
}

// Returns a flat list of flags Claude's review pass should look at first. An empty
// list means "nothing suspicious found by this cheap pass" -- it does NOT mean the
// draft is correct. `sourceText` (optional) is the material Ornith was actually given for
// this task; when provided, the grounded-value check runs against it.
function checkDraft(draftText, repoRoot, sourceText, extraRoots = []) {
  const rawFileChecks = checkFilePaths(draftText, repoRoot, extraRoots);
  const relationshipChecks = checkRelationships(draftText, repoRoot, extraRoots);
  const blastRadiusFlag = checkBlastRadiusBias(draftText);
  const groundedFlags = checkGroundedValues(draftText, sourceText);
  const createModeTargets = extractCreateModeTargets(draftText);
  const commitChecks = checkCommitClaims(draftText, repoRoot);

  // isCreateTarget is stamped onto fileChecks itself (not just used to filter `flags`
  // below) because buildVerdictPrompt (review-task.js) hands the REVIEWER MODEL the raw
  // fileChecks JSON directly, not just the derived flags -- confirmed live 2026-08-20,
  // second incident of the same day: with only `flags` fixed, a create-mode draft still
  // got rejected because the model read the raw `"exists": false` entry itself and
  // (correctly, per its own instructions at the time) treated it as fabrication evidence,
  // unaware that suppression already happened one layer up. The field name doubles as the
  // reviewer-prompt's own explanation for why this particular exists:false isn't suspicious.
  const fileChecks = rawFileChecks.map((f) => (
    createModeTargets.has(f.claimedPath) ? { ...f, isCreateTarget: true } : f
  ));

  const flags = [];
  for (const f of fileChecks) {
    // A create mode's own target not existing yet is the normal, correct case, not
    // fabrication -- see extractCreateModeTargets' own header for the live incident this
    // fixes. Still recorded in fileChecks (now flagged isCreateTarget) for transparency;
    // only the flag derived from it is suppressed.
    if (!f.exists && !f.isCreateTarget) flags.push({ type: 'missing-file', detail: f.claimedPath });
  }
  for (const r of relationshipChecks) {
    if (r.checked && !r.found) {
      flags.push({ type: 'unconfirmed-relationship', detail: `"${r.from}" does not appear to reference "${r.to}"` });
    }
  }
  for (const c of commitChecks) {
    // exists === false only (not null) -- git itself confirmed this hash is not a real
    // object in this repo's history, not just "couldn't check" (missing repo/git, see
    // checkCommitClaims' own comment). A drafter claiming specific work was "already done
    // in commit X" is exactly the same checkable-but-unchecked-claim shape a missing-file
    // reference already catches; this closes the gap for the same fabrication pattern
    // aimed at a commit hash instead of a path.
    if (c.exists === false) flags.push({ type: 'fabricated-commit-reference', detail: c.claimedHash });
  }
  if (blastRadiusFlag) {
    flags.push({ type: 'unscoped-heavy-change', detail: blastRadiusFlag.note });
  }
  flags.push(...groundedFlags);

  return { flags, fileChecks, relationshipChecks, blastRadiusFlag, groundedFlags, commitChecks };
}

module.exports = {
  checkDraft,
  checkFilePaths,
  checkRelationships,
  checkBlastRadiusBias,
  checkGroundedValues,
  checkCommitClaims,
  extractFilePaths,
  extractCreateModeTargets,
  extractClaimedRelationships,
  extractClaimedCommits,
  resolveAgainstRepo,
  findByBasename,
};

if (require.main === module) {
  const [, , draftPath, repoRoot, sourcePath] = process.argv;
  if (!draftPath || !repoRoot) {
    console.error('usage: node fact-checker.js <draft.txt> <repoRoot> [sourceText.txt]');
    process.exit(1);
  }
  const draftText = fs.readFileSync(draftPath, 'utf8');
  const sourceText = sourcePath && fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : undefined;
  // Best-effort: grepAllowedDirs comes from AGENT_MANAGER_REPO_ROOT's config, which should
  // always be set when this runs as part of the real pipeline (review-runner.ps1 requires
  // it already) -- but this script is also useful as a standalone CLI against an arbitrary
  // repoRoot, so a missing/misconfigured env var degrades to the old repoRoot-only
  // behavior instead of crashing the fact-check (and, transitively, the whole review pass).
  let extraRoots = [];
  try {
    extraRoots = require('./config.js').getConfig().grepAllowedDirs;
  } catch {
    /* no AGENT_MANAGER_REPO_ROOT in this context -- fall back to repoRoot-only resolution */
  }
  console.log(JSON.stringify(checkDraft(draftText, repoRoot, sourceText, extraRoots), null, 2));
}
