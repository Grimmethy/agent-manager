'use strict';

// derived-gate.js: deterministic gating for derived_task findings (no model). Evidence and design in the module header.
// Run: node --test src/derived-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const gate = require('./derived-gate.js');

const NOW = Date.parse('2026-09-21T12:00:00Z');
const iso = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const dt = (id, rawText, over = {}) => ({ id, source: 'derived_task', domain: 'adhoc', title: id, createdAt: iso(1), promptContext: { rawText }, ...over });

function pipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derived-gate-'));
  for (const s of ['adhoc', 'pending', 'review', 'approved', 'awaiting-confirm', 'blocked', 'needs-clarification', 'coordinating', 'done/_archived_no_action', 'derived', 'drafting/worker-1']) fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  return dir;
}
const put = (dir, state, task) => fs.writeFileSync(path.join(dir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));

test('citedPaths finds paths incl. file:line, nginx.conf, css; drops generated candidate docs and URLs', () => {
  const t = dt('a', 'See `src/components/PropertyAerialView.tsx:22-23`, App.tsx:93, nginx.conf and styles.css; Docs/FUNCTION_LENGTH_CANDIDATES.md; https://x.io/lib/a.js');
  const p = gate.citedPaths(t);
  for (const want of ['src/components/PropertyAerialView.tsx', 'App.tsx', 'nginx.conf', 'styles.css']) assert.ok(p.includes(want), want);
  assert.ok(!p.some((x) => /CANDIDATES/.test(x)), 'generated candidate docs are not cited files');
  assert.ok(!p.includes('lib/a.js') && !p.includes('a.js'), 'a URL path is not a repo file');
});

test('filesOverlap: same path, suffix, or a bare name matching a basename; not merely a shared extension', () => {
  assert.equal(gate.filesOverlap(['src/App.tsx'], ['src/App.tsx']), true);
  assert.equal(gate.filesOverlap(['App.tsx'], ['src/App.tsx']), true);
  assert.equal(gate.filesOverlap(['src/a/App.tsx'], ['src/b/App.tsx']), false, 'two different paths with the same basename are different files');
  assert.equal(gate.filesOverlap(['src/App.tsx'], ['src/Sidebar.tsx']), false);
});

test('isHeld: held by an older open code-changing task naming the same file; released when it is gone', () => {
  const dir = pipeline();
  put(dir, 'adhoc', { id: 'hub-child', source: 'manual', createdAt: iso(3), promptContext: { rawText: 'Edit src/components/PropertyAerialView.tsx' } });
  const d = dt('d1', 'tile math in src/components/PropertyAerialView.tsx duplicates');
  const held = gate.isHeld(d, gate.openTaskIndex(dir), { now: NOW });
  assert.equal(held.held, true);
  assert.deepEqual(held.by, ['hub-child']);
  fs.unlinkSync(path.join(dir, 'queue', 'adhoc', 'hub-child.json'));
  assert.equal(gate.isHeld(d, gate.openTaskIndex(dir), { now: NOW }).held, false);
});

test('isHeld: not held by a non-overlapping task, a READ-ONLY source (change_review), a blocked/NC task, or a done one', () => {
  const dir = pipeline();
  put(dir, 'adhoc', { id: 'other-file', source: 'manual', createdAt: iso(3), promptContext: { rawText: 'Edit src/Other.tsx' } });
  put(dir, 'pending', { id: 'reviewer', source: 'change_review', createdAt: iso(3), promptContext: { rawText: 'review of src/App.tsx' } });
  put(dir, 'blocked', { id: 'stuck', source: 'manual', createdAt: iso(3), promptContext: { rawText: 'Edit src/App.tsx' } });
  put(dir, 'needs-clarification', { id: 'nc', source: 'manual', createdAt: iso(3), promptContext: { rawText: 'Edit src/App.tsx' } });
  put(dir, 'done', { id: 'finished', source: 'manual', createdAt: iso(3), promptContext: { rawText: 'Edit src/App.tsx' } });
  assert.equal(gate.isHeld(dt('d', 'a problem in src/App.tsx'), gate.openTaskIndex(dir), { now: NOW }).held, false);
});

