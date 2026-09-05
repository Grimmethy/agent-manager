'use strict';

// Unit tests for local-tool-client.js's read-only file-exploration tools (read_file,
// list_directory, added 2026-08-22 alongside the pre-existing grep_codebase). No real
// Ollama call here -- these tools are pure functions against a real temp fixture repo;
// runPlanWithTools()'s own multi-turn loop already has its network call mocked out
// wherever it's exercised elsewhere in this package's callers.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

function withFixtureRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tool-client-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  delete require.cache[require.resolve('./local-tool-client.js')];
  const mod = require('./local-tool-client.js');
  return fn(mod, dir);
}

test('readFileTool reads a real file relative to the repo root', () => {
  withFixtureRepo((mod, dir) => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'example.js'), 'const x = 1;\n');
    const result = mod.readFileTool({ path: 'src/example.js' });
    assert.equal(result.content, 'const x = 1;\n');
    assert.equal(result.truncated, false);
    assert.equal(result.error, undefined);
  });
});

test('readFileTool char-truncates a pathologically long single line rather than returning it whole', () => {
  withFixtureRepo((mod, dir) => {
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(9000));
    const result = mod.readFileTool({ path: 'big.txt' });
    assert.equal(result.truncated, true);
    assert.ok(result.content.length < 9000);
    assert.match(result.content, /\[truncated: slice exceeded/);
  });
});

test('readFileTool returns a bounded line window for offset+limit', () => {
  withFixtureRepo((mod, dir) => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(dir, 'many.txt'), lines);
    const result = mod.readFileTool({ path: 'many.txt', offset: 500, limit: 40 });
    assert.equal(result.offset, 500);
    assert.equal(result.totalLines, 1000);
    assert.equal(result.content.split('\n').length, 40);
    assert.match(result.content, /^line 500\n/);
    assert.match(result.content, /line 539$/);
    assert.equal(result.nextOffset, 540);
    assert.equal(result.truncated, false);
  });
});

