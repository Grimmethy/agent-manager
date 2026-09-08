'use strict';

// Reusable core of scripts/extract-core-ui.js's real V8-parser-oracle extraction, pulled
// out so both the original CLI and a deterministic apply path (file-decompose-to-hub.js's
// script-extract move kind) can use the exact same, already-proven logic instead of two
// implementations drifting apart.
//
// 2026-09-07 ("Ghost in the Machine" concept, Grimmethy: "Build the thing please" -- see
// its own concepts.json entry for the full incident): a script-extract move-child task
// (tasks-and-branches.js) was left to the model as a text-generation job even though this
// exact extraction is 100% mechanical -- the model reinvented a worse, hand-rolled Python
// brace-scanner, got 8 of 26 symbols right, ran out of context, and correctly escalated
// rather than claim false success. This module is what lets the move be applied
// deterministically instead, the same way file-decompose-to-hub.js's flask-blueprint
// moves already get a deterministic wiring step (wire-decomposed-blueprints.js) rather
// than trusting the model to do something code can do with certainty.
//
// The technique itself (Node's own `vm` module as a compile-only oracle for "does this
// candidate slice parse as a complete unit") is unchanged from extract-core-ui.js's own
// header: it eliminates the "hand-rolled lexer desyncs on a template literal / regex
// literal" bug class by construction, since V8 understands every real JS construct with
// full fidelity no hand-rolled state machine can match.
//
// 2026-09-08, Grimmethy: "Yes, please build it" -- extended to plain .js/.mjs/.cjs source
// files, not just JS embedded in an HTML <script> block. Root-caused live: a file-
// decompose hub splitting src/review-task.js (a plain .js file) had every one of its
// moves fall back to move.kind:'module-extract' -- the ONLY category with no deterministic
// apply path at all -- purely because moveTemplateFor (file-decompose-plan-pass.js) and
// staticCheckScriptExtractMove (file-decompose-to-hub.js) both hard-gated this whole
// mechanism on `.html`. The V8-oracle technique above has nothing HTML-specific in it --
// locateFunction/parsesCleanly/findParamsClose/findBodyClose already operate on a plain
// string of JS. The ONLY genuinely HTML-specific work was finding/rewriting the <script>
// block itself; every function below now takes an `isHtml` option (default true, so every
// existing caller's behavior is byte-for-byte unchanged) that skips straight to treating
// the WHOLE source as one script scope when false -- exactly the fix this exact incident
// needed: a plain .js decompose can now skip the model-driven agentic-write tier entirely
// for its actual symbol moves, the same way an .html decompose already could.

const vm = require('vm');

// Every non-src <script>...</script> block, with the 1-based HTML line of its opening tag
// and the JS body's starting character offset within the full HTML text.
function findScriptBlocks(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    const bodyStart = m.index + m[0].indexOf('>', m[1].length) + 1;
    const openLine = html.slice(0, m.index).split('\n').length;
    blocks.push({ body: m[2], bodyStart, openLine });
  }
  return blocks;
}

// Name is historical (predates plain-.js source support) -- purely a line-counter over
// whatever text it's given, no HTML-specific behavior at all.
function htmlLineFor(html, offset) {
  return html.slice(0, offset).split('\n').length;
}

// Compile-only (never runs) syntax check -- the oracle. Returns true iff `src` parses as a
// standalone, complete script.
function parsesCleanly(src) {
  try {
    // eslint-disable-next-line no-new
    new vm.Script(src, { filename: 'oracle-check.js' });
    return true;
  } catch {
    return false;
  }
}

// Finds the index of the ')' that closes the parameter list opened at `openIdx` (where
// text[openIdx] === '('), by trying each ')' after it, in order, wrapped as a throwaway
// function declaration -- the first one that parses wins (see module header for why the
// first success is always correct).
function findParamsClose(text, openIdx) {
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] !== ')') continue;
    if (parsesCleanly(`function f${text.slice(openIdx, i + 1)}{}`)) return i;
  }
  return -1;
}

// Same idea for the function body opened at `openIdx` (where text[openIdx] === '{').
// `isAsync` must match the real declaration -- a body containing `await` is a genuine
// SyntaxError when wrapped in a plain function, which would make every candidate fail
// even though the true close is in there.
function findBodyClose(text, openIdx, isAsync) {
  const wrapper = isAsync ? 'async function f()' : 'function f()';
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] !== '}') continue;
    if (parsesCleanly(`(${wrapper}${text.slice(openIdx, i + 1)})`)) return i;
  }
  return -1;
}

