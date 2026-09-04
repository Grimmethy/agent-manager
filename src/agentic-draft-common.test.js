'use strict';

// Tests for the provider-agnostic agentic-draft helpers extracted from the (deleted)
// adhoc-agentic-draft.js -- the parse helpers and resolveAgenticDraft's verdict mapping.
// Worktree git operations are exercised via a real throwaway repo, same fixture shape
// group-b-worktree-diff.test.js uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  parseSubTaskProposals, parseClarificationOptions, priorRejectionBlock,
  RESOLUTION_RE, resolveAgenticDraft,
} = require('./agentic-draft-common.js');

test('parseSubTaskProposals pulls a 2+ {title,rawText} array out of surrounding prose', () => {
  const text = 'here is the split:\n[{"title":"a","rawText":"do a"},{"title":"b","rawText":"do b"}]\nthat is why';
  assert.deepEqual(parseSubTaskProposals(text), [
    { title: 'a', rawText: 'do a' }, { title: 'b', rawText: 'do b' },
  ]);
});

test('parseSubTaskProposals preserves an optional integer `after`, drops a bad one', () => {
  assert.deepEqual(
    parseSubTaskProposals('[{"title":"a","rawText":"x"},{"title":"b","rawText":"y","after":0}]'),
    [{ title: 'a', rawText: 'x' }, { title: 'b', rawText: 'y', after: 0 }],
  );
  // non-integer / negative `after` is dropped, the entry still survives
  assert.deepEqual(
    parseSubTaskProposals('[{"title":"a","rawText":"x"},{"title":"b","rawText":"y","after":"nope"},{"title":"c","rawText":"z","after":-1}]'),
    [{ title: 'a', rawText: 'x' }, { title: 'b', rawText: 'y' }, { title: 'c', rawText: 'z' }],
  );
});

test('parseSubTaskProposals drops malformed entries but keeps the batch, returns null below 1', () => {
  assert.deepEqual(parseSubTaskProposals('[{"title":"a","rawText":"x"},{"title":"","rawText":"y"}]'), [{ title: 'a', rawText: 'x' }]);
  assert.equal(parseSubTaskProposals('[{"title":"","rawText":""}]'), null);
  assert.equal(parseSubTaskProposals('no array here'), null);
  assert.equal(parseSubTaskProposals('[not json]'), null);
});

test('parseClarificationOptions needs an OPTIONS: header + 2 well-formed lines', () => {
  const text = 'the question is X\nOPTIONS:\n1. Redis :: use a redis instance\n2. In-memory :: keep it in the process\n';
  assert.deepEqual(parseClarificationOptions(text), [
    { label: 'Redis', description: 'use a redis instance' },
    { label: 'In-memory', description: 'keep it in the process' },
  ]);
  assert.equal(parseClarificationOptions('OPTIONS:\n1. only one :: not enough'), null);
  assert.equal(parseClarificationOptions('no header'), null);
});

test('priorRejectionBlock renders feedback, empty string for none', () => {
  assert.equal(priorRejectionBlock({}), '');
  assert.match(priorRejectionBlock({ priorRejectionFeedback: ['too vague', 'wrong file'] }), /attempted 2 time\(s\)[\s\S]*1\. too vague[\s\S]*2\. wrong file/);
});

test('RESOLUTION_RE recognises all four verbs, case-insensitively', () => {
  for (const v of ['implemented', 'no-changes-needed', 'decompose', 'needs-human-decision']) {
    assert.equal(('RESOLUTION: ' + v).match(RESOLUTION_RE)[1].toLowerCase(), v);
  }
  assert.equal('RESOLUTION: something-else'.match(RESOLUTION_RE), null);
});

// --- resolveAgenticDraft against a real worktree -----------------------------------

function withRealRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-common-test-'));
  const wt = path.join(dir, 'wt');
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(wt);
  g(['init', '-q'], wt);
  g(['config', 'user.email', 't@t'], wt); g(['config', 'user.name', 't'], wt);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'original\n');
  g(['add', '-A'], wt); g(['commit', '-qm', 'init'], wt);
  try { return fn(wt); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('resolveAgenticDraft(implemented): a docs-only diff for a code task -> retryable block with pointed feedback', () => {
  withRealRepo((wt) => {
    fs.mkdirSync(path.join(wt, 'docs', 'adr'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'docs', 'adr', '0021-thing.md'), '# ADR\n\nsome design prose\n');
    const task = { id: 'tsub', source: 'manual', domain: 'adhoc',
      promptContext: { rawText: 'Combine job types into expandable rows in python/dashboard/templates/index.html -- renderJobListTab().' } };
    const out = resolveAgenticDraft(task, {
      result: { response: 'wrote an ADR\n\nRESOLUTION: implemented\n\ndone' }, worktreeDir: wt,
    });
    assert.equal(out.blocked, true);
    assert.match(out.blockedReason, /not a real implementation -- diff only touches documentation/);
    assert.equal(task.retryableDraftBlock, true);
    assert.match(task.adhocDiffSubstanceFeedback, /only created\/edited documentation/);
    assert.ok(!task.adhocResolution, 'not stamped as implemented');
  });
});

test('resolveAgenticDraft(implemented): a real code diff for an adhoc task is unaffected', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'real change\n');
    const task = { id: 'treal', source: 'manual', domain: 'adhoc', promptContext: { rawText: 'change a.txt' } };
    const out = resolveAgenticDraft(task, {
      result: { response: 'did it\n\nRESOLUTION: implemented\n\ndone' }, worktreeDir: wt,
    });
    assert.equal(out.blocked, false);
    assert.equal(task.adhocResolution, 'implemented');
    assert.match(task.rawDiff, /a\.txt/);
  });
});

test('resolveAgenticDraft(implemented): stages + captures the worktree diff into task.rawDiff', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'brand new\n');
    const task = { id: 't1' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'did stuff\n\nRESOLUTION: implemented\n\nsummary here' },
      worktreeDir: wt, modelLabel: 'qwen-test',
    });
    assert.equal(out.succeeded, true);
    assert.equal(out.blocked, false);
    assert.equal(out.resolution, 'implemented'); // now surfaced for draft-attempt-record.js
    assert.equal(task.adhocResolution, 'implemented');
    assert.equal(task.draftModel, 'qwen-test');
    assert.match(task.rawDiff, /a\.txt/);
    assert.match(task.rawDiff, /new\.txt/);
    assert.match(task.implementResponse, /=== DIFF ===/);
  });
});

test('resolveAgenticDraft(decompose): sets subTaskProposals, no diff', () => {
  withRealRepo((wt) => {
    const task = { id: 't2' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: decompose\n[{"title":"p1","rawText":"first"},{"title":"p2","rawText":"second"}]\nsplit because big' },
      worktreeDir: wt,
    });
    assert.equal(out.succeeded, true);
    assert.equal(out.blocked, false);
    assert.equal(task.subTaskProposals.length, 2);
    assert.equal(task.rawDiff, '');
    assert.equal(task.retryableDraftBlock, false, 'a valid decompose is not a retryable block');
  });
});

test('resolveAgenticDraft(decompose) WITH partial worktree edits -> continuation, not a split', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'I already did half of this\n');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'a function I wrote before bailing\n');
    const task = { id: 't2cont' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'I wrote the validators.\n\nRESOLUTION: decompose\n[{"title":"p1","rawText":"a"},{"title":"p2","rawText":"b"}]\nrest is big' },
      worktreeDir: wt,
    });
    assert.equal(out.blocked, true);
    assert.match(out.blockedReason, /made partial edits then chose RESOLUTION: decompose -- requeued as continuation 1\/2/);
    assert.equal(task.isAgenticContinuation, true);
    assert.equal(task.agenticContinuationCount, 1);
    assert.match(task.priorPartialDiff, /new\.txt/);
    assert.equal(task.retryableDraftBlock, true);
    assert.ok(!task.subTaskProposals, 'the split is NOT accepted while there is unfinished partial work');
    assert.ok(!task.adhocResolution);
  });
});

test('resolveAgenticDraft(decompose) with partial edits AT the continuation cap -> accepts the split, notes discarded work', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'partial again\n');
    const task = { id: 't2capd', agenticContinuationCount: 2 }; // MAX_AGENTIC_CONTINUATIONS
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: decompose\n[{"title":"p1","rawText":"a"},{"title":"p2","rawText":"b"}]\nstill multi-part' },
      worktreeDir: wt,
    });
    assert.equal(out.blocked, false);
    assert.equal(task.adhocResolution, 'decompose');
    assert.equal(task.subTaskProposals.length, 2);
    assert.equal(task.rawDiff, '');
    assert.match(task.implementResponse, /partial edits before this split; they were not carried forward/);
  });
});

