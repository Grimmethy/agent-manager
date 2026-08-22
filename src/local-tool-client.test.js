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
