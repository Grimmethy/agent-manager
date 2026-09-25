'use strict';

// HUB0091 (2/2): tests for the draft-time grounding-refresh fallback in local-draft.js
// (tryGroundingRefreshFallback). Mirrors the node:test + node:assert/strict style of
// blocked-task-classifiers.test.js.
//
// The fallback greps the repo via require('./config.js').getConfig() AT CALL TIME, so
// these tests drive its one/zero/two+ outcomes deterministically by pointing repoRoot at
// a small temp fixture tree (no monkey-patching of the scan itself) and stubbing only
// config.getConfig, which local-draft.js reads dynamically on every call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('./config.js');
// local-draft.js runs ensureRegistered() (-> getConfig()) at MODULE LOAD, which
// requires AGENT_MANAGER_REPO_ROOT; set a placeholder before requiring it. Tests
// below stub config.getConfig per-test, so the real env value never matters.
process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || __dirname;
const { tryGroundingRefreshFallback } = require('./local-draft.js');
const { hasUnreliableGrounding } = require('./blocked-task-classifiers.js');

const SYMBOL = 'zzTargetSym77'; // unique, length >= 4 (the symbol extractor's floor)

function makeTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-refresh-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function withRepo(repoRoot, fn) {
  const real = config.getConfig;
  config.getConfig = () => ({ repoRoot, grepAllowedDirs: [] }); // [] -> scan repoRoot itself
  try { return fn(); } finally { config.getConfig = real; }
}

// The ungrounded shape the fallback is only allowed to fire on: a 'none' anchor with
// empty context (exactly what hasUnreliableGrounding flags as bad grounding).
function makeUngroundedTask(extra = {}) {
  return {
    source: 'pipeline_forensics_fix',
    localRejectCount: 1, // retry budget that must stay untouched
    promptContext: {
      // NOTE: the extractor takes the FIRST identifier of length >= 4 in rawText,
      // so every leading word must be < 4 chars or the symbol itself goes first.
      rawText: `a \`${SYMBOL}\``,
      files: ['src/stale.js'],
      fetchedFiles: [{ path: 'src/stale.js', context: '', anchorConfidence: 'none' }],
    },
    ...extra,
  };
}

// (a) exactly-one-different-file: refreshed files + fetchedFiles, budget unchanged, history event logged.
test('exactly one different file holding the symbol: fallback refreshes grounding, keeps retry budget, logs history', () => {
  const repo = makeTempRepo({
    'src/stale.js': 'stale content, symbol absent\n',
    'real/impl.js': `export function ${SYMBOL}() {\n  return 1;\n}\n`,
  });
  const task = makeUngroundedTask({
    blockedReason: 'Ungrounded draft: fabricated file path(s): src/stale.js',
    blockedStage: 'review',
    needsClarification: { reason: 'x' },
  });
  const historyLenBefore = (task.history || []).length;

  const result = withRepo(repo, () => tryGroundingRefreshFallback(task));

  assert.deepEqual(result, {
    succeeded: true, blocked: false, requeued: true,
    groundingRefresh: { symbol: SYMBOL, target: 'real/impl.js' },
  });
  assert.deepEqual(task.promptContext.files, ['real/impl.js']);
  assert.equal(task.promptContext.fetchedFiles.length, 1);
  assert.equal(task.localRejectCount, 1, 'retry budget must be unchanged');
  assert.ok(Array.isArray(task.history), 'a history event must be appended');
  assert.ok(task.history.length > historyLenBefore);
  const ev = task.history[task.history.length - 1];
  assert.equal(ev.stage, 'grounding-refresh');
  assert.match(String(ev.detail), new RegExp(`refreshed to real/impl\\.js, symbol ${SYMBOL}`));
  // stale block stamps cleared so the task is immediately re-draftable
  assert.equal(task.blockedReason, undefined);
  assert.equal(task.blockedStage, undefined);
  assert.equal(task.needsClarification, undefined);
});

