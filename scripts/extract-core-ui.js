#!/usr/bin/env node
'use strict';

// Extracts a named set of top-level function declarations, verbatim, out of the giant
// inline <script> block in python/dashboard/templates/index.html into a real standalone
// module (python/dashboard/static/js/core-ui.js), served by Flask's default static
// handling and loaded before the remaining inline script.
//
// 2026-09-05, Grimmethy: "if the scanner is a bust and needs reworked we should absolutely
// go that route." Three prior attempts (all through the normal pipeline, each hitting a
// fresh human-decision round) tried to hand-roll a character-by-character JS lexer in
// Python with an explicit mode stack (CODE/EXPR/TPL/SQ/DQ/LC/BC) to find matching braces
// without a template-literal apostrophe or a comment-inside-${} desyncing the stack. It
// It kept desyncing anyway, because a hand-rolled lexer can only ever be an approximation of
// real JS grammar.
//
// This tool instead uses Node's own built-in `vm` module -- the REAL V8 parser -- as an
// oracle: it never tries to reimplement JS tokenization at all. To find where a bracketed
// region (a parameter list, a function body) truly ends, it tries progressively longer
// candidate slices ending at each literal close-bracket character and asks V8 "does this
// parse as a complete, self-contained unit?" via `new vm.Script(...)` (compile-only, never
// executed -- side-effect-free). The FIRST candidate that parses cleanly is guaranteed
// correct, because V8 itself understands every real JS construct (template literals,
// tagged templates, regex literals, generators, destructuring, ASI, comments -- all of it)
// with full fidelity no hand-rolled state machine can match. This eliminates the entire
// "scanner desync" bug class by construction rather than patching around one more edge
// case each time a new one is found live.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The exact 50 names from this migration's own approved scope (adhoc-extract-50-functions-
// from-index-html-into-static-js-core-ui-js-create-new-file-only-1788485466774-0's
// promptContext.rawText) -- overridable via --functions for a future reuse of this tool.
const DEFAULT_FUNCTIONS = [
  'renderHistoryPanel', 'fetchJson', 'severityForTab', 'renderTabButton', 'renderNav',
  'fmtAge', 'statusBadgeClass', 'laneForInstance', 'modelKindForInstance', 'setWorkerModel',
  'setClaudePaused', 'toggleWorkerExpand', 'renderRecentTasksList', 'renderWorkers',
  'fmtDuration', 'updateStaleTimers', 'fmtPct', 'fmtNum', 'fmtUsd', 'renderBarCell',
  'showToast', 'renderProviderToggle', 'wireProviderToggle', 'providerPayload',
  'chatSetCollapsed', 'sendTextToChat', 'chatPanelInit', 'chatStartNew', 'chatSend',
  'chatToggleReserve', 'chatWireProviderToggle', 'chatRender', 'renderClaudeSettingsPanel',
  'wireClaudeSettingsPanel', 'renderClaudeUsagePanel', 'renderCaseInfoModal',
  'openGlobalBrainDumpModal', 'postTaskAction', 'allSourceNames', 'wireQueueSourceFilter',
  'renderQueueTab', 'escapeHtml', 'adhocStateBadgeClass', 'adhocStateLabel',
  'renderPluginsTab', 'pipelineFlagBadges', 'isGroupExpanded', 'setProjectPath',
  'loadProjectHistory', 'loadProjectDropdown',
];

function parseArgs(argv) {
  const out = { html: 'python/dashboard/templates/index.html', functions: null, limit: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--html') out.html = argv[++i];
    else if (a === '--functions') out.functions = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--write') out.write = true;
  }
  return out;
}

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
// function declaration -- the first one that parses wins. See module header for why the
// first success is always correct.
function findParamsClose(text, openIdx) {
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] !== ')') continue;
    if (parsesCleanly(`function f${text.slice(openIdx, i + 1)}{}`)) return i;
  }
  return -1;
}

