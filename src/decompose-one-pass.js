'use strict';

// decompose-one-pass.js (2026-09-09, [[hub-task-integration]] / concept-hub-task-integration-549f09,
// spec Docs/hub-task-independent-merge.md Tier 1).
//
// When a file-decompose plan is FULLY MECHANICAL -- every move is a `script-extract` whose
// symbols all resolve to unambiguous top-level function declarations (validatePlan's
// `deterministicApplyOk`) -- there is no judgement left. file-decompose-to-hub.js files a
// SINGLE deterministic task instead of a stacked hub of N move children + a wiring child +
// a multi-day merge window. This module is the pure part: given the current source text,
// produce the whole split (all N new module files + the reduced source + the `<script>`
// wiring) as one Group-B change set, or bail with the exact per-symbol problems.
//
// HTML sources only for v1 -- the browser `<script src>` splice is a trivial deterministic
// string op. Plain-.js one-pass (a `require()` wiring line + placement) is a follow-up;
// until then a .js source falls through to the hub.

const path = require('path');
const { buildExtraction } = require('./script-extract.js');

function scriptTagFor(newFile) {
  // Matches what the (retired) wiring child was instructed to write:
  // `<script src="/static/js/<base>"></script>` just before </body>.
  return `<script src="/static/js/${path.basename(newFile)}"></script>`;
}

// Splice the N tags in as a block immediately before the final </body>, preserving its
// indentation. If there is no </body> (unexpected for a Jinja page), append at the end.
function spliceScriptTags(html, moves) {
  const block = moves.map((m) => scriptTagFor(m.newFile)).join('\n');
  const m = html.match(/[ \t]*<\/body>(?![\s\S]*<\/body>)/i);
  if (!m) return `${html.replace(/\s*$/, '')}\n${block}\n`;
  // m[0] is the indent + `</body>`; put the block on its own line just above it, keeping
  // that same indentation on the closing tag.
  return html.slice(0, m.index) + `${block}\n` + m[0] + html.slice(m.index + m[0].length);
}

/**
 * @param {string} sourceText  current content of the source file
 * @param {string} sourceFile  repo-relative path (must be .html/.htm for v1)
 * @param {Array<{newFile:string, symbols:string[]}>} moves
 * @returns {{ ok:true, changes:Array }|{ ok:false, reason:string, problems?:Array }}
 *   changes: [{mode:'create',file,content}...N, {mode:'edit',file:sourceFile,find:sourceText,replace:finalHtml}]
 */
function buildOnePassGroupBChanges(sourceText, sourceFile, moves) {
  if (!/\.html?$/i.test(sourceFile)) {
    return { ok: false, reason: 'one-pass decompose is HTML-only for now; a .js source falls through to the hub' };
  }
  if (!Array.isArray(moves) || moves.length < 2) {
    return { ok: false, reason: 'need >= 2 moves' };
  }
  const changes = [];
  let cur = sourceText;
  for (const move of moves) {
    if (!move || !move.newFile || !Array.isArray(move.symbols) || !move.symbols.length) {
      return { ok: false, reason: `move for ${move && move.newFile} has no symbols` };
    }
    const ex = buildExtraction(cur, move.symbols, { isHtml: true });
    if (!ex.ok) {
      return {
        ok: false,
        reason: `symbols no longer resolve cleanly for ${move.newFile}: ${(ex.problems || []).map((p) => `${p.name}: ${p.status}`).join('; ')}`,
        problems: ex.problems || [],
      };
    }
    changes.push({ mode: 'create', file: move.newFile, content: ex.newFileContent });
    cur = ex.newHtml; // buildExtraction returns the reduced HTML; symbols now gone from `cur`
  }
  const finalHtml = spliceScriptTags(cur, moves);
  changes.push({ mode: 'edit', file: sourceFile, find: sourceText, replace: finalHtml });
  return { ok: true, changes };
}

// Is this request eligible for the one-pass path? Caller passes file-decompose-to-hub.js's
// validatePlan() result. Kept here so file-decompose-to-hub.js and tests share one rule.
function planIsFullyMechanicalHtml(request, validation) {
  if (process.env.AGENT_MANAGER_DECOMPOSE_ONE_PASS === 'false') return false;
  if (!request || !/\.html?$/i.test(request.sourceFile || '')) return false;
  const moves = request.moves || [];
  if (moves.length < 2) return false;
  if (!moves.every((m) => m.kind === 'script-extract')) return false;
  const meta = (validation && validation.moveMeta) || [];
  return moves.every((_, i) => meta[i] && meta[i].deterministicApplyOk === true);
}

module.exports = { buildOnePassGroupBChanges, spliceScriptTags, scriptTagFor, planIsFullyMechanicalHtml };
