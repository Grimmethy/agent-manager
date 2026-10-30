'use strict';

// Post-implement grounding check for deep_dive item write-ups (2026-09-05). Investigated
// 8 blocked deep_dive tasks: every single one was rejected for the same shape -- the draft
// fabricates a specific class/function/architecture detail that contradicts the REAL
// content of the external project's files it was given verbatim in the plan prompt
// (deepDivePlanPrompt's own formatFileContents(ctx.files) call). Examples caught live:
// "the draft references `TextFileConverter` and `ConversionError`, but the grounding
// source explicitly shows the class is named `TextFileToDocument`"; "claims the tools are
// registered via `@register_for_llm`... but the grounding source shows they are decorated
// with `@tool(approval_mode=...)`". deepDiveImplementPrompt only hands the model its OWN
// prior plan text, not the real file content again -- nothing re-verifies the final
// write-up against ground truth before it reaches review, so a hallucination introduced
// at implement time (or one the plan already had, elaborated further) sails through
// blind, exactly the same class of gap function-length-grounding-check.js closed for
// function_length_review the same day.
//
// Same deterministic-first / cheap-model-fallback shape as arch-import-premise-check.js /
// function-length-grounding-check.js. Check 1 is free: a deep-dive write-up leans heavily
// on backtick-quoted CLASS-shaped identifiers (PascalCase, the exact shape every real
// incident above hallucinated) -- one that never appears anywhere in the real fetched file
// content is a fabricated symbol, not a judgment call. Check 2 (cheap qwen2.5:3b call) is
// the semantic fallback for a contradiction Check 1's simple substring test cannot catch
// (a real class name used with an invented method, decorator, or behavior).
//
// Wired via the generic, source-agnostic `postImplementCheck` hook (local-draft.js) --
// same convention as premiseCheck; an 'ungrounded' verdict routes into the exact same
// blockedStage:'review' path a real review rejection takes.
//
// Kill switch: AGENT_MANAGER_DEEP_DIVE_GROUNDING_CHECK=false.

const { call: localCall } = require('./local-client.js');
const { isForgePause } = require('./gpu-guard.js');
const { builtinModules } = require('module');

// 2026 'Cheap Verifiers, Large Blind Spots' caveat: Check 2 (this cheap model) is a better-than-nothing second layer, NOT a substitute for Check 1's deterministic match -- its blind spot is largest in this cheap/cheap config. See src/deterministic-recheck-registry.js header.
//
// 2026-09-18: no hardcoded model default -- see candidate-premise-check.js's identical
// fix (same worker-1/worker-reasoning GPU-thrashing incident) for the full rationale.
// undefined falls through to LOCAL_MODEL; AGENT_MANAGER_DEEP_DIVE_GROUNDING_MODEL still
// opts a genuinely separate model back in.
const GROUNDING_CHECK_MODEL = process.env.AGENT_MANAGER_DEEP_DIVE_GROUNDING_MODEL;
const GROUNDING_CHECK_NUM_CTX = 8192;

function isEnabled() {
  return process.env.AGENT_MANAGER_DEEP_DIVE_GROUNDING_CHECK !== 'false';
}

