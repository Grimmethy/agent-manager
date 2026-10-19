'use strict';

// Golden tests for applyBrainDumpSort's outcomes (HUB0085). The function was split into stages (loadAndValidateEntry, classifySortResult, queueResearchTask,
// queueProjectTask [buildAdhocTaskForEntry, applyDuplicateGate, writeAdhocTask], filePassiveNote) with the original code moved verbatim; these tests pin every outcome
// through the public entry point, so they pass on both the pre-split and post-split code. A separate throwaway differential run (1,200 seeded cases, byte-identical
// return values, brain-dump file, written files and warnings against the pre-split code) backed the move itself.
//
// Run: node --test src/apply-group-a-brain-dump-stages.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub the two collaborators that need a built graph / real config BEFORE the module under test loads (it destructures them at require time).
const pathPrefetch = require('./path-prefetch.js');
const config = require('./config.js');
let anchor = { status: 'greenfield', paths: [] };
pathPrefetch.resolveAnchors = () => anchor;
config.resolveGraphPath = () => '/nonexistent/graph.json';
const { applyBrainDumpSort } = require('./apply-group-a-brain-dump.js');

const TITLES = ['Add a retry cap to the sweep'];

function world({ entry = {}, resp, domains = 'adhoc', rawText = 'plain journal thought about my day' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'abds-stages-'));
  const vault = path.join(base, 'vault');
  for (const d of ['Projects', 'Journal', 'Research']) fs.mkdirSync(path.join(vault, d), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Journal', 'existing-note.md'), '# existing\n');
  const repoA = path.join(base, 'repoA'); const repoB = path.join(base, 'repoB');
  fs.mkdirSync(repoA); fs.mkdirSync(repoB);
  const pipeA = path.join(base, 'pipeA'); const pipeB = path.join(base, 'pipeB');
  fs.mkdirSync(path.join(pipeA, 'queue'), { recursive: true }); fs.mkdirSync(pipeB, { recursive: true });
  const domA = path.join(base, 'domainsA.json'); const domB = path.join(base, 'domainsB.json');
  if (domains === 'adhoc') fs.writeFileSync(domA, JSON.stringify({ adhoc: {} })); else if (domains === 'none') fs.writeFileSync(domA, JSON.stringify({ default: {} }));
  fs.writeFileSync(domB, JSON.stringify({ adhoc: {} }));
  const registry = path.join(base, 'projects.json');
  fs.writeFileSync(registry, JSON.stringify([{ label: 'agent-manager', repoRoot: repoA, pipelineDir: pipeA, domainsPath: domA }, { label: 'other-proj', repoRoot: repoB, pipelineDir: pipeB, domainsPath: domB }]));
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = registry;
  const dump = { id: 'bd-1', capturedAt: '2026-10-01T00:00:00.000Z', rawText, status: 'captured', ...entry };
  if (dump.raisedBy && dump.raisedBy.repoRoot === '<B>') dump.raisedBy = { ...dump.raisedBy, repoRoot: repoB };
  const brainDumpPath = path.join(base, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries: entry === null ? [] : [dump] }, null, 2));
  const task = { id: 't', promptContext: { brainDumpEntryId: 'bd-1', rawText, existingQueuedTitles: TITLES } };
  const classify = (over) => JSON.stringify({ secondBrainPath: 'Projects/agent-manager/retry-cap-design.md', tags: ['a'], actionable: false, rationale: 'r', belongsToProject: null, requiresResearch: false, possibleDuplicateOf: null, relatedNotes: [], ...over });
  const run = (over, extra = {}) => applyBrainDumpSort({ implementResponse: resp !== undefined ? resp : classify(over), task, brainDumpPath, secondBrainDir: vault, pipelineDir: pipeA, ...extra });
  const entryNow = () => JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries[0];
  const queued = (dir) => { try { return fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { return []; } };
  return { base, vault, pipeA, run, entryNow, queued, classify };
}