test('resolveAgenticDraft(decompose) n===0 WITH partial worktree edits -> continuation (not a block that discards the work)', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'new.txt'), 'a helper I wrote before the malformed split\n');
    const task = { id: 't2n0cont' };
    const out = resolveAgenticDraft(task, {
      // decompose, but the JSON is malformed -> parseSubTaskProposals returns 0
      result: { response: 'I added the cache helper.\n\nRESOLUTION: decompose\n{not: valid json array}' },
      worktreeDir: wt,
    });
    assert.equal(out.blocked, true);
    assert.match(out.blockedReason, /made partial edits then chose RESOLUTION: decompose with no usable pieces -- requeued as continuation 1\/2/);
    assert.equal(task.isAgenticContinuation, true);
    assert.equal(task.agenticContinuationCount, 1);
    assert.match(task.priorPartialDiff, /new\.txt/);
    assert.equal(task.decomposeBlockCount, undefined, 'partial work continues -- not counted as a failed decompose');
  });
});

test('resolveAgenticDraft(decompose) n===0 with NO edits -> the usual malformed-JSON block, decomposeBlockCount incremented', () => {
  withRealRepo((wt) => {
    const task = { id: 't2n0none' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: decompose\nnope not json' },
      worktreeDir: wt,
    });
    assert.equal(out.blocked, true);
    assert.match(out.blockedReason, /no valid JSON array of \{title, rawText\}/);
    assert.equal(task.decomposeBlockCount, 1);
    assert.equal(task.retryableDraftBlock, true);
  });
});

test('resolveAgenticDraft(needs-human-decision): needsClarification, no diff', () => {
  withRealRepo((wt) => {
    const task = { id: 't3' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: needs-human-decision\nWhich DB?' },
      worktreeDir: wt,
    });
    assert.equal(out.succeeded, true);
    assert.equal(out.blocked, false);
    assert.equal(out.needsClarification, true);
    assert.equal(task.adhocResolution, 'needs-human-decision');
  });
});

test('resolveAgenticDraft(needs-human-decision) + partial diff + "ran out of turns" -> continuation block, not a human hold', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'partial work landed\n');
    const task = { id: 'cont-1' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: needs-human-decision\n\nThere is no open design question -- I ran out of turns mid-implementation. A fresh pass can finish from here: still need the /api/plugins/marketplace route and the test file.' },
      worktreeDir: wt,
    });
    assert.equal(out.blocked, true);
    assert.equal(out.needsClarification, undefined);
    assert.match(out.blockedReason, /continuation 1\/2/);
    assert.equal(task.retryableDraftBlock, true);
    assert.equal(task.isAgenticContinuation, true);
    assert.equal(task.agenticContinuationCount, 1);
    assert.match(task.priorPartialDiff, /a\.txt/);
    assert.notEqual(task.adhocResolution, 'needs-human-decision');
  });
});

test('resolveAgenticDraft(needs-human-decision): a GENUINE question still goes to a human even with partial work', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'partial\n');
    const task = { id: 'cont-2' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: needs-human-decision\n\nShould the license gate call Stripe live, or stub it? I need you to decide the payment provider.' },
      worktreeDir: wt,
    });
    assert.equal(out.needsClarification, true);
    assert.equal(task.adhocResolution, 'needs-human-decision');
    assert.notEqual(task.isAgenticContinuation, true);
  });
});

test('resolveAgenticDraft(needs-human-decision): once the continuation cap is hit it escalates to a human', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'partial\n');
    const task = { id: 'cont-3', agenticContinuationCount: 2 };
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: needs-human-decision\n\nNo design question, just ran out of turns again.' },
      worktreeDir: wt,
    });
    assert.equal(out.needsClarification, true);
    assert.equal(task.adhocResolution, 'needs-human-decision');
  });
});

test('resolveAgenticDraft(needs-human-decision): forcedSummary + zero edits + empty worktree + "ran out of turns" -> retryable turn-budget BLOCK, not a human hold', () => {
  withRealRepo((wt) => {
    const task = { id: 'tbx-1' };
    const out = resolveAgenticDraft(task, {
      result: {
        response: 'I completed full orientation but exhausted my turn budget before writing any edits. No design decisions remain -- please re-run the implementation pass.\n\nRESOLUTION: needs-human-decision\nThe pass ran out of its turn budget; re-run it.',
        forcedSummary: true,
        turnsUsed: 35,
        toolCallLog: [{ tool: 'grep_codebase' }, { tool: 'read_file' }, { tool: 'read_file' }, { tool: 'list_directory' }],
      },
      worktreeDir: wt,
    });
    assert.equal(out.blocked, true);
    assert.equal(out.needsClarification, undefined);
    assert.equal(task.turnBudgetExhausted, true);
    assert.equal(task.retryableDraftBlock, true);
    assert.equal(task.turnBudgetExhaustedBefore, true);
    assert.equal(task.adhocResolution, undefined, 'no fake needs-human-decision');
    assert.match(out.blockedReason, /exhausted its turn budget on orientation/);
  });
});