// Locates one named top-level function's [start, endInclusive] character range within
// `body`. Anchors the search to a line that starts (no leading whitespace) with
// `function NAME(` or `async function NAME(`, explicitly excluding call sites (never at
// column 0 immediately followed by the `function` keyword). Returns { problem } when the
// symbol can't be confidently located -- never a guess.
function locateFunction(body, name) {
  const declRe = new RegExp(`^((?:async\\s+)?function)\\s+${name}\\s*\\(`, 'm');
  const declMatch = declRe.exec(body);
  if (!declMatch) return { problem: 'declaration not found at top level' };
  const isAsync = /^async/.test(declMatch[1]);
  const start = declMatch.index;
  const parenOpen = start + declMatch[0].length - 1;
  const parenClose = findParamsClose(body, parenOpen);
  if (parenClose === -1) return { problem: 'could not resolve parameter list close' };
  const braceOpen = body.indexOf('{', parenClose + 1);
  if (braceOpen === -1) return { problem: 'no function body opening brace found' };
  if (body.slice(parenClose + 1, braceOpen).trim() !== '') {
    return { problem: 'unexpected content between parameter list and body' };
  }
  const braceClose = findBodyClose(body, braceOpen, isAsync);
  if (braceClose === -1) return { problem: 'could not resolve function body close' };
  return { start, end: braceClose };
}

// Locates every named symbol against the FIRST inline (non-src) <script> block in `html`
// -- this repo's own real shape has exactly one (see extract-core-ui.js's own header);
// a future target with more than one would need each searched in turn, not built here
// since it isn't the current real shape. Returns per-name results plus the resolved
// ranges (sorted by position, with an overlap check) -- pure, no file I/O.
//
// isHtml:false (2026-09-08): `source` is a plain .js/.mjs/.cjs file, not JS embedded in
// HTML -- the "block" is simply the whole file (offset 0, line 1). Every step below
// (locateFunction, the V8 oracle, overlap detection) already operates on `block.body` as
// an opaque string with no HTML assumptions baked in; only the block-FINDING step differs.
function locateFunctions(source, names, { isHtml = true } = {}) {
  let block;
  if (isHtml) {
    const blocks = findScriptBlocks(source);
    if (blocks.length === 0) {
      return { ok: false, error: 'no inline (non-src) <script> block found', results: [], ranges: [], block: null };
    }
    [block] = blocks;
  } else {
    block = { body: source, bodyStart: 0, openLine: 1 };
  }

  const results = [];
  const ranges = [];
  for (const name of names) {
    const loc = locateFunction(block.body, name);
    if (loc.problem) {
      results.push({ name, status: loc.problem });
      continue;
    }
    const startLine = htmlLineFor(source, block.bodyStart + loc.start);
    const endLine = htmlLineFor(source, block.bodyStart + loc.end);
    ranges.push({ name, start: loc.start, end: loc.end, startLine, endLine });
    results.push({ name, status: 'OK', startLine, endLine });
  }

  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start <= ranges[i - 1].end) {
      results.find((r) => r.name === ranges[i].name).status =
        `overlaps ${ranges[i - 1].name} (${ranges[i - 1].startLine}-${ranges[i - 1].endLine})`;
    }
  }

  const ok = results.every((r) => r.status === 'OK');
  return { ok, results, ranges, block };
}

// Pure extraction: given the full source text and an ordered list of function names,
// either resolves ALL of them cleanly and returns the new file content + rewritten
// original, or returns ok:false with the exact per-name problems -- never a partial
// result. This is what both the CLI's --write and the deterministic apply path share;
// neither one ever writes anything unless every symbol resolved.
//
// isHtml:false (2026-09-08): `source` is a plain .js/.mjs/.cjs file. The located block IS
// the whole file (bodyStart 0), so the rewritten body already IS the new whole-file
// content -- there is no <script> tag or insertion point to rewrite. Returned as
// `newSource` (not `newHtml`, which stays HTML-specific) so a caller can't mistake one
// shape for the other.
function buildExtraction(html, names, { newFileUrl, isHtml = true } = {}) {
  const located = locateFunctions(html, names, { isHtml });
  if (!located.ok) {
    return { ok: false, problems: located.results.filter((r) => r.status !== 'OK'), results: located.results };
  }
  const { block, ranges } = located;
  const ordered = ranges.slice().sort((a, b) => a.start - b.start);
  const funcTexts = ordered.map((r) => block.body.slice(r.start, r.end + 1));
  const newFileContent = `${funcTexts.join('\n\n')}\n`;

  let newBody = block.body;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const r = ordered[i];
    let end = r.end + 1;
    while (newBody[end] === '\n') end += 1; // eat the function's own trailing blank line(s)
    newBody = newBody.slice(0, r.start) + newBody.slice(end);
  }
  newBody = newBody.replace(/\n{3,}/g, '\n\n');

  if (!isHtml) {
    return { ok: true, newFileContent, newSource: newBody, results: located.results };
  }

  const before = html.slice(0, block.bodyStart);
  const after = html.slice(block.bodyStart + block.body.length);
  const scriptSrcTag = newFileUrl ? `<script src="${newFileUrl}"></script>\n` : '';
  const openTagStart = before.lastIndexOf('<script>');
  const newHtml = openTagStart === -1
    ? before + newBody + after
    : before.slice(0, openTagStart) + scriptSrcTag + before.slice(openTagStart) + newBody + after;

  return { ok: true, newFileContent, newHtml, results: located.results };
}

module.exports = {
  findScriptBlocks, htmlLineFor, parsesCleanly, findParamsClose, findBodyClose,
  locateFunction, locateFunctions, buildExtraction,
};