test('terminal skips: a missing entry, a suppressed entry and an unconfigured vault write nothing', () => {
  const w = world({ entry: null });
  const r = w.run({});
  assert.equal(r.skipped, true);
  assert.match(r.reason, /no longer exists/);
  const s = world({ entry: { suppressed: true } });
  assert.match(s.run({}).reason, /suppressed since this task was queued/);
  const v = world();
  config.getSecondBrainDir = () => null;
  assert.match(v.run({}, { secondBrainDir: undefined }).reason, /SECOND_BRAIN_DIR is not configured/);
});

test('a stale entry (text edited since drafting) is the distinct non-success stale shape and the entry is untouched', () => {
  const w = world({ entry: { rawText: 'edited since' } });
  const r = w.run({});
  assert.deepEqual({ skipped: r.skipped, stale: r.stale, success: r.success }, { skipped: true, stale: true, success: false });
  assert.equal(w.entryNow().status, 'captured');
  assert.equal(w.entryNow().sortAttempt, undefined);
});

test('an unparseable classification and a rejected vault path are recoverable skips', () => {
  const bad = world({ resp: 'not json at all' });
  const r = bad.run({});
  assert.equal(r.skipped, true);
  assert.equal(r.recoverable, true);
  assert.match(r.reason, /did not return a valid classification JSON/);
  const naming = world();
  const n = naming.run({ secondBrainPath: 'Nope/bad.md' });
  assert.equal(n.recoverable, true);
  assert.match(n.reason, /rejected secondBrainPath "Nope\/bad\.md"/);
});

test('a result naming no project is filed as a passive vault note with tags and wikilinks, and the entry becomes sorted', () => {
  const w = world();
  const r = w.run({ secondBrainPath: 'Journal/day.md', relatedNotes: ['existing-note'] });
  assert.equal(r.file, path.join(w.vault, 'Journal', 'day.md'));
  const text = fs.readFileSync(r.file, 'utf8');
  assert.match(text, /\*\*2026-\d\d-\d\d\*\* plain journal thought about my day _\(a\)_ -- see \[\[existing-note\]\]/);
  assert.equal(w.entryNow().status, 'sorted');
  assert.equal(w.entryNow().sort.secondBrainPath, 'Journal/day.md');
});

test('requiresResearch with no project queues a research task, cross-references it in the vault and marks the entry actioned', () => {
  const w = world();
  const r = w.run({ requiresResearch: true, secondBrainPath: 'Research/x.md' });
  assert.equal(r.researchQueued, true);
  const tasks = w.queued(path.join(w.pipeA, 'queue', 'research'));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].source, 'research_task');
  assert.match(fs.readFileSync(r.file, 'utf8'), /Queued as research task/);
  assert.equal(w.entryNow().status, 'actioned');
  assert.equal(w.entryNow().queuedTaskId, r.queuedTaskId);
  const noDir = world();
  assert.match(noDir.run({ requiresResearch: true, secondBrainPath: 'Research/x.md' }, { pipelineDir: null }).reason, /no pipelineDir available/);
});