// (b) zero hits: fallback aborts, no mutation, escalation stamps intact.
test('zero files holding the symbol: fallback aborts (null), no mutation, escalation proceeds', () => {
  const repo = makeTempRepo({ 'src/stale.js': 'symbol absent everywhere\n' });
  const task = makeUngroundedTask({
    blockedReason: 'Ungrounded draft: fabricated file path(s): src/stale.js',
    blockedStage: 'review',
    needsClarification: { reason: 'x' },
  });
  const filesBefore = task.promptContext.files;
  const fetchedBefore = task.promptContext.fetchedFiles;

  const result = withRepo(repo, () => tryGroundingRefreshFallback(task));

  assert.equal(result, null, 'zero hits -> null, caller falls through to escalation');
  assert.deepEqual(task.promptContext.files, filesBefore);
  assert.deepEqual(task.promptContext.fetchedFiles, fetchedBefore);
  assert.equal(task.localRejectCount, 1, 'retry budget must be unchanged');
  assert.ok(!Array.isArray(task.history) || !task.history.some((e) => e.stage === 'grounding-refresh'),
    'no grounding-refresh history event on abort');
  // escalation is NOT short-circuited: the stale stamps are still present
  assert.equal(task.blockedReason, 'Ungrounded draft: fabricated file path(s): src/stale.js');
  assert.equal(task.blockedStage, 'review');
  assert.deepEqual(task.needsClarification, { reason: 'x' });
  assert.equal(hasUnreliableGrounding(task), true, 'still ungrounded -> escalation is the right call');
});

// (b) two+ hits: fallback aborts, no mutation, escalation proceeds.
test('two+ files holding the symbol: fallback aborts (null), no mutation, escalation proceeds', () => {
  const repo = makeTempRepo({
    'src/stale.js': 'symbol absent\n',
    'real/a.js': `function ${SYMBOL}() { return 1; }\n`,
    'real/b.js': `function ${SYMBOL}() { return 2; }\n`,
  });
  const task = makeUngroundedTask({
    blockedReason: 'Ungrounded draft: fabricated file path(s): src/stale.js',
    blockedStage: 'review',
    needsClarification: { reason: 'x' },
  });
  const filesBefore = task.promptContext.files;
  const fetchedBefore = task.promptContext.fetchedFiles;

  const result = withRepo(repo, () => tryGroundingRefreshFallback(task));

  assert.equal(result, null, 'two+ candidate files -> ambiguous, abort to escalation');
  assert.deepEqual(task.promptContext.files, filesBefore);
  assert.deepEqual(task.promptContext.fetchedFiles, fetchedBefore);
  assert.equal(task.localRejectCount, 1, 'retry budget must be unchanged');
  assert.ok(!Array.isArray(task.history) || !task.history.some((e) => e.stage === 'grounding-refresh'),
    'no grounding-refresh history event on abort');
  assert.equal(task.blockedReason, 'Ungrounded draft: fabricated file path(s): src/stale.js');
  assert.equal(task.blockedStage, 'review');
});

// (c) refreshed fetchedFiles entry shape matches the hasUnreliableGrounding contract.
test('refreshed fetchedFiles entry: { path, context, anchorConfidence }, non-empty context, anchorConfidence !== "none" -> hasUnreliableGrounding false', () => {
  const repo = makeTempRepo({
    'src/stale.js': 'symbol absent\n',
    'real/impl.js': `export function ${SYMBOL}() {\n  return 1;\n}\n`,
  });
  const task = makeUngroundedTask();
  assert.equal(hasUnreliableGrounding(task), true, 'precondition: ungrounded before refresh');

  const result = withRepo(repo, () => tryGroundingRefreshFallback(task));
  assert.ok(result && result.succeeded && result.requeued, 'success path must fire for this fixture');

  assert.ok(Array.isArray(task.promptContext.fetchedFiles));
  assert.ok(task.promptContext.fetchedFiles.length >= 1);
  for (const entry of task.promptContext.fetchedFiles) {
    assert.deepEqual(Object.keys(entry).sort(), ['anchorConfidence', 'context', 'path']);
    assert.equal(typeof entry.path, 'string');
    assert.ok(entry.path.length > 0);
    assert.equal(typeof entry.context, 'string');
    assert.ok(entry.context.length > 0, 'context must be a non-empty window, not empty');
    assert.notEqual(entry.anchorConfidence, 'none');
  }
  assert.equal(hasUnreliableGrounding(task), false, 'refreshed grounding must clear the unreliable-grounding classifier');
});
