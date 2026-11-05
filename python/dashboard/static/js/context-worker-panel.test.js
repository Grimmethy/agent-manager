'use strict';

// buildContextWorkerHtml / renderContextWorkerSection (context-worker-panel.js): a plain global <script> of pure string builders, loaded into a bare vm context like
// needswork-worker-panel.test.js. Run: node --test python/dashboard/static/js/context-worker-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const NOW = Date.parse('2026-11-04T12:00:00Z');
function load() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'context-worker-panel.js'), 'utf8'), ctx, { filename: 'context-worker-panel.js' });
  return ctx;
}
const lit = (a) => (a === undefined ? 'undefined' : JSON.stringify(a));
const call = (fn, ...args) => vm.runInContext(`${fn}(${args.map(lit).join(',')})`, load());
const build = (p) => call('buildContextWorkerHtml', p, NOW);
const section = (m, k) => call('renderContextWorkerSection', m, k, NOW);
const buildOpen = (p) => { const ctx = load(); vm.runInContext(`contextWorkerExpanded.${p.name} = true`, ctx); return vm.runInContext(`buildContextWorkerHtml(${JSON.stringify(p)}, ${NOW})`, ctx); };
// the text a person sees: tags removed, tooltips (title="...") gone with the tags
const visible = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

const hold = (n, over = {}) => ({ question: `Question ${n}?`, recommendation: `Answer ${n}`, at: '2026-11-04T11:00:00Z', ageS: 3600, ...over });
const mapPayload = (over = {}) => ({
  configured: true, name: 'map', worker: 'context-map', mode: 'dry-run', enabled: true, switch: { disabled: false, disabledAt: null },
  trigger: { state: 'listening', checkedAgeS: 12, endedAgeS: 90, stopped: 'idle' }, lastTickAt: '2026-11-04T11:58:00Z', lastTickAgeS: 125,
  today: { decisions: 0, byOutcome: {}, dryRun: { decisions: 2, byOutcome: { 'FILE-TASK': 2 } } }, actedToday: 0, decisions: 4,
  lastDecision: { at: '2026-11-04T11:48:00Z', outcome: 'FILE-TASK', mode: 'dry-run', executed: false, summary: '14 findings (0 fix, 14 rewrite)' },
  holdCount: 0, holds: [], errors: { count: 0, last: null },
  findings: { hash: 'abcdef0123456789abcdef', findings: 14, fixRanges: 0, rewriteRows: 14, suggestions: { anchors: 5, rows: 326 }, at: '2026-11-04T11:48:00Z' },
  recent: [{ at: '2026-11-04T11:48:00Z', outcome: 'FILE-TASK', mode: 'dry-run', executed: false, summary: '14 findings (0 fix, 14 rewrite)' }], ...over,
});
const memPayload = (over = {}) => ({
  ...mapPayload(), name: 'memory', worker: 'context-memory', findings: null,
  lastDecision: { at: '2026-11-04T11:50:00Z', outcome: 'OVER-BUDGET', mode: 'dry-run', executed: false, summary: 'OVER-BUDGET, DANGLING, LONG-ENTRIES' },
  today: { decisions: 0, byOutcome: {}, dryRun: { decisions: 1, byOutcome: { 'OVER-BUDGET': 1 } } }, ...over,
});

test('nothing is drawn unless the worker has left a trace, for either card and for the section', () => {
  for (const p of [null, undefined, {}, { configured: false }]) assert.equal(build(p), '');
  assert.equal(section({ configured: false }, { configured: false }), '');
  assert.equal(section(null, undefined), '');
  assert.equal(section({ configured: false }, memPayload()), build(memPayload()));
  assert.equal(section(mapPayload(), { configured: false }), build(mapPayload()));
});

