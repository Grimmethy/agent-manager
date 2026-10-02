'use strict';

// Guards the browser load wiring of the dashboard's plain-<script> JS files (2026-10-01, the core-ui.js split).
// These files share one global scope with no module system, so a split is only correct if (a) every file in
// static/js is actually loaded by templates/index.html, and (b) every function the inline script reaches at
// load time is defined by a tag ABOVE that inline script. A node:test that require()s a file cannot see
// either failure -- an earlier pipeline split passed its tests while wiring the browser files with require(),
// which a <script src> page cannot run.
//
// Run: node --test python/dashboard/static/js/index-script-order.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS_DIR = __dirname;
const INDEX = path.join(JS_DIR, '..', '..', 'templates', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');

// Every <script ...> tag in document order: { src } for an external one, { inline: true } for an inline block.
function scriptTags(text) {
  const tags = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(text))) {
    const src = /\bsrc="([^"]+)"/.exec(m[1]);
    if (src) {
      const file = /(?:^|[\/'"])js\/([A-Za-z0-9_.-]+\.js)/.exec(src[1]);
      tags.push({ src: src[1], file: file ? file[1] : null });
    } else {
      tags.push({ inline: true, at: m.index });
    }
  }
  return tags;
}

const tags = scriptTags(html);
const firstInline = tags.findIndex((t) => t.inline);
const beforeInline = tags.slice(0, firstInline).filter((t) => t.file);

test('every non-test file in static/js is loaded by index.html, and every loaded file exists', () => {
  const loaded = new Set(tags.filter((t) => t.file).map((t) => t.file));
  const onDisk = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  for (const f of onDisk) assert.ok(loaded.has(f), `${f} is in static/js but no <script src> in index.html loads it`);
  for (const f of loaded) assert.ok(onDisk.includes(f), `index.html loads ${f} but it does not exist in static/js`);
});

test('every function the inline script uses at load time is defined by a script ABOVE the inline script', () => {
  assert.ok(firstInline > 0, 'expected an inline <script> after the external ones');
  // Load every external script above the inline block, in order, into ONE shared global scope (what a browser does).
  // The files hold only declarations at top level, so a bare sandbox is enough; a load-time reference to a missing
  // name would throw here.
  const ctx = vm.createContext({ console, setInterval: () => 0, setTimeout: () => 0, document: {}, window: {}, localStorage: {} });
  for (const t of beforeInline) {
    vm.runInContext(fs.readFileSync(path.join(JS_DIR, t.file), 'utf8'), ctx, { filename: t.file });
  }
  const mustExist = [
    'updateStaleTimers', 'renderWorkers', 'setWorkerModel', 'setWorkerTask', 'toggleWorkerExpand', 'renderCompletedTasksSection',
    'mountPersistentSidebarPlugins', 'sendTextToChat', 'renderClaudeSettingsPanel', 'wireClaudeSettingsPanel', 'renderClaudeUsagePanel', 'openGlobalBrainDumpModal',
    'fetchJson', 'renderNav', 'showToast', 'postTaskAction', 'renderQueueTab', 'renderPluginsTab', 'safeSourceNames',
    'wireHubSort', 'setHubPriority', 'hubTag', 'hubProgressChip', 'wireQueueSourceFilter',
    'renderPluginsTab', 'pipelineFlagBadges',
    'renderModelsTab', 'buildBenchmarkPanelHtml', 'wireBenchmarkPanel', 'buildRadarChartSvg', 'buildResponseTable', 'renderDeepDiveTab', 'renderDiscoveryTab',
  ];
  for (const name of mustExist) assert.equal(vm.runInContext(`typeof ${name}`, ctx), 'function', `${name} is not defined by the scripts above the inline block`);
  // The inline block's own load-time schedule must reference only names that exist by then.
  const inline = html.slice(tags[firstInline].at);
  for (const m of inline.matchAll(/setInterval\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
    assert.equal(vm.runInContext(`typeof ${m[1]}`, ctx), 'function', `inline script schedules ${m[1]} but nothing above defines it`);
  }
});

test('no browser-loaded file uses require() or an unguarded module.exports', () => {
  for (const t of tags.filter((x) => x.file)) {
    // full-line // comments are prose (the moved files' headers say "no require()"), not code
    const text = fs.readFileSync(path.join(JS_DIR, t.file), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /\brequire\s*\(/, `${t.file}: require() is not defined in a browser`);
    const unguarded = text.replace(/^[ \t]*if\s*\(\s*typeof\s+(?:module|exports)\b[^)]*\)[^\n]*$/gm, '');
    assert.doesNotMatch(unguarded, /\bmodule\.exports\b/, `${t.file}: module.exports outside a typeof-module guard`);
  }
});