test('readFileTool large file with NO window returns a paging notice, not a mid-line HEAD cut', () => {
  withFixtureRepo((mod, dir) => {
    const lines = Array.from({ length: 2000 }, (_, i) => `row ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(dir, 'huge.txt'), lines);
    const result = mod.readFileTool({ path: 'huge.txt' });
    assert.equal(result.offset, 1);
    assert.equal(result.totalLines, 2000);
    assert.equal(result.content.split('\n').length, 400); // READ_FILE_DEFAULT_LINES
    assert.equal(result.nextOffset, 401);
    assert.match(result.notice, /2000 lines/);
    assert.match(result.notice, /offset=401/);
    assert.doesNotMatch(result.content, /row 401/); // did NOT overshoot the window
  });
});

test('readFileTool: limit is clamped to the max, offset past EOF returns empty content + totalLines', () => {
  withFixtureRepo((mod, dir) => {
    const lines = Array.from({ length: 50 }, (_, i) => `L${i}`).join('\n');
    fs.writeFileSync(path.join(dir, 'small.txt'), lines);
    const clamped = mod.readFileTool({ path: 'small.txt', offset: 1, limit: 99999 });
    assert.ok(clamped.limit <= 800);
    assert.equal(clamped.nextOffset, null); // whole small file fit
    const past = mod.readFileTool({ path: 'small.txt', offset: 999 });
    assert.equal(past.content, '');
    assert.equal(past.totalLines, 50);
    assert.equal(past.nextOffset, null);
  });
});

test('readFileTool: small file, no window -> whole content, nextOffset null, no notice', () => {
  withFixtureRepo((mod, dir) => {
    fs.writeFileSync(path.join(dir, 'tiny.js'), 'a\nb\nc\n');
    const result = mod.readFileTool({ path: 'tiny.js' });
    assert.equal(result.content, 'a\nb\nc\n');
    assert.equal(result.nextOffset, null);
    assert.equal(result.notice, undefined);
    assert.equal(result.truncated, false);
  });
});

test('readFileTool returns a clear error string (not a throw) for a missing path arg', () => {
  withFixtureRepo((mod) => {
    assert.doesNotThrow(() => {
      const result = mod.readFileTool({});
      assert.match(result.error, /non-empty "path"/);
    });
  });
});

test('readFileTool returns a clear error string (not a throw) for a nonexistent file', () => {
  withFixtureRepo((mod) => {
    const result = mod.readFileTool({ path: 'does/not/exist.js' });
    assert.match(result.error, /could not read/);
  });
});

test('readFileTool refuses a path that escapes the repo root', () => {
  withFixtureRepo((mod) => {
    const result = mod.readFileTool({ path: '../../etc/passwd' });
    assert.match(result.error, /not inside any accessible repo/);
  });
});

test('listDirectoryTool lists real files/subdirectories with their kind, one level deep', () => {
  withFixtureRepo((mod, dir) => {
    fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '');
    fs.writeFileSync(path.join(dir, 'src', 'b.js'), '');
    const result = mod.listDirectoryTool({ path: 'src' });
    const names = result.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['a.js', 'b.js', 'nested']);
    const nested = result.entries.find((e) => e.name === 'nested');
    assert.equal(nested.type, 'directory');
    const file = result.entries.find((e) => e.name === 'a.js');
    assert.equal(file.type, 'file');
  });
});

test('listDirectoryTool defaults to the repo root when no path is given', () => {
  withFixtureRepo((mod, dir) => {
    fs.writeFileSync(path.join(dir, 'top.txt'), '');
    const result = mod.listDirectoryTool({});
    assert.ok(result.entries.some((e) => e.name === 'top.txt'));
  });
});

test('listDirectoryTool refuses a path that escapes the repo root', () => {
  withFixtureRepo((mod) => {
    const result = mod.listDirectoryTool({ path: '../' });
    assert.match(result.error, /not inside any accessible repo/);
  });
});

test('listDirectoryTool returns a clear error string (not a throw) for a nonexistent directory', () => {
  withFixtureRepo((mod) => {
    const result = mod.listDirectoryTool({ path: 'does/not/exist' });
    assert.match(result.error, /could not list/);
  });
});

test('TOOLS declares exactly the read-only tools (grep_codebase, read_file, list_directory, list_roots) -- no write/edit/bash tool', () => {
  withFixtureRepo((mod) => {
    const names = mod.TOOLS.map((t) => t.function.name).sort();
    assert.deepEqual(names, ['grep_codebase', 'list_directory', 'list_roots', 'read_file']);
  });
});

// Chat panel (2026-08-24): write_file/edit_file/run_bash, deliberately kept OUT of TOOLS
// above -- opt-in only via runPlanWithTools({allowWrite: true}), never the arch_discovery
// default. Exported as standalone functions the same way readFileTool/listDirectoryTool
// already are, so they're testable as pure functions with no real Ollama call.

test('writeFileTool creates a new file with the given content', () => {
  withFixtureRepo((mod, dir) => {
    const result = mod.writeFileTool({ path: 'new/file.txt', content: 'hello\n' });
    assert.equal(result.written, true);
    assert.equal(fs.readFileSync(path.join(dir, 'new', 'file.txt'), 'utf8'), 'hello\n');
  });
});

test('writeFileTool overwrites an existing file', () => {
  withFixtureRepo((mod, dir) => {
    fs.writeFileSync(path.join(dir, 'existing.txt'), 'old\n');
    mod.writeFileTool({ path: 'existing.txt', content: 'new\n' });
    assert.equal(fs.readFileSync(path.join(dir, 'existing.txt'), 'utf8'), 'new\n');
  });
});

test('writeFileTool refuses a path that escapes the repo root', () => {
  withFixtureRepo((mod) => {
    const result = mod.writeFileTool({ path: '../../etc/passwd', content: 'x' });
    assert.match(result.error, /not inside any accessible repo/);
  });
});

test('editFileTool replaces a unique, verbatim match', () => {
  withFixtureRepo((mod, dir) => {
    fs.writeFileSync(path.join(dir, 'f.js'), 'const x = 1;\nconst y = 2;\n');
    const result = mod.editFileTool({ path: 'f.js', find: 'const x = 1;', replace: 'const x = 100;' });
    assert.equal(result.edited, true);
    assert.equal(fs.readFileSync(path.join(dir, 'f.js'), 'utf8'), 'const x = 100;\nconst y = 2;\n');
  });
});

test('editFileTool errors, without editing, when "find" is not found verbatim', () => {
  withFixtureRepo((mod, dir) => {
    fs.writeFileSync(path.join(dir, 'f.js'), 'const x = 1;\n');
    const result = mod.editFileTool({ path: 'f.js', find: 'const x = 999;', replace: 'whatever' });
    assert.match(result.error, /not found verbatim/);
    assert.equal(fs.readFileSync(path.join(dir, 'f.js'), 'utf8'), 'const x = 1;\n');
  });
});

test('editFileTool errors, without editing, when "find" matches more than once', () => {
  withFixtureRepo((mod, dir) => {
    fs.writeFileSync(path.join(dir, 'f.js'), 'x\nx\n');
    const result = mod.editFileTool({ path: 'f.js', find: 'x', replace: 'y' });
    assert.match(result.error, /matches 2 places/);
    assert.equal(fs.readFileSync(path.join(dir, 'f.js'), 'utf8'), 'x\nx\n');
  });
});

test('runBashTool runs a real command in the repo root and captures stdout', () => {
  withFixtureRepo((mod, dir) => {
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'present\n');
    const result = mod.runBashTool({ command: 'cat marker.txt' });
    // bwrap may or may not be installed on the test host -- either a real sandboxed
    // result or the documented fail-closed error is acceptable, but never a throw and
    // never a silent unsandboxed fallback (see this tool's own "fails CLOSED" comment).
    if (result.error) {
      assert.match(result.error, /sandbox \(bwrap\) is not available/);
    } else {
      assert.match(result.stdout, /present/);
      assert.equal(result.exitCode, 0);
    }
  });
});

test('WRITE_TOOLS declares exactly write_file, edit_file, and run_bash', () => {
  withFixtureRepo((mod) => {
    const names = mod.WRITE_TOOLS.map((t) => t.function.name).sort();
    assert.deepEqual(names, ['edit_file', 'run_bash', 'write_file']);
  });
});

// Regression, 2026-08-24: caught live within minutes of the Chat panel shipping -- app.py
// used to wrap chat_sessions.send_message()'s ENTIRE call in apply-task.sh's own
// git-safety mutex, held for however long the whole turn took (a local-provider turn can
// legitimately wait minutes on the GPU lock alone), so a second, completely unrelated
// Chat message got "the pipeline is mid-apply right now" while nothing was actually
// applying. Moved the real protection down to withApplyLock, held only around the single
// git-mutating command execution in runBashTool -- these tests prove withApplyLock itself
// really uses the SAME fixed lockfile apply-task.sh/api_git_merge_branch already flock
// (same file, same real interop already proven all session), not an isolated one, since
// that's the entire point -- it has to coordinate with the real apply-task-loop.
test('withApplyLock uses the same fixed lockfile apply-task.sh itself flocks', () => {
  withFixtureRepo((mod) => {
    assert.equal(mod.APPLY_LOCK_PATH, path.join(os.homedir(), '.local', 'state', 'agent-manager', 'locks', 'apply-task.lock'));
  });
});

test('withApplyLock genuinely blocks a concurrent real bash flock attempt on the same file while held', () => {
  // Deliberately checks ONLY the "blocked while held" half, not "free immediately after" --
  // this test touches the SAME real, shared, fixed lockfile the actual apply-task-loop
  // daemon on this machine may legitimately hold at any moment (that's the entire point
  // of this lock, see withApplyLock's own header), so asserting the file is free the
  // instant this test releases it would be genuinely flaky if that daemon happens to grab
  // it in the same window -- not a bug in this code, just real, expected contention this
  // test has no business asserting away.
  withFixtureRepo((mod) => {
    let sawHeld = null;
    mod.withApplyLock(() => {
      const result = require('child_process').spawnSync('bash', ['-c', `exec 200>"${mod.APPLY_LOCK_PATH}"; flock -n 200 && echo GOT_IT || echo BLOCKED`]);
      sawHeld = result.stdout.toString();
    });
    assert.match(sawHeld, /BLOCKED/, 'a concurrent flock attempt must fail while withApplyLock holds it');
  });
});

// --- runPlanWithTools() multi-turn loop -------------------------------------------------
// The loop itself had no direct coverage while it lived inline in a 183-line function;
// added alongside its 2026-08-29 decomposition into chatTurnWithFlakeRecovery /
// executeToolCalls / flakeDegradeResult / runWithoutToolsFallback. Ollama's /api/chat is
// stubbed at the ollama-http.js boundary; the single-flight lock is a no-op here.
function withMockedChat(scriptedTurns, fn, { killSwitch = null, localCallResponse = 'fallback reply' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tool-client-loop-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  if (killSwitch) {
    fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue', killSwitch), '');
  }
  const queue = scriptedTurns.slice();
  const stub = (relId, exportsObj) => {
    const resolved = require.resolve(relId);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  };
  for (const relId of ['./ollama-http.js', './single-flight-lock.js', './local-client.js', './local-tool-client.js']) {
    delete require.cache[require.resolve(relId)];
  }
  const sentBodies = [];
  stub('./ollama-http.js', {
    postJson: async (_url, body) => {
      sentBodies.push(body);
      const turn = queue.length ? queue.shift() : {};
      // A scripted turn may carry `_usage: { prompt_eval_count, eval_count }` to exercise
      // token accounting -- lift it onto the response envelope where Ollama really puts it.
      const { _usage, ...message } = turn || {};
      return { message, ...(_usage || {}) };
    },
    postJsonStream: async () => { throw new Error('streaming path not exercised in this test'); },
  });
  stub('./single-flight-lock.js', { withLock: (_dir, f) => f() });
  stub('./local-client.js', { call: async () => ({ response: localCallResponse }), KEEP_ALIVE: '30m' });
  try {
    const mod = require('./local-tool-client.js');
    return fn(mod, dir, { sentBodies });
  } finally {
    for (const relId of ['./ollama-http.js', './single-flight-lock.js', './local-client.js', './local-tool-client.js']) {
      delete require.cache[require.resolve(relId)];
    }
  }
}

test('runPlanWithTools returns the model reply immediately when the first turn has no tool calls', async () => {
  await withMockedChat([{ role: 'assistant', content: 'here is the answer' }], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'hi' });
    assert.equal(result.response, 'here is the answer');
    assert.equal(result.turnsUsed, 1);
    assert.equal(result.toolsDisabled, false);
    assert.deepEqual(result.toolCallLog, []);
  });
});

test('every /api/chat turn carries keep_alive (the exported local-client KEEP_ALIVE) so the model does not unload between agentic turns', async () => {
  await withMockedChat([
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] },
    { role: 'assistant', content: 'done' },
  ], async (mod, _dir, { sentBodies }) => {
    await mod.runPlanWithTools({ prompt: 'go' });
    assert.ok(sentBodies.length >= 2, 'both turns hit /api/chat');
    for (const body of sentBodies) {
      assert.equal(body.keep_alive, '30m', 'keep_alive is sent on every turn, not just the first');
      assert.equal(body.options.num_ctx, require('./gpu-capacity.js').PINNED_NUM_CTX);
    }
  });
});

test('runPlanWithTools executes a tool call, feeds the result back, and returns the next-turn reply', async () => {
  await withMockedChat([
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] },
    { role: 'assistant', content: 'done exploring' },
  ], async (mod, dir) => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const result = await mod.runPlanWithTools({ prompt: 'look around' });
    assert.equal(result.response, 'done exploring');
    assert.equal(result.turnsUsed, 2);
    assert.equal(result.toolCallLog.length, 1);
    assert.equal(result.toolCallLog[0].tool, 'list_directory');
    assert.ok(Array.isArray(result.toolCallLog[0].result.entries), 'the real list_directory handler ran');
    assert.ok(result.toolCallLog[0].result.entries.some((e) => e.name === 'a.txt'));
  });
});

test('runPlanWithTools reports an unknown tool as an error string result and keeps going', async () => {
  await withMockedChat([
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'nonexistent_tool', arguments: {} } }] },
    { role: 'assistant', content: 'recovered' },
  ], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'go' });
    assert.equal(result.response, 'recovered');
    assert.deepEqual(result.toolCallLog[0].result, { error: 'unknown tool: nonexistent_tool' });
  });
});

test('runPlanWithTools force-stops at maxTurns when the model never stops calling tools', async () => {
  const toolTurn = { role: 'assistant', content: 'still working', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
  await withMockedChat([toolTurn, toolTurn, toolTurn, toolTurn], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'go', maxTurns: 2 });
    assert.equal(result.turnsUsed, 2);
    assert.equal(result.response, 'still working', 'returns the last turn\'s content on a forced stop');
    assert.equal(result.toolCallLog.length, 2);
    assert.equal(result.forcedSummary, undefined, 'no forced summary turn unless the caller opts in');
  });
});

test('runPlanWithTools with forceSummaryOnCap spends one extra no-tools turn for a RESOLUTION when the cap is hit', async () => {
  const toolTurn = { role: 'assistant', content: 'still working', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
  const summaryTurn = { role: 'assistant', content: 'out of time.\n\nRESOLUTION: needs-human-decision\nwhich approach?' };
  await withMockedChat([toolTurn, toolTurn, summaryTurn], async (mod, _dir, { sentBodies }) => {
    const result = await mod.runPlanWithTools({ prompt: 'go', maxTurns: 2, forceSummaryOnCap: true });
    assert.equal(result.forcedSummary, true);
    assert.equal(result.turnsUsed, 3, 'the forced summary turn counts');
    assert.match(result.response, /RESOLUTION: needs-human-decision/);
    // the extra turn asked the model to stop and offered no tools
    const last = sentBodies[sentBodies.length - 1];
    assert.deepEqual(last.tools, []);
    assert.match(last.messages[last.messages.length - 1].content, /out of turns/i);
  });
});

test('runPlanWithTools with forceSummaryOnCap does NOT add a turn when the model finishes cleanly before the cap', async () => {
  await withMockedChat([
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] },
    { role: 'assistant', content: 'RESOLUTION: implemented' },
  ], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'go', maxTurns: 10, forceSummaryOnCap: true });
    assert.equal(result.response, 'RESOLUTION: implemented');
    assert.equal(result.turnsUsed, 2);
    assert.equal(result.forcedSummary, undefined);
  });
});

test('runPlanWithTools with forceSummaryOnCap adds a turn when the model STOPS EARLY with no RESOLUTION line', async () => {
  const toolTurn = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
  const earlyStop = { role: 'assistant', content: 'I have looked around and I think the modal lives in ui.js.' };
  const summaryTurn = { role: 'assistant', content: 'Final answer.\n\nRESOLUTION: needs-human-decision\nwhich file owns the header?' };
  await withMockedChat([toolTurn, earlyStop, summaryTurn], async (mod, _dir, { sentBodies }) => {
    // cap is 10 but the model quits after turn 2 -- the forced turn still fires
    const result = await mod.runPlanWithTools({ prompt: 'go', maxTurns: 10, forceSummaryOnCap: true });
    assert.equal(result.forcedSummary, true);
    assert.equal(result.turnsUsed, 3, 'the early stop (2) plus the forced summary turn');
    assert.match(result.response, /RESOLUTION: needs-human-decision/);
    const last = sentBodies[sentBodies.length - 1];
    assert.deepEqual(last.tools, []);
  });
});

test('runPlanWithTools with forceSummaryOnCap does NOT add a turn when an early stop already has a RESOLUTION line', async () => {
  const toolTurn = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
  const earlyStop = { role: 'assistant', content: 'Done.\n\nRESOLUTION: no-changes-needed\nthe behaviour is already correct.' };
  await withMockedChat([toolTurn, earlyStop], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'go', maxTurns: 10, forceSummaryOnCap: true });
    assert.equal(result.turnsUsed, 2);
    assert.equal(result.forcedSummary, undefined);
    assert.match(result.response, /RESOLUTION: no-changes-needed/);
  });
});

test('runPlanWithTools drops to the no-tools fallback (toolsDisabled) when the kill switch file is present', async () => {
  await withMockedChat([], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'hi' });
    assert.equal(result.toolsDisabled, true);
    assert.equal(result.turnsUsed, 0);
    assert.equal(result.response, 'fallback reply');
    assert.deepEqual(result.toolCallLog, []);
  }, { killSwitch: '.arch-discovery-tools-disabled' });
});

// --- empty-completion flake recovery + narration-nudge (2026-09-05, Chat panel "stalls
// after declaring a tool call") ------------------------------------------------------

test('runPlanWithTools resamples past an empty completion (no content, no tool_calls) instead of returning it as the final answer', async () => {
  const empty = { role: 'assistant', content: '' };
  await withMockedChat([empty, empty, { role: 'assistant', content: 'real answer' }], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'say something', maxTurns: 5 });
    assert.equal(result.response, 'real answer', 'must not settle for the two blank samples that came first');
    assert.equal(result.turnsUsed, 1, 'the empty resamples happen inside ONE outer turn, not three');
  });
});

test('runPlanWithTools rejects (does not silently return blank) when the FIRST turn never recovers from empty completions', async () => {
  // CHAT_FLAKE_MAX_ATTEMPTS is 3 -- three empty samples in a row exhausts the retry budget,
  // and there is no prior lastMessage (this is the very first turn) to gracefully degrade to.
  const empty = { role: 'assistant', content: '' };
  await withMockedChat([empty, empty, empty], async (mod) => {
    await assert.rejects(
      () => mod.runPlanWithTools({ prompt: 'say something', maxTurns: 5 }),
      /empty completion/i,
    );
  });
});

test('runPlanWithTools gracefully degrades (does not silently return blank) when a LATER turn never recovers from empty completions', async () => {
  const realFirstTurn = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
  const empty = { role: 'assistant', content: '' };
  await withMockedChat([realFirstTurn, empty, empty, empty], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'go', maxTurns: 5 });
    assert.match(result.response, /lost the connection/i, 'degrades with the existing flake explainer note, same as the "no user query" bug\'s degrade path');
  });
});

test('runPlanWithTools nudges once when the model narrates an action without calling the tool, then accepts the real follow-up answer', async () => {
  await withMockedChat([
    { role: 'assistant', content: 'Let me check the file for you.' },
    { role: 'assistant', content: 'Confirmed, done.' },
  ], async (mod, _dir, { sentBodies }) => {
    const result = await mod.runPlanWithTools({ prompt: 'investigate X', maxTurns: 5 });
    assert.equal(result.response, 'Confirmed, done.', 'the narration itself must never be returned as the final answer');
    assert.equal(result.turnsUsed, 2, 'the nudge consumes one real turn from the budget');
    const secondCallMessages = sentBodies[1].messages;
    assert.match(secondCallMessages[secondCallMessages.length - 1].content, /without actually calling/i);
  });
});

test('runPlanWithTools caps narration nudges at MAX_NARRATION_NUDGES then accepts the narration as final rather than nudging forever', async () => {
  const narrated = { role: 'assistant', content: "Let me look into that." };
  await withMockedChat([narrated, narrated, narrated], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'go', maxTurns: 5 });
    assert.equal(result.response, 'Let me look into that.', 'after the cap, the narration is accepted rather than nudged a third time');
    assert.equal(result.turnsUsed, 3, 'two nudged turns plus the one that was finally accepted');
  });
});

test('runPlanWithTools does not nudge normal, non-narrating final content (regression guard on the existing no-tool-calls path)', async () => {
  await withMockedChat([{ role: 'assistant', content: 'here is the answer' }], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'hi' });
    assert.equal(result.response, 'here is the answer');
    assert.equal(result.turnsUsed, 1);
  });
});

// --- multi-root (2026-08-31, system-wide Chat panel) ---------------------------------

test('resolveInsideRoots: a relative path resolves against the primary (first) root', () => {
  withFixtureRepo((mod, dir) => {
    const r = mod.resolveInsideRoots([dir, os.tmpdir()], 'src/x.js');
    assert.equal(r.root, path.resolve(dir));
    assert.equal(r.full, path.join(path.resolve(dir), 'src/x.js'));
  });
});

test('resolveInsideRoots: an absolute path inside a non-primary root is accepted, tagged with that root', () => {
  withFixtureRepo((mod) => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ltc-other-'));
    const r = mod.resolveInsideRoots([os.homedir(), other], path.join(other, 'a/b.txt'));
    assert.equal(r.root, path.resolve(other));
  });
});

test('resolveInsideRoots: an absolute path outside every allowed root is rejected', () => {
  withFixtureRepo((mod, dir) => {
    assert.equal(mod.resolveInsideRoots([dir], '/etc/passwd'), null);
  });
});

test('listRootsTool reports the primary first, each with a name and primary flag', () => {
  withFixtureRepo((mod, dir) => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ltc-other-'));
    const out = mod.listRootsTool([dir, other]);
    assert.equal(out.primary, dir);
    assert.equal(out.roots[0].primary, true);
    assert.equal(out.roots[1].primary, false);
    assert.equal(out.roots[1].name, path.basename(other));
  });
});

test('buildToolHandlers/read_file: relative path -> primary repo; absolute path -> a second root', () => {
  withFixtureRepo((mod, dir) => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ltc-other-'));
    fs.writeFileSync(path.join(dir, 'here.txt'), 'PRIMARY\n');
    fs.writeFileSync(path.join(other, 'there.txt'), 'SECONDARY\n');
    const h = mod.buildToolHandlers([dir, other]);
    assert.equal(h.read_file({ path: 'here.txt' }).content, 'PRIMARY\n');
    assert.equal(h.read_file({ path: path.join(other, 'there.txt') }).content, 'SECONDARY\n');
    assert.match(h.read_file({ path: '/etc/hostname' }).error, /not inside any accessible repo/);
  });
});

test('buildWriteToolHandlers/write_file can write into a non-primary root (edit-any-root)', () => {
  withFixtureRepo((mod, dir) => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ltc-other-'));
    const h = mod.buildWriteToolHandlers([dir, other]);
    const res = h.write_file({ path: path.join(other, 'sub/new.txt'), content: 'x\n' });
    assert.equal(res.written, true);
    assert.equal(fs.readFileSync(path.join(other, 'sub/new.txt'), 'utf8'), 'x\n');
  });
});

test('single-arg tool calls still work (roots default to the configured repoRoot)', () => {
  withFixtureRepo((mod, dir) => {
    fs.writeFileSync(path.join(dir, 'solo.txt'), 'solo\n');
    assert.equal(mod.readFileTool({ path: 'solo.txt' }).content, 'solo\n');
    assert.match(mod.readFileTool({ path: '../../etc/passwd' }).error, /not inside any accessible repo/);
  });
});

test('buildToolHandlers/grep_codebase rejects a `root` that is not one of the allowed roots', () => {
  withFixtureRepo((mod, dir) => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltc-other-')));
    const h = mod.buildToolHandlers([fs.realpathSync(dir), other]);
    // allowed root -> ok (no throw, returns an array)
    assert.ok(Array.isArray(h.grep_codebase({ query: 'x', dir: '.', root: other })));
    // some other path -> refused
    assert.match(h.grep_codebase({ query: 'x', dir: '.', root: os.homedir() }).error, /not an accessible repo/);
  });
});

// --- Edit-by-turn-N forcing function (nudgeToEditEarly) --------------------------------

test('nudgeToEditEarly: after ORIENT_TURN_LIMIT turns with zero edits, one "stop exploring" message is injected', async () => {
  const prev = process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS;
  process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS = '3';
  try {
    const explore = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
    const finish = { role: 'assistant', content: 'RESOLUTION: needs-human-decision\nwhich approach?' };
    // turns 1..5 explore, turn 6 concludes
    await withMockedChat([explore, explore, explore, explore, explore, finish], async (mod, _dir, { sentBodies }) => {
      const result = await mod.runPlanWithTools({ prompt: 'go', maxTurns: 10, nudgeToEditEarly: true });
      assert.match(result.response, /needs-human-decision/);
      // withMockedChat stores each request body BY REFERENCE and runPlanWithTools mutates
      // `messages` in place, so every sentBodies[i].messages is the same, final array --
      // assert on that final conversation instead of on per-request snapshots.
      const msgs = sentBodies[sentBodies.length - 1].messages;
      const nudgeIdx = msgs.findIndex((m) => m.role === 'user' && /Stop exploring now/.test(m.content || ''));
      assert.ok(nudgeIdx > 0, 'a nudge message was injected');
      assert.equal(msgs.filter((m) => m.role === 'user' && /Stop exploring now/.test(m.content || '')).length, 1, 'exactly one nudge, ever');
      // it lands only after the orientation budget (3) is spent: >= 3 assistant turns before it
      const assistantsBeforeNudge = msgs.slice(0, nudgeIdx).filter((m) => m.role === 'assistant').length;
      assert.ok(assistantsBeforeNudge >= 3, `nudge should follow >= 3 explore turns, followed ${assistantsBeforeNudge}`);
    });
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS;
    else process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS = prev;
  }
});

test('nudgeToEditEarly: NO nudge when the model edits within the orientation budget', async () => {
  const prev = process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS;
  process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS = '3';
  try {
    const explore = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
    const edit = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'edit_file', arguments: { path: 'a.txt', find: 'x', replace: 'y' } } }] };
    const finish = { role: 'assistant', content: 'RESOLUTION: implemented\ndid it' };
    await withMockedChat([explore, edit, explore, explore, explore, finish], async (mod, dir, { sentBodies }) => {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
      await mod.runPlanWithTools({ prompt: 'go', maxTurns: 10, nudgeToEditEarly: true, primaryRoot: dir });
      const nudged = sentBodies.some((b) => (b.messages || []).some((m) => m.role === 'user' && /Stop exploring now/.test(m.content || '')));
      assert.equal(nudged, false, 'an edit within the budget suppresses the nudge');
    });
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS;
    else process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS = prev;
  }
});

test('nudgeToEditEarly defaults off: a normal run gets no nudge', async () => {
  const explore = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
  await withMockedChat([explore, explore, explore, { role: 'assistant', content: 'done' }], async (mod, _dir, { sentBodies }) => {
    await mod.runPlanWithTools({ prompt: 'go', maxTurns: 20 });
    assert.ok(!sentBodies.some((b) => (b.messages || []).some((m) => /Stop exploring now/.test(m.content || ''))));
  });
});

test('leafMustEdit: a firmer "final warning" fires when a leaf still has not edited after the soft nudge', async () => {
  const prev = process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS;
  process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS = '2';
  try {
    const explore = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
    const finish = { role: 'assistant', content: 'RESOLUTION: needs-human-decision\nI need X' };
    // soft nudge at turn 2, hard nudge at turn >= 5; run explores through then concludes
    await withMockedChat([explore, explore, explore, explore, explore, explore, explore, finish], async (mod, _dir, { sentBodies }) => {
      await mod.runPlanWithTools({ prompt: 'go', maxTurns: 12, nudgeToEditEarly: true, leafMustEdit: true });
      const msgs = sentBodies[sentBodies.length - 1].messages;
      const hard = msgs.filter((m) => m.role === 'user' && /Final warning/.test(m.content || ''));
      assert.equal(hard.length, 1, 'exactly one hard nudge');
      assert.match(hard[0].content, /decompose is not available/i);
    });
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS;
    else process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS = prev;
  }
});

test('leafMustEdit: no hard nudge once an edit has been made', async () => {
  const prev = process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS;
  process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS = '2';
  try {
    const explore = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
    const edit = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'edit_file', arguments: { path: 'a.txt', find: 'x', replace: 'y' } } }] };
    const finish = { role: 'assistant', content: 'RESOLUTION: implemented\ndone' };
    await withMockedChat([explore, explore, explore, edit, explore, explore, explore, finish], async (mod, dir, { sentBodies }) => {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
      await mod.runPlanWithTools({ prompt: 'go', maxTurns: 12, nudgeToEditEarly: true, leafMustEdit: true, primaryRoot: dir });
      assert.ok(!sentBodies.some((b) => (b.messages || []).some((m) => /Final warning/.test(m.content || ''))));
    });
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS;
    else process.env.AGENT_MANAGER_AGENTIC_ORIENT_TURNS = prev;
  }
});

test('leafMustEdit defaults off: no hard nudge for a non-leaf run', async () => {
  const explore = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] };
  const turns = Array.from({ length: 20 }, () => explore).concat([{ role: 'assistant', content: 'done' }]);
  await withMockedChat(turns, async (mod, _dir, { sentBodies }) => {
    await mod.runPlanWithTools({ prompt: 'go', maxTurns: 15, nudgeToEditEarly: true });
    assert.ok(!sentBodies.some((b) => (b.messages || []).some((m) => /Final warning/.test(m.content || ''))));
  });
});

// --- token accounting (2026-09-01) ---------------------------------------------------

test('runPlanWithTools sums Ollama token counts across turns onto the result', async () => {
  const explore = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }], _usage: { prompt_eval_count: 1000, eval_count: 50, eval_duration: 7 } };
  const finish = { role: 'assistant', content: 'RESOLUTION: implemented\ndid it', _usage: { prompt_eval_count: 1500, eval_count: 80, eval_duration: 9 } };
  await withMockedChat([explore, finish], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'go', maxTurns: 5 });
    assert.equal(result.prompt_eval_count, 2500);
    assert.equal(result.eval_count, 130);
    assert.equal(result.eval_duration, 16);
  });
});

test('runPlanWithTools token counts default to 0 when the provider reports none', async () => {
  await withMockedChat([{ role: 'assistant', content: 'hi' }], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'go' });
    assert.equal(result.prompt_eval_count, 0);
    assert.equal(result.eval_count, 0);
  });
});

// --- grep_codebase dir hint + error surfacing --------------------------------------

test('the grep_codebase tool description lists the configured searchable dirs', async () => {
  await withMockedChat([{ role: 'assistant', content: 'ok' }], async (mod, _dir, { sentBodies }) => {
    process.env.AGENT_MANAGER_GREP_DIRS = 'src,python,scripts,docs';
    await mod.runPlanWithTools({ prompt: 'go' });
    const grepTool = (sentBodies[0].tools || []).find((t) => t.function.name === 'grep_codebase');
    assert.match(grepTool.function.parameters.properties.dir.description, /src, python, scripts, docs/);
    delete process.env.AGENT_MANAGER_GREP_DIRS;
  });
});

test('buildToolHandlers/grep_codebase surfaces the unknown-dir error object to the model', () => {
  withFixtureRepo((mod, dir) => {
    process.env.AGENT_MANAGER_GREP_DIRS = 'src';
    const h = mod.buildToolHandlers([fs.realpathSync(dir)]);
    const res = h.grep_codebase({ query: 'x', dir: 'made-up' });
    assert.ok(!Array.isArray(res));
    assert.match(res.error, /unknown dir 'made-up'/);
    delete process.env.AGENT_MANAGER_GREP_DIRS;
  });
});

test('buildToolHandlers/read_file forwards offset and limit', () => {
  withFixtureRepo((mod, dir) => {
    fs.writeFileSync(path.join(dir, 'f.txt'), Array.from({ length: 100 }, (_, i) => `n${i + 1}`).join('\n'));
    const h = mod.buildToolHandlers([fs.realpathSync(dir)]);
    const res = h.read_file({ path: 'f.txt', offset: 10, limit: 5 });
    assert.equal(res.offset, 10);
    assert.equal(res.content.split('\n').length, 5);
    assert.match(res.content, /^n10\n/);
  });
});

// --- streaming (Chat panel) done_reason:"length" visibility (2026-09-05) -------------
// Confirmed live: a real Chat turn ended mid-word ("...and see whatI was mid-invest")
// with no error, no degenerate flag, nothing recorded anywhere -- Ollama's own
// done_reason on the closing NDJSON frame already says exactly what happened, but nothing
// downstream ever looked past done_reason==='error'. These exercise the STREAMING path
// (onChunk present), which withMockedChat's postJsonStream stub deliberately does not
// support -- a separate, minimal stub here scripts a sequence of NDJSON line objects.
function withMockedStreamingChat(turnsOfLines, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tool-client-stream-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  const queue = turnsOfLines.slice();
  const stub = (relId, exportsObj) => {
    const resolved = require.resolve(relId);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  };
  for (const relId of ['./ollama-http.js', './single-flight-lock.js', './local-client.js', './local-tool-client.js']) {
    delete require.cache[require.resolve(relId)];
  }
  stub('./ollama-http.js', {
    postJson: async () => { throw new Error('non-streaming path not exercised in this test'); },
    postJsonStream: async (_url, _body, _timeout, _headers, onLine) => {
      const lines = queue.length ? queue.shift() : [{ done: true, done_reason: 'stop' }];
      for (const line of lines) onLine(line);
    },
  });
  stub('./single-flight-lock.js', { withLock: (_dir, f) => f() });
  stub('./local-client.js', { call: async () => ({ response: 'fallback' }), KEEP_ALIVE: '30m' });
  try {
    const mod = require('./local-tool-client.js');
    return fn(mod, dir);
  } finally {
    for (const relId of ['./ollama-http.js', './single-flight-lock.js', './local-client.js', './local-tool-client.js']) {
      delete require.cache[require.resolve(relId)];
    }
  }
}

test('a streaming turn cut off by done_reason:"length" gets a visible marker appended right where it happened', async () => {
  await withMockedStreamingChat([
    [
      { message: { role: 'assistant', content: 'this got cut ' } },
      { message: { role: 'assistant', content: 'off mid-sen' } },
      { done: true, done_reason: 'length', prompt_eval_count: 1, eval_count: 1 },
    ],
  ], async (mod) => {
    const chunks = [];
    const result = await mod.runPlanWithTools({ prompt: 'go', onChunk: (t) => chunks.push(t) });
    const full = chunks.join('');
    assert.match(full, /this got cut off mid-sen/);
    assert.match(full, /done_reason: "length"/);
    // The marker is a streaming-only debug artifact (onChunk), deliberately NOT folded
    // into result.response -- non-chat callers parsing RESOLUTION lines etc. must never
    // see it, and chat_sessions.py's persisted transcript is built from the streamed
    // chunks (reply_parts), not from result.response, so it still reaches the saved chat.
    assert.equal(result.response.includes('this got cut off mid-sen'), true);
    assert.equal(result.response.includes('done_reason'), false);
  });
});

test('a streaming turn that ends normally (done_reason:"stop") gets no marker', async () => {
  await withMockedStreamingChat([
    [
      { message: { role: 'assistant', content: 'a complete answer' } },
      { done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 },
    ],
  ], async (mod) => {
    const chunks = [];
    await mod.runPlanWithTools({ prompt: 'go', onChunk: (t) => chunks.push(t) });
    assert.doesNotMatch(chunks.join(''), /done_reason/);
  });
});

test('a done_reason:"length" cut-off mid-tool-loop (not just the final turn) still gets flagged inline', async () => {
  await withMockedStreamingChat([
    [
      { message: { role: 'assistant', content: 'thinking about it, cut ', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] } },
      { done: true, done_reason: 'length', prompt_eval_count: 1, eval_count: 1 },
    ],
    [
      { message: { role: 'assistant', content: 'a real final answer' } },
      { done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 },
    ],
  ], async (mod) => {
    const chunks = [];
    const result = await mod.runPlanWithTools({ prompt: 'go', maxTurns: 5, onChunk: (t) => chunks.push(t) });
    const full = chunks.join('');
    assert.match(full, /thinking about it, cut/);
    assert.match(full, /done_reason: "length"/);
    assert.equal(result.response, 'a real final answer');
  });
});

// --- side-finding capture (2026-09-05) -----------------------------------------------

function sideFindingInboxFiles(dir) {
  const inbox = path.join(dir, 'queue', 'side-findings-inbox');
  if (!fs.existsSync(inbox)) return [];
  return fs.readdirSync(inbox).map((f) => JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8')));
}

test('runPlanWithTools injects the SIDE-FINDING instruction into the first message by default', async () => {
  await withMockedChat([{ role: 'assistant', content: 'ok' }], async (mod, _dir, { sentBodies }) => {
    await mod.runPlanWithTools({ prompt: 'do the task' });
    assert.match(sentBodies[0].messages[0].content, /SIDE-FINDING:/);
  });
});

test('runPlanWithTools does not inject when allowSideFindings is false', async () => {
  await withMockedChat([{ role: 'assistant', content: 'ok' }], async (mod, _dir, { sentBodies }) => {
    await mod.runPlanWithTools({ prompt: 'classify this', allowSideFindings: false });
    assert.doesNotMatch(sentBodies[0].messages[0].content, /SIDE-FINDING/);
  });
});

test('runPlanWithTools extracts a SIDE-FINDING block from the final response, returns cleaned text, and files it to the inbox', async () => {
  await withMockedChat([
    { role: 'assistant', content: 'Real answer here.\n\nSIDE-FINDING: Something worth a look\nBody of the finding.' },
  ], async (mod, dir) => {
    const result = await mod.runPlanWithTools({ prompt: 'go', source: 'arch_review', taskId: 'arch-review-ac-1' });
    assert.equal(result.response.includes('SIDE-FINDING'), false);
    assert.match(result.response, /Real answer here\./);
    const files = sideFindingInboxFiles(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].title, 'Something worth a look');
    assert.equal(files[0].source, 'arch_review');
    assert.equal(files[0].taskId, 'arch-review-ac-1');
  });
});

test('runPlanWithTools with allowSideFindings:false never extracts even if the response happens to contain the marker text', async () => {
  await withMockedChat([
    { role: 'assistant', content: 'SIDE-FINDING: should not be extracted\nbody' },
  ], async (mod, dir) => {
    const result = await mod.runPlanWithTools({ prompt: 'classify this', allowSideFindings: false });
    assert.match(result.response, /SIDE-FINDING: should not be extracted/);
    assert.equal(sideFindingInboxFiles(dir).length, 0);
  });
});