function clip(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}\n...[truncated]` : str;
}

function realFilesOf(task) {
  const files = (task.promptContext && task.promptContext.files) || [];
  return Array.isArray(files) ? files.filter((f) => f && typeof f.content === 'string') : [];
}

// --- Check 1: a backtick-quoted, class-shaped identifier absent from every real file ---
// PascalCase, >=4 chars -- the exact shape every real incident hallucinated
// (TextFileConverter, ConversionError, DevUI). Deliberately NOT matching lowercase/snake_
// case identifiers, which are far more likely to collide with common English words
// ("pipeline", "config") a deep-dive write-up uses generically without meaning it as a
// cited symbol.
const CLASS_SHAPED_SYMBOL_RE = /`([A-Z][A-Za-z0-9]{3,})`/g;

// A backtick-quoted dotted module path (`foo.bar.Baz`) or slash-separated file path
// (`src/utils/helper`) -- at least two segments joined by '.' or '/', so a bare
// CLASS_SHAPED_SYMBOL_RE match (no separator) never double-matches here. Grounded if
// EITHER the whole string or just its final segment (the part that actually identifies
// the thing being cited -- a real symbol imported under a slightly different path prefix
// than the draft guessed is still real) appears in the real file content; only flagged
// when neither does.
const PATH_SHAPED_SYMBOL_RE = /`([A-Za-z_][\w-]*(?:[./][A-Za-z_][\w-]*)+)`/g;

// A literal `__all__ = [...]` list in the draft (Python export list convention) -- each
// quoted identifier inside it is a claim that name is really exported, checkable the same
// deterministic way as a cited class name.
const ALL_LIST_RE = /__all__\s*=\s*\[([\s\S]*?)\]/g;
const ALL_LIST_ITEM_RE = /['"]([\w.]+)['"]/g;

// Path-shaped citations that are real but can never appear in a community's file subset
// (change_review AC-75; measured on the 21 real deep_dive tasks in queue/: 3 write-ups fired
// this check and all 3 were false positives): the project's own slug/name/community name
// (`omnigent-ai/omnigent`), and a Node builtin API path (`fs.promises.writeFile`). Class-shaped
// hallucinations, the incidents this check exists for, are unaffected.
function isKnownExternalPath(symbol, task) {
  const pc = (task && task.promptContext) || {};
  if ([pc.projectName, pc.projectSlug, pc.communityName].some((v) => typeof v === 'string' && v && v === symbol)) return true;
  // A file name that merely starts like a builtin (`util.py`, `events.js`) is a project file, not the API.
  if (FILE_EXT_SEGMENT_RE.test(symbol.split(/[./]/).pop())) return false;
  return builtinModules.includes(symbol.split(/[./]/)[0]) && symbol.includes('.');
}

// The part of a path-shaped citation that identifies the cited thing. A file name's extension
// is not the identifier (`SystemMessage.tsx` cites `SystemMessage`, never `tsx`).
const FILE_EXT_SEGMENT_RE = /^(?:tsx?|jsx?|mjs|cjs|py|json|md|css|html?|ya?ml|toml|rs|go|java|rb|sh)$/i;
function citedIdentifier(symbol) {
  const parts = symbol.split(/[./]/);
  const last = parts[parts.length - 1];
  return FILE_EXT_SEGMENT_RE.test(last) && parts.length > 1 ? parts[parts.length - 2] : last;
}

function checkFabricatedSymbols(task, implementResponse) {
  const files = realFilesOf(task);
  if (!files.length) return [];
  const combined = files.map((f) => f.content).join('\n');
  const seen = new Set();
  const contradictions = [];
  const flag = (kind, symbol, detail) => {
    const key = `${kind}:${symbol}`;
    if (seen.has(key)) return;
    seen.add(key);
    contradictions.push({ kind, detail });
  };

  let m;
  CLASS_SHAPED_SYMBOL_RE.lastIndex = 0;
  while ((m = CLASS_SHAPED_SYMBOL_RE.exec(implementResponse))) {
    const symbol = m[1];
    if (!combined.includes(symbol)) {
      flag('class', symbol, `the draft cites \`${symbol}\`, but that name does not appear anywhere in the real fetched content of any file in this community`);
    }
  }

  PATH_SHAPED_SYMBOL_RE.lastIndex = 0;
  while ((m = PATH_SHAPED_SYMBOL_RE.exec(implementResponse))) {
    const symbol = m[1];
    if (isKnownExternalPath(symbol, task)) continue;
    const finalSegment = citedIdentifier(symbol);
    if (!combined.includes(symbol) && !combined.includes(finalSegment)) {
      flag('import', symbol, `the draft cites \`${symbol}\`, but neither that path nor its final segment (\`${finalSegment}\`) appears anywhere in the real fetched content of any file in this community`);
    }
  }

  ALL_LIST_RE.lastIndex = 0;
  let allMatch;
  while ((allMatch = ALL_LIST_RE.exec(implementResponse))) {
    ALL_LIST_ITEM_RE.lastIndex = 0;
    let item;
    while ((item = ALL_LIST_ITEM_RE.exec(allMatch[1]))) {
      const symbol = item[1];
      if (!combined.includes(symbol)) {
        flag('all', symbol, `the draft's __all__ list claims to export \`${symbol}\`, but that name does not appear anywhere in the real fetched content of any file in this community`);
      }
    }
  }

  return contradictions;
}