test('isHeld among derived tasks: only an OLDER derived task holds a newer one, so two overlapping ones never hold each other forever', () => {
  const dir = pipeline();
  const older = dt('older', 'issue in src/App.tsx', { createdAt: iso(5) });
  const newer = dt('newer', 'another issue in src/App.tsx', { createdAt: iso(2) });
  put(dir, 'derived', older); put(dir, 'derived', newer);
  const idx = gate.openTaskIndex(dir);
  assert.equal(gate.isHeld(older, idx, { now: NOW }).held, false, 'the oldest is never held by a newer one');
  assert.deepEqual(gate.isHeld(newer, idx, { now: NOW }).by, ['older']);
});

test('an inert leftover origin record in derived/ (its id lives elsewhere) holds nothing', () => {
  const dir = pipeline();
  put(dir, 'derived', dt('ghost', 'issue in src/App.tsx', { createdAt: iso(9) }));
  put(dir, 'done', { id: 'ghost', source: 'derived_task' }); // the real task ended in done/
  assert.equal(gate.isHeld(dt('d', 'problem in src/App.tsx'), gate.openTaskIndex(dir), { now: NOW }).held, false);
});

test('isHeld never holds: a human-prioritised task, a task citing no file, one past the hold cap; kill switch turns it off', () => {
  const dir = pipeline();
  put(dir, 'adhoc', { id: 'x', source: 'manual', createdAt: iso(3), promptContext: { rawText: 'Edit src/App.tsx' } });
  const idx = gate.openTaskIndex(dir);
  const mk = (over) => dt('d', 'problem in src/App.tsx', over);
  assert.equal(gate.isHeld(mk({}), idx, { now: NOW }).held, true, 'control');
  assert.equal(gate.isHeld(mk({ premiumPriority: true }), idx, { now: NOW }).held, false);
  assert.equal(gate.isHeld(mk({ humanQueued: true }), idx, { now: NOW }).held, false);
  assert.equal(gate.isHeld(dt('n', 'a vague design worry with no file'), idx, { now: NOW }).held, false);
  assert.equal(gate.isHeld(mk({ createdAt: iso(30) }), idx, { now: NOW }).held, false, 'older than 24 h: released so it cannot starve');
  process.env.AGENT_MANAGER_DERIVED_HOLD = 'false';
  try { assert.equal(gate.isHeld(mk({}), idx, { now: NOW }).held, false); } finally { delete process.env.AGENT_MANAGER_DERIVED_HOLD; }
});

test('premiseGone (injected existence): gone only when EVERY cited file is missing everywhere; a declared create target does not count', () => {
  const t = dt('p', 'Problem in `src/a.ts` and `src/b.ts` (both cited)');
  const none = { repoRoot: '/r', mainBranch: 'main', existsOnDisk: () => false, existsAtRef: () => false };
  assert.equal(gate.premiseGone(t, none).gone, true);
  assert.match(gate.premiseGone(t, none).evidence[0], /src\/a\.ts, src\/b\.ts/);
  assert.equal(gate.premiseGone(t, { ...none, existsOnDisk: (p) => p === 'src/b.ts' }).gone, false, 'one file still on disk');
  assert.equal(gate.premiseGone(t, { ...none, existsAtRef: (ref, p) => ref === 'main' && p === 'src/a.ts' }).gone, false, 'one file only on origin/main');
  assert.equal(gate.premiseGone(t, { ...none, extraRef: 'agent/x', existsAtRef: (ref) => ref === 'agent/x' }).gone, false, 'or only on its stacked branch');
  assert.equal(gate.premiseGone(dt('c', 'Create `src/new-thing.ts` with the helper.'), none).gone, false, 'a file the task says to CREATE is not evidence of anything');
  assert.equal(gate.premiseGone(dt('v', 'a vague worry'), none).gone, false, 'no cited file -> nothing to judge');
  assert.equal(gate.premiseGone(t, { ...none, existsOnDisk: () => { throw new Error('boom'); } }).gone, false, 'an error is "unknown", never "gone"');
});