test('resolveAgenticDraft(needs-human-decision): forcedSummary + zero edits but a GENUINE question still goes to a human', () => {
  withRealRepo((wt) => {
    const task = { id: 'tbx-2' };
    const out = resolveAgenticDraft(task, {
      result: {
        response: 'RESOLUTION: needs-human-decision\nShould the install endpoint 402 or 403 for paid plugins? I could not determine the convention.',
        forcedSummary: true,
        turnsUsed: 35,
        toolCallLog: [{ tool: 'grep_codebase' }, { tool: 'read_file' }],
      },
      worktreeDir: wt,
    });
    assert.equal(out.needsClarification, true);
    assert.equal(task.adhocResolution, 'needs-human-decision');
    assert.notEqual(task.turnBudgetExhausted, true);
  });
});

test('resolveAgenticDraft(needs-human-decision): "re-run me" text but an edit_file call landed -> stays the human/continuation path, not a turn-budget block', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'partial\n');
    const task = { id: 'tbx-3' };
    const out = resolveAgenticDraft(task, {
      result: {
        response: 'RESOLUTION: needs-human-decision\nNo open design question, just ran out of turns -- re-run me.',
        forcedSummary: true,
        toolCallLog: [{ tool: 'read_file' }, { tool: 'edit_file' }],
      },
      worktreeDir: wt,
    });
    assert.notEqual(task.turnBudgetExhausted, true);
    assert.equal(task.isAgenticContinuation, true);
  });
});

test('resolveAgenticDraft: no RESOLUTION line -> blocked (terminal, not an infra failure)', () => {
  withRealRepo((wt) => {
    const out = resolveAgenticDraft({ id: 't4' }, { result: { response: 'I looked around but never concluded' }, worktreeDir: wt });
    assert.equal(out.succeeded, true);
    assert.equal(out.blocked, true);
    assert.match(out.blockedReason, /did not end with a RESOLUTION/);
  });
});

test('resolveAgenticDraft: no RESOLUTION line but result.forcedSummary -> needsClarification with the transcript + partial diff, not a block', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'half a change\n');
    const task = { id: 't4b' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'I ran out of turns while still reading files', forcedSummary: true, turnsUsed: 35 },
      worktreeDir: wt,
    });
    assert.equal(out.succeeded, true);
    assert.equal(out.blocked, false);
    assert.equal(out.needsClarification, true);
    assert.equal(task.adhocResolution, 'needs-human-decision');
    assert.match(task.implementResponse, /ran out of turns/);
    assert.match(out.capturedDiff, /a\.txt/); // whatever partial work landed is preserved
  });
});

test('resolveAgenticDraft: forcedSummary + zero edits + empty worktree -> clean retryable BLOCK with turnBudgetExhausted, not a fake needs-human-decision', () => {
  withRealRepo((wt) => {
    const task = { id: 't4d' };
    const out = resolveAgenticDraft(task, {
      result: {
        response: '', forcedSummary: true, turnsUsed: 35,
        toolCallLog: [{ tool: 'grep_codebase' }, { tool: 'read_file' }, { tool: 'run_bash' }],
      },
      worktreeDir: wt,
    });
    assert.equal(out.succeeded, true);
    assert.equal(out.blocked, true);
    assert.match(out.blockedReason, /without making any edits/);
    assert.ok(!out.needsClarification);
    assert.equal(task.turnBudgetExhausted, true);
    assert.equal(task.turnBudgetExhaustedBefore, true, 'sticky flag survives reject-retry-check so a leaf may decompose on the next pass');
    assert.equal(task.retryableDraftBlock, true, 'reject-retry-check requeues this');
    assert.equal(task.adhocResolution, undefined, 'no fake needs-human-decision');
    assert.equal(task.implementResponse, undefined, 'no placeholder string written');
  });
});

test('resolveAgenticDraft: RESOLUTION: decompose with no sub-task JSON -> retryable BLOCK', () => {
  withRealRepo((wt) => {
    const task = { id: 't2b' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: decompose\nsplit it into a few pieces (no JSON here)' },
      worktreeDir: wt,
    });
    assert.equal(out.blocked, true);
    assert.match(out.blockedReason, /no valid JSON array of \{title, rawText\}/);
    assert.equal(task.retryableDraftBlock, true);
    assert.equal(task.turnBudgetExhausted, false, 'not a turn-budget case');
    assert.equal(task.decomposeBlockCount, 1, 'counts toward the repeated-decompose backstop');
    assert.ok(!task.subTaskProposals);
    assert.ok(!task.rescopedFromDecompose);
  });
});