// --- Type-fidelity check (deterministic): a REAL symbol cited with the wrong declared kind ---
// The gap checkFabricatedSymbols cannot close by construction: it only flags names ABSENT
// from the real files. A symbol that genuinely exists but as a different KIND -- e.g. the
// real source says `class MyConfig(TypedDict)` and the draft calls it "the `MyConfig`
// class" -- passes the substring test but is the exact architecture-fabrication shape the
// #28/#36/#35 rejections caught at review (each retry = a full re-draft). Flag ONLY when
// both the source-declared kind and the draft-claimed kind are positively detected and
// they disagree; any detection miss is null -> no flag (same conservative rule as Check 1's
// deliberate non-matching of lowercase/generic terms).
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// What the REAL source actually declares this symbol as, or null if it cannot be detected
// (null = "not a judgment call" -> checkTypeFidelity never flags on a null side).
function detectActualKind(symbol, sourceText) {
  const esc = escapeRe(symbol);
  // Most specific first: a class X(TypedDict) or X = TypedDict(...) is still a "class"
  // syntactically, but describing it as a plain class is precisely the mislabel we want.
  if (new RegExp(`class\\s+${esc}\\s*\\(\\s*TypedDict\\b`).test(sourceText) ||
      new RegExp(`${esc}\\s*=\\s*TypedDict\\s*\\(`).test(sourceText)) return 'TypedDict';
  if (new RegExp(`class\\s+${esc}\\s*\\(\\s*Enum\\b`).test(sourceText) ||
      new RegExp(`${esc}\\s*=\\s*Enum\\s*\\(`).test(sourceText)) return 'Enum';
  if (new RegExp(`\\bclass\\s+${esc}\\b`).test(sourceText)) return 'class';
  if (new RegExp(`\\bdef\\s+${esc}\\s*\\(`).test(sourceText)) return 'function';
  return null;
}

// What the DRAFT claims this symbol is, from the symbol's OWN clause around each
// backtick-quoted occurrence of it -- NOT a flat ±120-char window, which with source
// `def parse` + `class Foo` would pull "class" (belonging to `Foo`) into `parse`'s
// window and flag parse as a class in the perfectly accurate sentence "the `parse`
// function is called by the `Foo` class". The clause is cut at the nearest sentence/
// clause boundary (a . ; , or newline) or other backtick-quoted symbol mention on either
// side. Returns null when no kind word is claimed in any clause (a bare citation claims
// nothing).
function clauseAround(text, start, end) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  // Left edge: just after the latest boundary (a . ; , or newline, or the closing
  // backtick of an earlier backtick-quoted mention) -- or the start of the text.
  let left = -1;
  for (const ch of ['.', ';', ',', '\n']) left = Math.max(left, before.lastIndexOf(ch));
  for (const o of before.matchAll(/`[^`\n]*`/g)) left = Math.max(left, o.index + o[0].length);
  // Right edge: just before the next boundary, or the opening backtick of a later
  // backtick-quoted mention -- or the end of the text. (Boundary positions below are
  // relative to `after`, so add `end` to convert them to positions in `text`.)
  let right = Infinity;
  const bm = /[.,;\n]/.exec(after);
  if (bm) right = Math.min(right, end + bm.index);
  for (const o of after.matchAll(/`[^`\n]*`/g)) right = Math.min(right, end + o.index);
  return text.slice(left + 1, right === Infinity ? text.length : right);
}

function detectClaimedKind(symbol, draftText) {
  const occ = new RegExp('`' + escapeRe(symbol) + '`', 'g');
  let m;
  while ((m = occ.exec(draftText))) {
    const clause = clauseAround(draftText, m.index, m.index + m[0].length);
    if (/\bTypedDict\b/.test(clause)) return 'TypedDict';
    if (/\bEnum\b/.test(clause)) return 'Enum';
    if (/\bclass\b/.test(clause)) return 'class';
    if (/\b(function|method)s?\b/.test(clause)) return 'function';
  }
  return null;
}

// Any backtick-quoted identifier (not just CLASS_SHAPED_SYMBOL_RE's PascalCase shape -- a
// mislabelled `def helper` is lowercase, and the "claim + reality" double-detection rule
// keeps a lone generic word like `pipeline` from ever flagging). Dotted/slash paths are
// excluded on purpose: those are import/file citations, not kind claims.
const TYPE_FIDELITY_SYMBOL_RE = /`([A-Za-z_][A-Za-z0-9_]*)`/g;

function checkTypeFidelity(task, text) {
  const files = realFilesOf(task);
  if (!files.length) return [];
  const sourceText = files.map((f) => f.content).join('\n');
  const seen = new Set();
  const mismatches = [];
  let m;
  TYPE_FIDELITY_SYMBOL_RE.lastIndex = 0;
  while ((m = TYPE_FIDELITY_SYMBOL_RE.exec(text))) {
    const symbol = m[1];
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    const actual = detectActualKind(symbol, sourceText);
    if (!actual) continue; // absent or undetectable -- checkFabricatedSymbols' lane, or no call
    const claimed = detectClaimedKind(symbol, text);
    if (claimed && claimed !== actual) {
      mismatches.push({
        kind: 'type-mismatch',
        detail: `the draft calls \`${symbol}\` a ${claimed}, but the real fetched source declares it as a ${actual}`,
      });
    }
  }
  return mismatches;
}