test('premiseGone against a REAL repo: a file present only on origin/main (working tree behind) is NOT gone; absent everywhere is', () => {
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-origin-')); const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-repo-'));
  g(['init', '--bare', '-b', 'main', bare]); g(['clone', bare, repo]);
  g(['config', 'user.email', 't@e.x'], repo); g(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'old.txt'), 'x'); g(['add', '.'], repo); g(['commit', '-m', 'a'], repo); g(['push', 'origin', 'main'], repo);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-other-'));
  g(['clone', bare, other]); g(['config', 'user.email', 't@e.x'], other); g(['config', 'user.name', 'T'], other);
  fs.mkdirSync(path.join(other, 'src', 'lib'), { recursive: true }); fs.writeFileSync(path.join(other, 'src', 'lib', 'tileGrid.ts'), 'x');
  g(['add', '.'], other); g(['commit', '-m', 'b'], other); g(['push', 'origin', 'main'], other);
  g(['fetch', 'origin', 'main'], repo); // origin/main now has tileGrid.ts; the clone's working tree does not
  assert.equal(fs.existsSync(path.join(repo, 'src', 'lib', 'tileGrid.ts')), false);
  assert.equal(gate.premiseGone(dt('r', 'Problem in `src/lib/tileGrid.ts`'), { repoRoot: repo, mainBranch: 'main' }).gone, false);
  assert.equal(gate.premiseGone(dt('r2', 'Problem in `src/lib/gone.ts`'), { repoRoot: repo, mainBranch: 'main' }).gone, true);
});

test('raisedByAbandoned: the raising task is archived as abandoned -> its id; merged / absent -> null', () => {
  const dir = pipeline();
  const arch = (id, over) => fs.writeFileSync(path.join(dir, 'queue', 'done', '_archived_no_action', `${id}.json`), JSON.stringify({ id, ...over }));
  arch('HUB0007-02', { terminalDisposition: 'abandoned' });
  arch('retired-by-hand', { manualArchive: { at: 'x' } });
  arch('merged-one', { terminalDisposition: 'merged' });
  const from = (taskId) => dt('d', 'x', { promptContext: { rawText: 'x', derivedFrom: { source: 'manual', taskId } } });
  assert.equal(gate.raisedByAbandoned(from('HUB0007-02'), dir), 'HUB0007-02');
  assert.equal(gate.raisedByAbandoned(from('retired-by-hand'), dir), 'retired-by-hand');
  assert.equal(gate.raisedByAbandoned(from('merged-one'), dir), null);
  assert.equal(gate.raisedByAbandoned(from('never-existed'), dir), null);
  assert.equal(gate.raisedByAbandoned(dt('h', 'x'), dir), null, 'a human-typed finding has no raiser');
});

// The five agent-manager findings the first version of the rule would have wrongly retired (dry run on that project's real queue, 2026-09-21).
test('premiseGone is EXEMPT for findings about invented / fixture / example paths, and for the pipeline\'s own meta-analysis sources', () => {
  const none = { repoRoot: '/r', mainBranch: 'main', existsOnDisk: () => false, existsAtRef: () => false };
  const withSource = (source, rawText) => dt('m', rawText, { promptContext: { rawText, derivedFrom: { source } } });
  const cases = [
    ['manual', '`combined` in checkFabricatedSymbols excludes file paths: `realFilesOf` entries carry a `path` (e.g. `haystack/components/converters/txt.py` in the test fixture)'],
    ['pipeline_debrief', 'Repeated NOW-WHAT rejections for invented file paths: the model fabricates a `src/` path (e.g. `src/deterministic-recheck.js`, `src/project-search.js`)'],
    ['pipeline_debrief', 'the model cited nonexistent files (`src/brain_dump_sort/plan.ts`) and the fact-check blocked them'],
    ['pipeline_forensics', 'Task scope vs the real-implementation heuristic is a false-positive trap: a task that legitimately asks for `docs/prior-rejection-block-verification.md`'],
  ];
  for (const [source, text] of cases) {
    const r = gate.premiseGone(withSource(source, text), none);
    assert.equal(r.gone, false, text.slice(0, 60));
    assert.ok(r.exempt, 'and it says why');
  }
  assert.equal(gate.premiseGone(withSource('change_review', 'Problem in `src/gone.ts`: the handler ignores errors'), none).gone, true, 'a plain code-claim finding is still judged');
  assert.equal(gate.premiseGone(dt('h', 'Problem in `src/gone.ts`'), none).gone, true, 'and one with no recorded source');
});