test('the section is the map card then the memory card, each with its own id and title', () => {
  const s = section(mapPayload(), memPayload());
  assert.ok(s.indexOf('id="context-map-worker-panel"') >= 0 && s.indexOf('id="context-memory-worker-panel"') > s.indexOf('id="context-map-worker-panel"'));
  assert.match(s, /🗺 Context map worker/);
  assert.match(s, /🧠 Context memory worker/);
  assert.equal((s.match(/class="worker-card clickable/g) || []).length, 2);
});

test('the card uses the existing classes and never forks the lane template', () => {
  const h = build(mapPayload());
  assert.match(h, /^<div id="context-map-worker-panel" class="worker-card clickable" data-context-expand="map" aria-expanded="false">/);
  assert.match(h, /<div class="row"><span class="id">/);
  assert.match(h, /<div class="badge-col">/);
  assert.match(h, /<span class="state-timer">last tick 2m ago<\/span>/);
  assert.match(h, /<div class="meta">0 acted today/);
});

test('the mode badge: dry-run is shown plainly as DRY RUN, on is live, off is off, no mode is "no runs yet"', () => {
  assert.match(build(mapPayload({ mode: 'dry-run' })), /badge hold" title="DRY RUN[^"]*">DRY RUN</);
  assert.match(build(mapPayload({ mode: 'on' })), /badge ok" title="[^"]*">live</);
  assert.match(build(mapPayload({ mode: 'off' })), /badge idle" title="[^"]*">off</);
  assert.match(build(mapPayload({ mode: null })), />no runs yet</);
});

test('a switched-off worker says "switched off" (no error styling), dims the card and offers Turn on', () => {
  const h = build(mapPayload({ switch: { disabled: true, disabledAt: '2026-11-04T10:00:00Z' }, enabled: false, mode: 'dry-run' }));
  assert.match(h, />switched off</);
  assert.match(h, /since 2026-11-04T10:00:00Z/);
  assert.doesNotMatch(h, />DRY RUN</);
  assert.doesNotMatch(h, /badge err|badge bad|>error</);
  assert.match(h, /class="worker-card clickable worker-off"/);
  assert.match(h, /data-next-enabled="true"[^>]*>⏻ Turn on</);
  const on = build(mapPayload());
  assert.match(on, /data-next-enabled="false"[^>]*>⏻ Turn off</);
  assert.doesNotMatch(on, /worker-off/);
});

test('the Turn off / Turn on button carries the worker name and a per-worker title', () => {
  assert.match(build(mapPayload()), /context-worker-switch-btn" data-worker="map" data-next-enabled="false" title="Switch the codebase-map worker off/);
  assert.match(build(memPayload()), /data-worker="memory" data-next-enabled="false" title="Switch the memory-index worker off/);
  assert.match(build(memPayload({ switch: { disabled: true } })), /title="Switch the memory-index worker back on/);
});

test('trigger badge states come through, and a silent heartbeat does not hide a live drain', () => {
  const b = (t) => build(mapPayload({ trigger: t }));
  assert.match(b({ state: 'listening', checkedAgeS: 9999 }), />listening</);
  assert.match(b({ state: 'draining', checkedAgeS: 9999 }), />draining</);
  assert.match(b({ state: 'idle', checkedAgeS: 400 }), />trigger silent</);
  assert.match(b({ state: 'idle', checkedAgeS: 300 }), />trigger on</);                       // exactly 300 s is not silent
  assert.match(b({ state: 'backlog', checkedAgeS: 5 }), />backlog</);
  assert.match(b({ state: 'idle', checkedAgeS: 5 }), />trigger on</);
  assert.match(b(null), />no trigger yet</);
  assert.match(b({ state: 'listening', checkedAgeS: 12 }), /trigger checked 12s ago/);
  assert.doesNotMatch(b(null), /trigger checked/);
});

test('badge colours: listening, draining, trigger on and live are ok; silent, backlog and no trigger are warnings; DRY RUN is a hold, off and switched off are idle', () => {
  const b = (o) => build(mapPayload(o));
  assert.match(b({ trigger: { state: 'listening', checkedAgeS: 5 } }), /badge ok"[^>]*>listening</);
  assert.match(b({ trigger: { state: 'draining', checkedAgeS: 5 } }), /badge ok"[^>]*>draining</);
  assert.match(b({ trigger: { state: 'idle', checkedAgeS: 5 } }), /badge ok"[^>]*>trigger on</);
  assert.match(b({ trigger: { state: 'idle', checkedAgeS: 400 } }), /badge warn"[^>]*>trigger silent</);
  assert.match(b({ trigger: { state: 'backlog', checkedAgeS: 5 } }), /badge warn"[^>]*>backlog</);
  assert.match(b({ trigger: null }), /badge warn"[^>]*>no trigger yet</);
  assert.match(b({ mode: 'on' }), /badge ok"[^>]*>live</);
  assert.match(b({ mode: 'dry-run' }), /badge hold"[^>]*>DRY RUN</);
  assert.match(b({ mode: 'off' }), /badge idle"[^>]*>off</);
  assert.match(b({ switch: { disabled: true } }), /badge idle"[^>]*>switched off</);
});

test('today: acted outcomes first, their dry-run twins marked as not acted, three shown and "+n more" only when n > 0', () => {
  const p = mapPayload({ today: { decisions: 3, byOutcome: { 'NOTHING-TO-FIX': 1, 'FILE-TASK': 2 }, dryRun: { decisions: 5, byOutcome: { 'FILE-TASK': 4, 'HOLD-FOR-OWNER': 1 } } }, actedToday: 3 });
  const t = visible(build(p));
  assert.ok(t.includes('today: FILE-TASK 2 · NOTHING-TO-FIX 1 · FILE-TASK 4 (dry run, not acted) +1 more'), t);
  assert.match(build(p), /3 acted today/);
  const three = visible(build(mapPayload({ today: { byOutcome: { A: 1, B: 1 }, dryRun: { byOutcome: { C: 1 } } } })));
  assert.ok(three.includes('today: A 1 · B 1 · C 1 (dry run, not acted) ') || three.endsWith('C 1 (dry run, not acted) '), three);
  assert.doesNotMatch(three, /\+0 more|more/);
  assert.match(visible(build(mapPayload({ today: { byOutcome: {}, dryRun: { byOutcome: {} } } }))), /today: no decisions today/);
  assert.match(visible(build(mapPayload({ today: undefined }))), /no decisions today/);
  assert.match(visible(buildOpen(p)), /Today FILE-TASK 2 · NOTHING-TO-FIX 1 · FILE-TASK 4 \(dry run, not acted\) · HOLD-FOR-OWNER 1 \(dry run, not acted\)/);
});

test('the last decision shows its outcome, DRY RUN marking, age and summary; an acted one has no marking; none draws nothing', () => {
  const t = visible(build(mapPayload()));
  assert.ok(t.includes('last decision: FILE-TASK (DRY RUN, not acted) 12m ago: 14 findings (0 fix, 14 rewrite)'), t);
  const acted = visible(build(mapPayload({ lastDecision: { at: '2026-11-04T11:59:30Z', outcome: 'FILE-TASK', mode: 'on', executed: true, summary: 'filed' } })));
  assert.ok(acted.includes('last decision: FILE-TASK 30s ago: filed'), acted);
  assert.doesNotMatch(acted, /DRY RUN, not acted\) 30s/);
  assert.doesNotMatch(build(mapPayload({ lastDecision: null })), /last decision/);
  assert.ok(visible(build(mapPayload({ lastDecision: { at: 'garbage', outcome: 'OK', mode: 'on', executed: true } }))).includes('last decision: OK'));
  assert.doesNotMatch(visible(build(mapPayload({ lastDecision: { at: 'garbage', outcome: 'OK', mode: 'on', executed: true } }))), /ago:|NaN/);
  assert.match(visible(build(mapPayload({ lastDecision: { at: '2026-11-04T11:00:00Z', outcome: 'FILE-TASK', mode: 'on', executed: false, summary: 'x' } }))), /DRY RUN, not acted/);   // executed:false is dry too
});

test('a summary that only repeats the outcome is left out, in the last decision and in the recent list', () => {
  const same = { at: '2026-11-04T11:50:00Z', outcome: 'HOLD-FOR-OWNER', mode: 'dry-run', executed: false, summary: 'HOLD-FOR-OWNER' };
  const t = visible(buildOpen(mapPayload({ lastDecision: same, recent: [same] })));
  assert.ok(t.includes('last decision: HOLD-FOR-OWNER (DRY RUN, not acted) 10m ago '), t);
  assert.doesNotMatch(t, /ago: HOLD-FOR-OWNER/);
  assert.ok(t.includes('11:50 · HOLD-FOR-OWNER · DRY RUN, not acted '), t);
  assert.doesNotMatch(t, /not acted · HOLD-FOR-OWNER/);
});

test('dry-run marking follows the mode OR executed:false, in the last decision and in the recent list; a real acted decision has none', () => {
  const dryOnly = { at: '2026-11-04T11:50:00Z', outcome: 'FILE-TASK', mode: 'dry-run', executed: true, summary: 's' };
  const noExec = { at: '2026-11-04T11:50:00Z', outcome: 'FILE-TASK', mode: 'on', executed: false, summary: 's' };
  const real = { at: '2026-11-04T11:50:00Z', outcome: 'FILE-TASK', mode: 'on', executed: true, summary: 's' };
  for (const d of [dryOnly, noExec]) {
    const t = visible(buildOpen(mapPayload({ lastDecision: d, recent: [d] })));
    assert.ok(t.includes('last decision: FILE-TASK (DRY RUN, not acted)'), t);
    assert.ok(t.includes('11:50 · FILE-TASK · DRY RUN, not acted · s'), t);
  }
  const t = visible(buildOpen(mapPayload({ lastDecision: real, recent: [real] })));
  assert.doesNotMatch(t, /DRY RUN, not acted/);
});

test('guards: findings that are not an object and an error count of zero draw nothing', () => {
  assert.doesNotMatch(build(mapPayload({ findings: 'oops' })), /rows to rewrite|map: /);
  assert.doesNotMatch(build(mapPayload({ findings: 5 })), /rows to rewrite/);
  assert.doesNotMatch(build(mapPayload({ errors: { count: 0, last: { at: 'x', error: 'old' } } })), /badge warn">error/);
});

test('the map card shows the findings line; the memory card does not; singular forms; the uncited count is in the tooltip', () => {
  const h = build(mapPayload());
  assert.ok(visible(h).includes('map: 14 rows to rewrite, 0 fixes, 5 suggestions'));
  assert.match(h, /title="Findings abcdef012345 · 326 source files are not cited by the map"/);
  assert.ok(visible(build(mapPayload({ findings: { hash: 'h', rewriteRows: 1, fixRanges: 1, suggestions: { anchors: 1, rows: 0 } } }))).includes('map: 1 row to rewrite, 1 fix, 1 suggestion'));
  assert.doesNotMatch(build(mapPayload({ findings: { hash: 'h', rewriteRows: 0, fixRanges: 0, suggestions: { anchors: 0, rows: 0 } } })), /source files are not cited/);
  assert.doesNotMatch(build(memPayload()), /map: |rows to rewrite/);
  assert.doesNotMatch(build(mapPayload({ findings: null })), /rows to rewrite/);
  assert.ok(visible(build(mapPayload({ findings: { hash: 'h', rewriteRows: 1234, fixRanges: 0, suggestions: undefined } }))).includes('1,234 rows to rewrite, 0 fixes, 0 suggestions'));
});

test('no holds draws no question rows and no empty box; exactly two show both and no "more"', () => {
  assert.doesNotMatch(build(mapPayload()), /badge warn">question/);
  assert.doesNotMatch(build(mapPayload()), /margin-top:6px"><\/div>/);
  const two = build(mapPayload({ holdCount: 2, holds: [hold(1), hold(2)] }));
  assert.equal((two.match(/badge warn">question</g) || []).length, 2);
  assert.doesNotMatch(two, /more waiting/);
  assert.doesNotMatch(two, /\+0 more/);
});

test('three holds show two on the collapsed card and "+1 more waiting"; the open card shows all three', () => {
  const p = mapPayload({ holdCount: 3, holds: [hold(1), hold(2), hold(3)] });
  const closed = build(p);
  assert.equal((closed.match(/badge warn">question</g) || []).length, 2);
  assert.match(closed, /\+1 more waiting/);
  const open = buildOpen(p);
  assert.equal((open.match(/badge warn">question</g) || []).length, 3);
  assert.doesNotMatch(open, /more waiting/);
});

test('the "more" count uses holdCount when the payload was capped', () => {
  assert.match(build(mapPayload({ holdCount: 60, holds: [hold(1), hold(2), hold(3)] })), /\+58 more waiting/);
});

test('a hold shows the question first and the recommendation under it, with age; a missing recommendation draws no arrow', () => {
  const h = build(mapPayload({ holdCount: 1, holds: [hold(1)] }));
  assert.ok(h.indexOf('Question 1?') < h.indexOf('Answer 1'));
  assert.match(h, /Question 1\?<br>→ Answer 1 · 1h 0m<\/div>/);
  const noRec = build(mapPayload({ holdCount: 1, holds: [hold(1, { recommendation: null, ageS: null })] }));
  assert.doesNotMatch(noRec, /→|<br>/);
  assert.doesNotMatch(noRec, /null|undefined/);
});

test('a question is cut at 90 characters with an ellipsis and the full text and recommendation in the tooltip; exactly 90 is not cut (title stripped before asserting visible text)', () => {
  const long = 'Q'.repeat(120);
  const h = build(mapPayload({ holdCount: 1, holds: [hold(1, { question: long, recommendation: 'R'.repeat(120) })] }));
  assert.ok(h.includes('title="' + long + ' — Recommended: ' + 'R'.repeat(120) + '"'));
  const shown = visible(h);
  assert.ok(shown.includes('question ' + 'Q'.repeat(89) + '… → ' + 'R'.repeat(89) + '…'), shown);
  assert.ok(!shown.includes('Q'.repeat(90)));
  const exact = visible(build(mapPayload({ holdCount: 1, holds: [hold(1, { question: 'Q'.repeat(90), recommendation: 'R'.repeat(90) })] })));
  assert.ok(exact.includes('question ' + 'Q'.repeat(90) + ' → ' + 'R'.repeat(90) + ' '));
  assert.ok(!exact.includes('…'));
  const ninetyOne = visible(build(mapPayload({ holdCount: 1, holds: [hold(1, { question: 'Q'.repeat(91) })] })));
  assert.ok(ninetyOne.includes('Q'.repeat(89) + '…'));
});

test('the last error shows its count (singular and plural), a cut message and the full message in the tooltip', () => {
  const one = build(mapPayload({ errors: { count: 1, last: { at: '2026-11-04T11:55:00Z', error: 'queue refused' } } }));
  assert.ok(visible(one).includes('error 1 error, last: queue refused'));
  const many = build(mapPayload({ errors: { count: 3, last: { at: 'x', error: 'E'.repeat(120) } } }));
  assert.ok(visible(many).includes('3 errors, last: ' + 'E'.repeat(89) + '…'));
  assert.ok(many.includes('title="' + 'E'.repeat(120) + '"'));
  assert.ok(visible(build(mapPayload({ errors: { count: 1, last: { at: 'x', error: '' } } }))).includes('last: no message'));
  assert.doesNotMatch(build(mapPayload({ errors: { count: 0, last: null } })), /badge warn">error/);
  assert.doesNotMatch(build(mapPayload({ errors: undefined })), /badge warn">error/);
  assert.doesNotMatch(build(mapPayload({ errors: { count: 2, last: null } })), /badge warn">error/);
});

test('the open card lists the recent decisions with the DRY RUN marking; the closed card does not; the toggle text and count follow the state', () => {
  const closed = build(mapPayload());
  assert.doesNotMatch(closed, /Recent decisions/);
  assert.match(closed, /▸ Show decisions \(4 in the ledger\)/);
  const open = buildOpen(mapPayload());
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /▾ Hide decisions/);
  assert.ok(visible(open).includes('Recent decisions 11:48 · FILE-TASK · DRY RUN, not acted · 14 findings (0 fix, 14 rewrite)'));
  assert.ok(visible(buildOpen(mapPayload({ recent: [] }))).includes('No decisions recorded yet.'));
  assert.doesNotMatch(buildOpen(mapPayload({ recent: [{ at: '2026-11-04T11:48:00Z', outcome: 'FILE-TASK', mode: 'on', executed: true, summary: 'filed' }] })), /DRY RUN, not acted · filed/);
  assert.doesNotMatch(build(mapPayload({ decisions: undefined })), /in the ledger/);
});

test('the two cards expand independently', () => {
  const ctx = load();
  vm.runInContext('contextWorkerExpanded.memory = true', ctx);
  const s = vm.runInContext(`renderContextWorkerSection(${JSON.stringify(mapPayload())}, ${JSON.stringify(memPayload())}, ${NOW})`, ctx);
  assert.match(s, /id="context-map-worker-panel"[^>]*aria-expanded="false"/);
  assert.match(s, /id="context-memory-worker-panel"[^>]*aria-expanded="true"/);
});

test('everything from the payload is escaped, including an HTML-looking question, recommendation, summary, error and outcome', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const h = buildOpen(mapPayload({
    holdCount: 1, holds: [hold(1, { question: evil, recommendation: '"><script>x</script>' })],
    lastDecision: { at: '2026-11-04T11:48:00Z', outcome: '<u>o</u>', mode: 'dry-run', executed: false, summary: '<em>why</em>' },
    errors: { count: 1, last: { at: 'x', error: '<s>bad</s>' } }, switch: { disabled: true, disabledAt: '<b>t</b>' },
    today: { byOutcome: { '<i>k</i>': 1 }, dryRun: { byOutcome: { '<p>d</p>': 1 } } },
    findings: { hash: '<h>', rewriteRows: 1, fixRanges: 0, suggestions: { anchors: 0, rows: 3 } },
    recent: [{ at: '2026-11-04T11:48:00Z', outcome: '<a>x</a>', mode: 'on', executed: true, summary: '<q>s</q>' }],
  }));
  assert.doesNotMatch(h, /<img|<script|<u>|<em>|<s>|<b>|<i>|<p>|<h>|<a>|<q>/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(h, /&quot;&gt;&lt;script&gt;/);
});

test('no inline font size below 12px is introduced', () => {
  const html = buildOpen(mapPayload({ holdCount: 1, holds: [hold(1)], errors: { count: 1, last: { at: 'x', error: 'e' } } }));
  const sizes = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.every((n) => n >= 12), `font sizes ${sizes}`);
  assert.ok(!/font-size:\s*(?:[0-9]|1[01])px/.test(fs.readFileSync(path.join(__dirname, 'context-worker-panel.js'), 'utf8')));
});

test('age helpers: seconds, minutes, hours, days; unknown and negative give nothing', () => {
  const age = (s) => call('contextWorkerAge', s);
  assert.deepEqual([age(0), age(45), age(59), age(60), age(125), age(7300), age(172799), age(172800), age(200000)], ['0s', '45s', '59s', '1m', '2m', '2h 1m', '47h 59m', '2d 0h', '2d 7h']);
  assert.deepEqual([age(-1), age(null), age('x'), age(NaN)].map(String), ['', '', '', '']);
  const since = (iso, now) => call('contextWorkerAgeSince', iso, now);
  assert.equal(since('2026-11-04T11:00:00Z', NOW), 3600);
  assert.equal(since('2026-11-04T13:00:00Z', NOW), 0);
  assert.equal(since('garbage', NOW), null);
  assert.equal(since('2026-11-04T11:00:00Z', null), null);
});

test('the wiring helpers exist as plain globals and the scripts are loaded by index.html and used by workers-tab.js', () => {
  const ctx = load();
  for (const fn of ['renderContextWorkerSection', 'buildContextWorkerHtml', 'wireContextWorkerSwitch', 'wireContextWorkerExpand', 'setContextWorkerEnabled']) assert.equal(vm.runInContext(`typeof ${fn}`, ctx), 'function', fn);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/static/js/needswork-worker-panel.js') < html.indexOf('/static/js/context-worker-panel.js'));
  const tab = fs.readFileSync(path.join(__dirname, 'workers-tab.js'), 'utf8');
  assert.match(tab, /fetchJson\('\/api\/context-worker\/map'\)\.catch\(\(\) => null\)/);
  assert.match(tab, /fetchJson\('\/api\/context-worker\/memory'\)\.catch\(\(\) => null\)/);
  assert.match(tab, /fetchJson\('\/api\/context-worker\/impact'\)\.catch\(\(\) => null\)/);
  assert.match(tab, /renderContextWorkerSection\(contextMapWorker, contextMemoryWorker, Date\.now\(\), contextImpactWorker\)/);
  assert.match(tab, /wireContextWorkerSwitch\(main\)/);
  assert.match(tab, /wireContextWorkerExpand\(main, renderWorkers\)/);
});

test('setContextWorkerEnabled posts to the worker\'s own route, redraws on success and toasts the reason on failure', async () => {
  const calls = []; const toasts = []; let redraws = 0;
  const ctx = vm.createContext({
    fetch: async (url, init) => { calls.push([url, init]); return ctx.nextResponse; },
    showToast: (m) => toasts.push(m), renderWorkers: async () => { redraws += 1; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'context-worker-panel.js'), 'utf8'), ctx);
  ctx.nextResponse = { ok: true, status: 200, json: async () => ({}) };
  assert.equal(await vm.runInContext('setContextWorkerEnabled("memory", false)', ctx), true);
  assert.deepEqual([calls[0][0], calls[0][1].method, calls[0][1].body], ['/api/context-worker/memory/enabled', 'POST', '{"enabled":false}']);
  assert.equal(redraws, 1);
  ctx.nextResponse = { ok: false, status: 400, json: async () => ({ error: 'body must be {"enabled": true|false}' }) };
  assert.equal(await vm.runInContext('setContextWorkerEnabled("map", true)', ctx), false);
  assert.match(toasts[0], /Could not switch the Context map worker on: body must be/);
  ctx.nextResponse = { ok: false, status: 500, json: async () => { throw new Error('no json'); } };
  assert.equal(await vm.runInContext('setContextWorkerEnabled("map", true)', ctx), false);
  assert.match(toasts[1], /: HTTP 500$/);
  ctx.fetch = async () => { throw new Error('offline'); };
  assert.equal(await vm.runInContext('setContextWorkerEnabled("map", false)', ctx), false);
  assert.match(toasts[2], /Could not switch the Context map worker off: offline/);
  assert.equal(redraws, 1);
});

function fakeRoot(selector, items) { return { querySelectorAll: (s) => (s === selector ? items : []) }; }

test('wireContextWorkerSwitch: a click stops propagation, disables the button, posts the NEXT state for that worker, and re-enables it only on failure', async () => {
  const calls = []; const toasts = [];
  const ctx = vm.createContext({ fetch: async (url, init) => { calls.push([url, init.body]); return ctx.nextResponse; }, showToast: (m) => toasts.push(m), renderWorkers: async () => {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'context-worker-panel.js'), 'utf8'), ctx);
  const mk = (worker, next) => ({ dataset: { worker, nextEnabled: next }, disabled: false, onclick: null });
  const turnOn = mk('map', 'true'); const turnOff = mk('memory', 'false');
  ctx.root = fakeRoot('.context-worker-switch-btn', [turnOn, turnOff]);
  vm.runInContext('wireContextWorkerSwitch(root)', ctx);
  assert.equal(typeof turnOn.onclick, 'function');
  let stopped = 0;
  ctx.nextResponse = { ok: true, status: 200, json: async () => ({}) };
  await turnOn.onclick({ stopPropagation: () => { stopped += 1; } });
  assert.deepEqual(calls[0], ['/api/context-worker/map/enabled', '{"enabled":true}']);
  assert.equal(stopped, 1);
  assert.equal(turnOn.disabled, true);                                              // success: the redraw replaces the button, so it stays disabled
  ctx.nextResponse = { ok: false, status: 500, json: async () => ({ error: 'disk full' }) };
  await turnOff.onclick({ stopPropagation: () => { stopped += 1; } });
  assert.deepEqual(calls[1], ['/api/context-worker/memory/enabled', '{"enabled":false}']);
  assert.equal(turnOff.disabled, false);                                            // failure: usable again
  assert.match(toasts[0], /disk full/);
  assert.equal(stopped, 2);
});

test('wireContextWorkerExpand: a click flips only that card and redraws; a second click closes it again', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'context-worker-panel.js'), 'utf8'), ctx);
  const mapCard = { dataset: { contextExpand: 'map' }, onclick: null }; const memCard = { dataset: { contextExpand: 'memory' }, onclick: null };
  let redraws = 0;
  ctx.root = fakeRoot('[data-context-expand]', [mapCard, memCard]); ctx.redraw = () => { redraws += 1; };
  vm.runInContext('wireContextWorkerExpand(root, redraw)', ctx);
  mapCard.onclick();
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(contextWorkerExpanded)', ctx)), { map: true, memory: false, impact: false });
  mapCard.onclick();
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(contextWorkerExpanded)', ctx)), { map: false, memory: false, impact: false });
  memCard.onclick();
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(contextWorkerExpanded)', ctx)), { map: false, memory: true, impact: false });
  assert.equal(redraws, 3);
});

const impPayload = (over = {}) => ({
  ...mapPayload(), name: 'impact', worker: 'context-impact', findings: null, lastDecision: { at: '2026-11-04T11:50:00Z', outcome: 'REGRESSED', mode: 'dry-run', executed: false, summary: '1 regressed' },
  impact: {
    latest: { at: '2026-11-04T11:50:00Z', regressed: ['pipeline.firstPassApproval'], improved: ['map.staleCitations'], insufficient: ['state.friction', 'pipeline.redrafts'], wouldFile: ['pipeline.firstPassApproval'] },
    filedCount: 4, filed: [{ taskId: 't-1' }, { taskId: 't-2' }, { taskId: 't-3' }, { taskId: 't-4' }],
    interventions: { 'map-edit': { HELPED: 2, 'NO-EFFECT': 1, HARMED: 0, open: 1 }, 'memory-edit': { HELPED: 0, 'NO-EFFECT': 0, HARMED: 1, open: 0 } },
    gate: { open: false, evaluated: 3, helped: 2 },
  }, ...over,
});

test('the impact card: own id, title and icon, third in the section, and the section still works with three arguments', () => {
  const h = build(impPayload());
  assert.match(h, /^<div id="context-impact-worker-panel" class="worker-card clickable" data-context-expand="impact" aria-expanded="false">/);
  assert.match(h, /📈 Context impact worker/);
  const s = call('renderContextWorkerSection', mapPayload(), memPayload(), NOW, impPayload());
  assert.ok(s.indexOf('context-map-worker-panel') < s.indexOf('context-memory-worker-panel') && s.indexOf('context-memory-worker-panel') < s.indexOf('context-impact-worker-panel'));
  assert.equal(section(mapPayload(), memPayload()), build(mapPayload()) + build(memPayload()));
  assert.equal(call('renderContextWorkerSection', { configured: false }, { configured: false }, NOW, { configured: false }), '');
  assert.match(visible(build(impPayload({ switch: { disabled: false } }))), /Turn off/);
});

test('the impact card collapsed shows counts, filed count and the closed gate; no list lines', () => {
  const t = visible(build(impPayload()));
  assert.match(t, /impact: 1 regressed, 1 improved, 2 channels short of data · pipeline\.firstPassApproval/);
  assert.match(t, /4 investigation tasks filed · authority gate closed \(3 map edits evaluated, 2 helped\)/);
  assert.doesNotMatch(t, /dry run: would file|not enough data|filed: |map-edit 2 helped/);
  assert.match(visible(build(impPayload({ impact: { ...impPayload().impact, gate: { open: true, evaluated: 1, helped: 1 }, filedCount: 1 } }))), /1 investigation task filed · authority gate OPEN \(1 map edit evaluated, 1 helped\)/);
});

test('the impact card opened lists improved, thin channels, would-file, newest filed ids and both intervention kinds', () => {
  const t = visible(buildOpen(impPayload()));
  assert.match(t, /improved: map\.staleCitations/);
  assert.match(t, /not enough data: state\.friction, pipeline\.redrafts/);
  assert.match(t, /dry run: would file 1 investigation task: pipeline\.firstPassApproval/);
  assert.match(t, /filed: t-2, t-3, t-4 \(newest 3 of 4\)/);
  assert.doesNotMatch(t, /filed: t-1/);
  assert.match(t, /map-edit 2 helped \/ 1 no effect \/ 0 harmed \/ 1 waiting/);
  assert.match(t, /memory-edit 0 helped \/ 0 no effect \/ 1 harmed \/ 0 waiting/);
});

test('the impact section is missing, empty or malformed: nothing breaks and nothing invented is drawn', () => {
  for (const imp of [undefined, null, 'x', 7]) assert.doesNotMatch(visible(build(impPayload({ impact: imp }))), /impact: |authority gate/);
  const t = visible(buildOpen(impPayload({ impact: { latest: null, filedCount: 'many', filed: 'no', interventions: null, gate: null } })));
  assert.match(t, /impact: no decision yet/);
  assert.match(t, /0 investigation tasks filed · authority gate closed \(0 map edits evaluated, 0 helped\)/);
  assert.match(t, /map-edit 0 helped \/ 0 no effect \/ 0 harmed \/ 0 waiting/);
  assert.doesNotMatch(t, /undefined|NaN|\[object/);
});

test('impact text from the payload is escaped, and the map and memory cards never show impact lines', () => {
  const h = buildOpen(impPayload({ impact: { ...impPayload().impact, latest: { regressed: ['<img src=x onerror=1>'], improved: ['<b>'], insufficient: [], wouldFile: [] }, filed: [{ taskId: '<script>' }] } }));
  assert.doesNotMatch(h, /<img|<script>|<b>/);
  assert.match(h, /&lt;img/);
  assert.doesNotMatch(visible(build(mapPayload({ impact: impPayload().impact }))), /authority gate/);
  assert.doesNotMatch(visible(build(memPayload({ impact: impPayload().impact }))), /authority gate/);
});

test('the impact lists show at most three names and say how many more; exactly three show no suffix', () => {
  const five = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const t = visible(buildOpen(impPayload({ impact: { ...impPayload().impact, latest: { regressed: five, improved: five, insufficient: five, wouldFile: five } } })));
  assert.match(t, /impact: 5 regressed, 5 improved, 5 channels short of data · a1, a2, a3 \+2 more/);
  assert.match(t, /improved: a1, a2, a3 \+2 more/);
  assert.match(t, /not enough data: a1, a2, a3 \+2 more/);
  assert.match(t, /would file 5 investigation tasks: a1, a2, a3 \+2 more/);
  const three = ['a1', 'a2', 'a3'];
  const u = visible(buildOpen(impPayload({ impact: { ...impPayload().impact, latest: { regressed: three, improved: three, insufficient: three, wouldFile: three } } })));
  assert.match(u, /a1, a2, a3/);
  assert.doesNotMatch(u, /more/);
});

test('the impact card keeps each verdict count apart, rounds a fractional filed count down and cuts a very long name', () => {
  const t = visible(buildOpen(impPayload({ impact: { ...impPayload().impact, filedCount: 2.7, interventions: { 'map-edit': { HELPED: 5, 'NO-EFFECT': 6, HARMED: 7, open: 8 }, 'memory-edit': {} } } })));
  assert.match(t, /map-edit 5 helped \/ 6 no effect \/ 7 harmed \/ 8 waiting/);
  assert.match(t, /^.*\b2 investigation tasks filed/);
  const long = 'x'.repeat(100);
  const u = visible(buildOpen(impPayload({ impact: { ...impPayload().impact, latest: { regressed: [long], improved: [], insufficient: [], wouldFile: [] }, filed: [{ taskId: long }] } })));
  assert.doesNotMatch(u, /x{60}/);
  assert.match(u, /x{10}/);
});

test('an unknown payload name falls back to the map card instead of throwing', () => {
  const h = build({ ...mapPayload(), name: 'nope' });
  assert.match(h, /id="context-map-worker-panel"/);
  assert.match(h, /🗺 Context map worker/);
  assert.doesNotMatch(build({ ...mapPayload(), name: 'constructor' }), /undefined/);
});

test('malformed impact fields are ignored: non-object latest, gate and intervention kinds, non-string names, odd filed entries', () => {
  const base = impPayload().impact;
  const t1 = visible(buildOpen(impPayload({ impact: { ...base, latest: 'x', gate: 'x', interventions: { 'map-edit': 'x', 'memory-edit': 7 }, filed: [], filedCount: 0 } })));
  assert.match(t1, /impact: no decision yet/);
  assert.match(t1, /authority gate closed \(0 map edits evaluated, 0 helped\)/);
  assert.match(t1, /map-edit 0 helped \/ 0 no effect \/ 0 harmed \/ 0 waiting/);
  assert.match(t1, /memory-edit 0 helped \/ 0 no effect \/ 0 harmed \/ 0 waiting/);
  const t2 = visible(buildOpen(impPayload({ impact: { ...base, gate: { open: 'true', evaluated: 3, helped: 2 }, latest: { regressed: [1, null, {}, 'ok'], improved: [], insufficient: [], wouldFile: [] } } })));
  assert.match(t2, /impact: 1 regressed, 0 improved, 0 channels short of data · ok/);
  assert.match(t2, /authority gate closed/);
  const t3 = visible(buildOpen(impPayload({ impact: { ...base, filed: [null, 5, {}, { taskId: 7 }, { taskId: 'good-1' }], filedCount: 5 } })));
  assert.match(t3, /filed: good-1 \(newest 3 of 5\)|filed: good-1/);
  assert.doesNotMatch(t3, /filed: [^·]*(\b7\b|null|\[object)/);
  assert.doesNotMatch(t3, /undefined|NaN|\[object/);
});

test('empty lists draw no names suffix and no list lines, even opened', () => {
  const none = { latest: { regressed: [], improved: [], insufficient: [], wouldFile: [] }, filedCount: 0, filed: [], interventions: {}, gate: { open: false, evaluated: 0, helped: 0 } };
  const t = visible(buildOpen(impPayload({ impact: none })));
  assert.match(t, /impact: 0 regressed, 0 improved, 0 channels short of data 0 investigation tasks filed/);
  assert.doesNotMatch(t, / · \S+ 0 investigation/);
  assert.doesNotMatch(t, /improved: |not enough data: |would file|filed: /);
});

test('singular wording: one thin channel, one would-file task, one filed task, one evaluated edit', () => {
  const one = { latest: { regressed: [], improved: [], insufficient: ['c'], wouldFile: ['w'] }, filedCount: 1, filed: [{ taskId: 'only' }], interventions: {}, gate: { open: false, evaluated: 1, helped: 0 } };
  const t = visible(buildOpen(impPayload({ impact: one })));
  assert.match(t, /1 channel short of data/);
  assert.match(t, /would file 1 investigation task: w/);
  assert.match(t, /1 investigation task filed/);
  assert.match(t, /filed: only(?! \()/);
  assert.match(t, /\(1 map edit evaluated/);
});

test('impact edge cases: a null intervention kind, exactly three filed ids, tooltips only where there is a tip, cut limits are exact', () => {
  const base = impPayload().impact;
  assert.doesNotThrow(() => buildOpen(impPayload({ impact: { ...base, interventions: { 'map-edit': null, 'memory-edit': null } } })));
  const three = visible(buildOpen(impPayload({ impact: { ...base, filedCount: 3, filed: [{ taskId: 'f1' }, { taskId: 'f2' }, { taskId: 'f3' }] } })));
  assert.match(three, /filed: f1, f2, f3(?! \()/);
  const raw = buildOpen(impPayload());
  assert.match(raw, /title="pipeline\.firstPassApproval"/);
  assert.doesNotMatch(raw, /title=""|title="undefined"/);
  const impOf = (n) => ({ ...base, latest: { regressed: ['y'.repeat(n)], improved: [], insufficient: [], wouldFile: [] }, filed: [{ taskId: 'z'.repeat(n) }] });
  const at48 = visible(buildOpen(impPayload({ impact: impOf(48) })));
  assert.match(at48, /y{48}/);
  assert.doesNotMatch(visible(buildOpen(impPayload({ impact: impOf(49) }))), /y{49}/);
  assert.match(visible(buildOpen(impPayload({ impact: impOf(40) }))), /z{40}/);
  assert.doesNotMatch(visible(buildOpen(impPayload({ impact: impOf(41) }))), /z{41}/);
});

test('a negative filed count reads as zero', () => {
  assert.match(visible(build(impPayload({ impact: { ...impPayload().impact, filedCount: -3 } }))), /0 investigation tasks filed/);
});