test('resolveAgenticDraft: decomposeBlockCount accumulates across passes (malformed then re-scope) -> reaches the backstop threshold', () => {
  withRealRepo((wt) => {
    const task = { id: 't2b2' };
    resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: decompose\nno json here' }, worktreeDir: wt,
    });
    assert.equal(task.decomposeBlockCount, 1);
    // reject-retry-check would requeue here (it does NOT reset decomposeBlockCount); next pass:
    delete task.retryableDraftBlock;
    resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: decompose\n[{"title":"one","rawText":"just one piece"}]\natomic' }, worktreeDir: wt,
    });
    assert.equal(task.decomposeBlockCount, 2, 'the local-agentic-write repeated-decompose backstop fires at 2');
    assert.equal(task.rescopedFromDecompose, true);
  });
});

test('resolveAgenticDraft: RESOLUTION: decompose into exactly ONE sub-task -> re-scope + retryable block (once)', () => {
  withRealRepo((wt) => {
    const task = { id: 't2c' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: decompose\n[{"title":"add the route","rawText":"add POST /api/chat/inject to app.py"}]\nit is really one atomic change' },
      worktreeDir: wt,
    });
    assert.equal(out.blocked, true);
    assert.match(out.blockedReason, /re-scoped this to a single sharper sub-task/);
    assert.equal(task.retryableDraftBlock, true);
    assert.equal(task.rescopedFromDecompose, true);
    assert.equal(task.rescopedRawText, 'add POST /api/chat/inject to app.py');
    assert.equal(task.decomposeBlockCount, 1, 'a decompose-to-one also counts toward the backstop');
    assert.ok(!task.subTaskProposals);
  });
});

test('resolveAgenticDraft: decompose-into-ONE again after already being re-scoped -> needs-human-decision', () => {
  withRealRepo((wt) => {
    const task = { id: 't2d', rescopedFromDecompose: true };
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: decompose\n[{"title":"still one","rawText":"the same one thing"}]\nstill atomic' },
      worktreeDir: wt,
    });
    assert.equal(out.blocked, false);
    assert.equal(out.needsClarification, true);
    assert.equal(task.adhocResolution, 'needs-human-decision');
    assert.match(task.implementResponse, /twice without implementing/);
  });
});

test('resolveAgenticDraft: forcedSummary + an edit_file call keeps the needs-human-decision path even with an empty worktree', () => {
  withRealRepo((wt) => {
    const task = { id: 't4e' };
    const out = resolveAgenticDraft(task, {
      result: {
        response: 'I edited but then ran out of budget', forcedSummary: true, turnsUsed: 35,
        toolCallLog: [{ tool: 'read_file' }, { tool: 'edit_file' }],
      },
      worktreeDir: wt,
    });
    assert.equal(out.blocked, false);
    assert.equal(out.needsClarification, true);
    assert.equal(task.adhocResolution, 'needs-human-decision');
    assert.equal(task.turnBudgetExhausted, false);
  });
});

test('resolveAgenticDraft: turnBudgetExhausted is cleared on a normal implemented outcome', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
    const task = { id: 't4f', turnBudgetExhausted: true };
    resolveAgenticDraft(task, { result: { response: 'RESOLUTION: implemented\ndone' }, worktreeDir: wt });
    assert.equal(task.turnBudgetExhausted, false);
    assert.equal(task.adhocResolution, 'implemented');
  });
});

test('resolveAgenticDraft: forcedSummary that DID reach a RESOLUTION is parsed normally', () => {
  withRealRepo((wt) => {
    const task = { id: 't4c' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'out of turns, best guess:\n\nRESOLUTION: decompose\n[{"title":"p1","rawText":"a"},{"title":"p2","rawText":"b"}]\ntoo big', forcedSummary: true },
      worktreeDir: wt,
    });
    assert.equal(out.blocked, false);
    assert.equal(task.subTaskProposals.length, 2);
  });
});

test('resolveAgenticDraft: degenerate result -> blocked', () => {
  withRealRepo((wt) => {
    const out = resolveAgenticDraft({ id: 't5' }, { result: { degenerate: 'repetition-loop' }, worktreeDir: wt });
    assert.equal(out.blocked, true);
    assert.match(out.blockedReason, /degenerate: repetition-loop/);
  });
});