test('a matched project gets an adhoc task with prefetched paths; a machine-raised entry goes to derived; no-match / ambiguous go to needs-clarification', () => {
  anchor = { status: 'matched', paths: ['src/a.js'] };
  const w = world();
  const r = w.run({ belongsToProject: 'agent-manager', actionable: true });
  assert.equal(r.queuedProject, 'agent-manager');
  const t = w.queued(path.join(w.base, 'pipeA', 'queue', 'adhoc'))[0];
  assert.equal(t.source, 'brain_dump');
  assert.deepEqual(t.promptContext.prefetchedPaths, ['src/a.js']);
  assert.equal(w.entryNow().status, 'actioned');
  const d = world({ entry: { raisedBy: { source: 'debrief' } } });
  d.run({ belongsToProject: 'agent-manager' });
  const dt = d.queued(path.join(d.base, 'pipeA', 'queue', 'derived'))[0];
  assert.equal(dt.source, 'derived_task');
  assert.deepEqual(dt.promptContext.derivedFrom, { source: 'debrief' });
  anchor = { status: 'no-match', paths: [] };
  const nm = world();
  nm.run({ belongsToProject: 'agent-manager' });
  assert.equal(nm.queued(path.join(nm.base, 'pipeA', 'queue', 'needs-clarification'))[0].needsClarification.reason, 'no-match');
  anchor = { status: 'ambiguous', paths: ['src/b.js'], candidates: ['src/b.js', 'src/c.js'] };
  const am = world();
  am.run({ belongsToProject: 'agent-manager' });
  const at = am.queued(path.join(am.base, 'pipeA', 'queue', 'needs-clarification'))[0];
  assert.equal(at.needsClarification.reason, 'ambiguous');
  assert.deepEqual(at.promptContext.prefetchedPaths, ['src/b.js']);
  anchor = { status: 'greenfield', paths: [] };
});

test('an unregistered label and a project without an adhoc domain are recoverable skips, not silent downgrades to a note', () => {
  const ghost = world();
  const g = ghost.run({ belongsToProject: 'ghost' });
  assert.equal(g.recoverable, true);
  assert.match(g.reason, /does not match any registered project/);
  const none = world({ domains: 'none' });
  const n = none.run({ belongsToProject: 'agent-manager' });
  assert.equal(n.recoverable, true);
  assert.match(n.reason, /has no 'adhoc' domain registered/);
});

test('the possible-duplicate gate: an invented title is dropped, a real one retries once, then holds the task for a human', () => {
  const invented = world();
  const origWarn = console.warn; console.warn = () => {};
  try {
    const i = invented.run({ belongsToProject: 'agent-manager', possibleDuplicateOf: 'Totally invented slug' });
    assert.equal(i.queuedProject, 'agent-manager', 'a hallucinated duplicate flag is ignored');
    const first = world();
    const f = first.run({ belongsToProject: 'agent-manager', possibleDuplicateOf: TITLES[0] });
    assert.equal(f.recoverable, true);
    assert.match(f.reason, /possible duplicate of .* on the first flag/);
    assert.equal(first.entryNow().status, 'captured');
    assert.equal(first.queued(path.join(first.base, 'pipeA', 'queue', 'adhoc')).length, 0);
    const second = world({ entry: { duplicateGateAttempts: 1 } });
    const s = second.run({ belongsToProject: 'agent-manager', possibleDuplicateOf: TITLES[0] });
    assert.equal(s.queuedProject, 'agent-manager');
    const held = second.queued(path.join(second.base, 'pipeA', 'queue', 'needs-clarification'))[0];
    assert.equal(held.needsClarification.reason, 'design-decision');
    assert.match(held.needsClarification.openQuestions, /possible duplicate of an already-queued task/);
  } finally { console.warn = origWarn; }
});

test('origin routing overrides the classifier for a machine-raised finding, and an investigation-shaped finding becomes a note, not a code task', () => {
  const o = world({ entry: { raisedBy: { source: 'x', repoRoot: '<B>' } } });
  const r = o.run({ belongsToProject: 'agent-manager' });
  assert.equal(r.queuedProject, 'other-proj', 'the raising project wins over the guessed label');
  assert.equal(o.queued(path.join(o.base, 'pipeB', 'queue', 'derived')).length, 1);
  const inv = world({ entry: { raisedBy: { source: 'x' } }, rawText: 'Investigate why the worker idles and document findings' });
  const n = inv.run({ belongsToProject: 'agent-manager', actionable: true });
  assert.equal(n.queuedProject, undefined);
  assert.ok(n.file && n.file.startsWith(inv.vault), 'filed as a vault note');
  assert.equal(inv.entryNow().status, 'sorted');
  assert.equal(inv.entryNow().sort.actionable, false);
});
