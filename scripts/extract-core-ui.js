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
// kept desyncing anyway, because a hand-rolled lexer can only ever be an approximation of
// real JS grammar.
//
// This tool instead uses Node's own built-in `vm` module -- the REAL V8 parser -- as an
// oracle: it never tries to reimplement JS tokenization at all (see module header for the
// full technique). 2026-09-07: the core locate/extract logic now lives in
// src/script-extract.js so file-decompose-to-hub.js's deterministic script-extract move
// apply can share the exact same, already-proven implementation instead of a second one
// drifting apart from this CLI over time -- this file is now a thin wrapper over it.

const fs = require('fs');
const path = require('path');
const { locateFunctions, buildExtraction } = require('../src/script-extract.js');

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const names = (args.functions || DEFAULT_FUNCTIONS).slice(0, args.limit || Infinity);
  const htmlPath = path.resolve(args.html);
  const html = fs.readFileSync(htmlPath, 'utf8');

  const located = locateFunctions(html, names);
  if (located.error) {
    console.error(located.error);
    process.exit(1);
  }
  for (const r of located.results) {
    console.log(`${r.status === 'OK' ? 'OK  ' : 'FAIL'} ${r.name}${r.status === 'OK' ? ` (lines ${r.startLine}-${r.endLine})` : `: ${r.status}`}`);
  }
  const problems = located.results.filter((r) => r.status !== 'OK');
  console.log(`\n${located.results.length - problems.length}/${located.results.length} resolved cleanly.`);

  if (problems.length > 0) {
    process.exit(1);
  }

  if (args.write) {
    // Same hardcoded Jinja tag this CLI has always inserted for its one specific
    // migration target -- preserved verbatim for anyone re-running this CLI by hand.
    // The deterministic move-apply path (file-decompose-to-hub.js) calls
    // buildExtraction() directly with no newFileUrl instead: script-extract's own
    // wiring step (a separate task) is what adds a <script src> tag there, so the move
    // step itself must not also insert one.
    const extraction = buildExtraction(html, names, {
      newFileUrl: '{{ url_for(\'static\', filename=\'js/core-ui.js\') }}',
    });
    const coreUiPath = path.resolve('python/dashboard/static/js/core-ui.js');
    fs.mkdirSync(path.dirname(coreUiPath), { recursive: true });
    fs.writeFileSync(coreUiPath, extraction.newFileContent);
    fs.writeFileSync(htmlPath, extraction.newHtml);
    console.log(`\nWrote ${coreUiPath} (${names.length} functions) and updated ${htmlPath}.`);
  }
}

main();
