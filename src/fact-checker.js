'use strict';

// Deterministic, non-LLM pre-filter that runs on an Ornith draft before a Claude review
// pass spends any tokens on it. Per Docs/agents/ornith-delegation.md's own hard-won
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

function resolveAgainstRepo(repoRoot, candidatePath) {
  const normalized = candidatePath.replace(/\\/g, '/').replace(/^\.?\//, '');
  const tryRoots = [repoRoot, path.join(repoRoot, 'backend'), path.join(repoRoot, 'backend', 'python_services')];
  for (const root of tryRoots) {
    const full = path.join(root, normalized);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function checkFilePaths(text, repoRoot) {
  return extractFilePaths(text).map((claimedPath) => {
    const resolved = resolveAgainstRepo(repoRoot, claimedPath);
    return { claimedPath, exists: !!resolved, resolvedPath: resolved };
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

function checkRelationships(text, repoRoot) {
  return extractClaimedRelationships(text).map((rel) => {
    const resolvedFrom = /\.[a-z]+$/i.test(rel.from) ? resolveAgainstRepo(repoRoot, rel.from) : null;
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
// Docs/agents/ornith-delegation.md, "What Ornith is bad at"). This is a cheap keyword-adjacency
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
// grammatically-valid value (a made-up GIS URL or field name). Docs/agents/ornith-delegation.md
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
function checkDraft(draftText, repoRoot, sourceText) {
  const fileChecks = checkFilePaths(draftText, repoRoot);
  const relationshipChecks = checkRelationships(draftText, repoRoot);
  const blastRadiusFlag = checkBlastRadiusBias(draftText);
  const groundedFlags = checkGroundedValues(draftText, sourceText);

  const flags = [];
  for (const f of fileChecks) {
    if (!f.exists) flags.push({ type: 'missing-file', detail: f.claimedPath });
  }
  for (const r of relationshipChecks) {
    if (r.checked && !r.found) {
      flags.push({ type: 'unconfirmed-relationship', detail: `"${r.from}" does not appear to reference "${r.to}"` });
    }
  }
  if (blastRadiusFlag) {
    flags.push({ type: 'unscoped-heavy-change', detail: blastRadiusFlag.note });
  }
  flags.push(...groundedFlags);

  return { flags, fileChecks, relationshipChecks, blastRadiusFlag, groundedFlags };
}

module.exports = {
  checkDraft,
  checkFilePaths,
  checkRelationships,
  checkBlastRadiusBias,
  checkGroundedValues,
  extractFilePaths,
  extractClaimedRelationships,
};

if (require.main === module) {
  const [, , draftPath, repoRoot, sourcePath] = process.argv;
  if (!draftPath || !repoRoot) {
    console.error('usage: node fact-checker.js <draft.txt> <repoRoot> [sourceText.txt]');
    process.exit(1);
  }
  const draftText = fs.readFileSync(draftPath, 'utf8');
  const sourceText = sourcePath && fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : undefined;
  console.log(JSON.stringify(checkDraft(draftText, repoRoot, sourceText), null, 2));
}
