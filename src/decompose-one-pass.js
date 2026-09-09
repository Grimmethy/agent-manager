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

// Where the new <script src> block goes, in priority order:
//   1. immediately BEFORE the first inline <script> (one with no src=). An index.html-style
//      template runs load-time wiring inside that inline block (`setInterval(fn, ...)`,
//      `el.onclick = fn`, a DOMContentLoaded handler) that can reference a just-extracted
//      function -- so the modules that now DEFINE those functions must load first. This
//      matches how the hand-run core-ui.js extraction (commit dd43d362) wired its includes:
//      the module <script src> tags sit right above the remaining inline <script>.
//   2. otherwise, just before the final </body>, preserving its indentation.
//   3. otherwise (no </body> -- unexpected for a Jinja page), append at the end.
function spliceScriptTags(html, moves) {
  const block = moves.map((m) => scriptTagFor(m.newFile)).join('\n');
  const inline = html.match(/^([ \t]*)<script(?![^>]*\bsrc=)[^>]*>/im);
  if (inline) {
    const indent = inline[1] || '';
    const indented = block.split('\n').map((l) => indent + l).join('\n');
    return html.slice(0, inline.index) + `${indented}\n` + html.slice(inline.index);
  }
  const b = html.match(/[ \t]*<\/body>(?![\s\S]*<\/body>)/i);
  if (!b) return `${html.replace(/\s*$/, '')}\n${block}\n`;
  // b[0] is the indent + `</body>`; put the block on its own line just above it, keeping
  // that same indentation on the closing tag.
  return html.slice(0, b.index) + `${block}\n` + b[0] + html.slice(b.index + b[0].length);
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

  // Independent guard (2026-09-09 incident, parity with decompose-node-module.js): run the
  // REAL `node --check` on every extracted .js module -- a `buildExtraction` slice that
  // desynced on a template literal / regex would still return here, and neither the vm
  // oracle nor a byte-match review gate re-parses the final module as Node would.
  const { firstNodeCheckError } = require('./decompose-node-module.js');
  const parseErr = firstNodeCheckError(changes.filter((c) => c.mode === 'create' && /\.m?js$/.test(c.file)));
  if (parseErr) return { ok: false, reason: `extracted module does not pass \`node --check\` -- ${parseErr}` };

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