// --- Check 2: cheap-model fallback for a contradiction Check 1 cannot catch -------------
function buildGroundingCheckPrompt(task, implementResponse) {
  const files = realFilesOf(task);
  const filesBlock = files.map((f) => `--- ${f.path} ---\n${clip(f.content, 3000)}`).join('\n\n');
  return [
    'A write-up claims to describe specific classes/functions/architecture from a set of real source files. You are given the REAL content of every file. Judge ONLY whether the write-up\'s claims accurately describe the real files -- do not judge whether the write-up\'s opinions/ratings are good.',
    '',
    '--- WRITE-UP ---',
    clip(implementResponse, 4000),
    '',
    '--- REAL FILE CONTENT ---',
    filesBlock ? clip(filesBlock, 8000) : '(no files fetched)',
    '',
    'Output EXACTLY one of:',
    '  GROUNDED',
    'or:',
    '  NOT_GROUNDED -- <one sentence citing the real file content that contradicts a specific claim>',
    'Nothing else.',
  ].join('\n');
}

function parseGroundingVerdict(text) {
  const firstLine = (String(text || '').split('\n').find((l) => l.trim()) || '').trim();
  if (/^GROUNDED\b/i.test(firstLine)) return { verdict: 'ok' };
  const m = firstLine.match(/^NOT_GROUNDED\b\s*[-:]*\s*(.*)$/i);
  if (m) return { verdict: 'ungrounded', reason: m[1].trim().slice(0, 300) || '(no detail given)' };
  return { verdict: 'ok' }; // non-conforming 3b output -- same "0 survivors -> ok" rule as plan-critique.js/premiseCheck
}

// task, implementResponse?, { call?, maybeLockedOn } -> { verdict: 'ok'|'ungrounded', reason?, ungrounded? }
// implementResponse defaults to task.implementResponse || task.draft so this is callable
// as just runGroundingCheck(task) -- the two callers that already have the text handy
// still pass it explicitly and get identical behavior.
async function runGroundingCheck(task, implementResponse = (task && (task.implementResponse || task.draft)), { call = localCall, maybeLockedOn } = {}) {
  if (!isEnabled()) return { verdict: 'ok' };
  const text = String(implementResponse || '');
  if (!text.trim()) return { verdict: 'ok' }; // a legitimate "found nothing" empty draft -- nothing to check

  const fabricated = checkFabricatedSymbols(task, text);
  if (fabricated.length) return { verdict: 'ungrounded', reason: fabricated[0].detail, ungrounded: fabricated };

  // Check 1.5 (deterministic, free): a REAL symbol cited with the wrong declared kind.
  // Same short-circuit shape as Check 1 -- never pays for the Check 2 model call on a hit.
  const typeMismatches = checkTypeFidelity(task, text);
  if (typeMismatches.length) return { verdict: 'ungrounded', reason: typeMismatches[0].detail, ungrounded: typeMismatches };

  if (!realFilesOf(task).length) return { verdict: 'ok' }; // nothing real to ground a model check against either

  const prompt = buildGroundingCheckPrompt(task, text);
  const fn = () => call({
    prompt, model: GROUNDING_CHECK_MODEL, numCtx: GROUNDING_CHECK_NUM_CTX,
    think: false, temperature: 0.2, numPredict: 300, source: task.source,
  });
  let result;
  try {
    result = maybeLockedOn ? await maybeLockedOn(GROUNDING_CHECK_MODEL, fn, 'deep-dive-grounding') : await fn();
  } catch (e) {
    if (isForgePause(e)) throw e;   // the Forge family holds the GPU: do not turn the pause into "grounded" (the draft would skip its check)
    return { verdict: 'ok', error: String((e && e.message) || e).slice(0, 160) }; // advisory -- never blocks on a model-call failure
  }
  if (result && result.degenerate) return { verdict: 'ok' };
  const verdict = parseGroundingVerdict(result && result.response);
  return verdict.verdict === 'ungrounded' ? { ...verdict, ungrounded: [] } : verdict;
}

module.exports = {
  runGroundingCheck,
  checkFabricatedSymbols,
  checkTypeFidelity,
  detectActualKind,
  detectClaimedKind,
  buildGroundingCheckPrompt,
  parseGroundingVerdict,
  realFilesOf,
};