// Same idea for the function body opened at `openIdx` (where text[openIdx] === '{').
// `isAsync` must match the real declaration -- a body containing `await` is a genuine
// SyntaxError ("await is only valid in async functions...") when wrapped in a plain
// function, which would make every candidate fail even though the true close is in there.
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
// `function NAME(` or `async function NAME(`, matching this codebase's own top-level
// declaration style and explicitly excluding call sites (which are never at column 0
// immediately followed by the `function` keyword).
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const names = (args.functions || DEFAULT_FUNCTIONS).slice(0, args.limit || Infinity);
  const htmlPath = path.resolve(args.html);
  const html = fs.readFileSync(htmlPath, 'utf8');

  const blocks = findScriptBlocks(html);
  if (blocks.length === 0) {
    console.error('no inline (non-src) <script> block found');
    process.exit(1);
  }
  // This migration's HTML has exactly one inline block; if a future target ever has more,
  // search each and report which one a name resolved in -- kept simple for now since
  // that's the real, current shape (see the file-decompose-request's own verified facts).
  const block = blocks[0];

  const results = [];
  const ranges = [];
  for (const name of names) {
    const loc = locateFunction(block.body, name);
    if (loc.problem) {
      results.push({ name, status: loc.problem });
      continue;
    }
    const startLine = htmlLineFor(html, block.bodyStart + loc.start);
    const endLine = htmlLineFor(html, block.bodyStart + loc.end);
    ranges.push({ name, start: loc.start, end: loc.end, startLine, endLine });
    results.push({ name, status: 'OK', startLine, endLine });
  }

  // Overlap check, in file order.
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start <= ranges[i - 1].end) {
      results.find((r) => r.name === ranges[i].name).status =
        `overlaps ${ranges[i - 1].name} (${ranges[i - 1].startLine}-${ranges[i - 1].endLine})`;
    }
  }

  for (const r of results) {
    console.log(`${r.status === 'OK' ? 'OK  ' : 'FAIL'} ${r.name}${r.status === 'OK' ? ` (lines ${r.startLine}-${r.endLine})` : `: ${r.status}`}`);
  }
  const problems = results.filter((r) => r.status !== 'OK');
  console.log(`\n${results.length - problems.length}/${results.length} resolved cleanly.`);

  if (problems.length > 0) {
    process.exit(1);
  }

  if (args.write) {
    const ordered = ranges.slice().sort((a, b) => a.start - b.start);
    const funcTexts = ordered.map((r) => block.body.slice(r.start, r.end + 1));
    const coreUiPath = path.resolve('python/dashboard/static/js/core-ui.js');
    fs.mkdirSync(path.dirname(coreUiPath), { recursive: true });
    fs.writeFileSync(coreUiPath, funcTexts.join('\n\n') + '\n');

    // Remove each range from the script body (reverse order so earlier offsets stay
    // valid), then squeeze any resulting run of 3+ blank lines down to 1 blank line.
    let newBody = block.body;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const r = ordered[i];
      let end = r.end + 1;
      while (newBody[end] === '\n') end += 1; // eat the function's own trailing blank line(s)
      newBody = newBody.slice(0, r.start) + newBody.slice(end);
    }
    newBody = newBody.replace(/\n{3,}/g, '\n\n');

    const before = html.slice(0, block.bodyStart);
    const after = html.slice(block.bodyStart + block.body.length);
    const scriptSrcTag = '<script src="{{ url_for(\'static\', filename=\'js/core-ui.js\') }}"></script>\n';
    // Insert the new src= tag immediately before the (now-shorter) inline <script> tag so
    // core-ui.js's functions are defined as globals before the remaining inline code runs.
    const openTagStart = before.lastIndexOf('<script>');
    const newHtml = before.slice(0, openTagStart) + scriptSrcTag + before.slice(openTagStart) + newBody + after;
    fs.writeFileSync(htmlPath, newHtml);
    console.log(`\nWrote ${coreUiPath} (${funcTexts.length} functions) and updated ${htmlPath}.`);
  }
}

main();
