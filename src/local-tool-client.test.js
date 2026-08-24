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
    assert.match(result.error, /escapes the repo root/);
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
    assert.match(result.error, /escapes the repo root/);
  });
});

test('listDirectoryTool returns a clear error string (not a throw) for a nonexistent directory', () => {
  withFixtureRepo((mod) => {
    const result = mod.listDirectoryTool({ path: 'does/not/exist' });
    assert.match(result.error, /could not list/);
  });
});

test('TOOLS declares exactly grep_codebase, read_file, and list_directory -- no write/edit/bash tool', () => {
  withFixtureRepo((mod) => {
    const names = mod.TOOLS.map((t) => t.function.name).sort();
    assert.deepEqual(names, ['grep_codebase', 'list_directory', 'read_file']);
  });
});

// Ghost panel (2026-08-24): write_file/edit_file/run_bash, deliberately kept OUT of TOOLS
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
    assert.match(result.error, /escapes the repo root/);
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
