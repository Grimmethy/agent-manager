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

test('readFileTool truncates an oversized file rather than returning it whole', () => {
  withFixtureRepo((mod, dir) => {
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(9000));
    const result = mod.readFileTool({ path: 'big.txt' });
    assert.equal(result.truncated, true);
    assert.ok(result.content.length < 9000);
    assert.match(result.content, /\.\.\.\[truncated\]$/);
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
    postJson: async (_url, body) => { sentBodies.push(body); return { message: queue.length ? queue.shift() : {} }; },
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
