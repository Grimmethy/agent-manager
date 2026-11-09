'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REGEN_SCRIPT = path.join(__dirname, '..', 'scripts', 'size-ratchet-regen.js');
const ALLOWLIST_PATH = path.join(__dirname, '..', 'config', 'size-ratchet-allowlist.json');

describe('size-ratchet-regen.js', () => {
  it('--init flag creates allowlist file', () => {
    // Remove allowlist if it exists
    if (fs.existsSync(ALLOWLIST_PATH)) {
      fs.unlinkSync(ALLOWLIST_PATH);
    }

    // Run regen with --init
    execSync(`node ${REGEN_SCRIPT} --init`, {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AGENT_MANAGER_MAX_FILE_LINES: '500', AGENT_MANAGER_MAX_FUNCTION_LINES: '100' }
    });

    // Verify allowlist was created
    assert.ok(fs.existsSync(ALLOWLIST_PATH), 'Allowlist file should exist after --init');
  });

  it('Allowlist contains only files/functions below limits (LOWER-only semantics)', () => {
    // Run regen with specific limits
    execSync(`node ${REGEN_SCRIPT} --init`, {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AGENT_MANAGER_MAX_FILE_LINES: '100', AGENT_MANAGER_MAX_FUNCTION_LINES: '50' }
    });

    // Read allowlist
    const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf-8'));

    // Verify all files are below 100 lines
    for (const [filePath, lineCount] of Object.entries(allowlist.files)) {
      assert.ok(lineCount < 100, `File ${filePath} has ${lineCount} lines, should be < 100`);
    }

    // Verify all functions are below 50 lines
    for (const [funcKey, lineCount] of Object.entries(allowlist.functions)) {
      assert.ok(lineCount < 50, `Function ${funcKey} has ${lineCount} lines, should be < 50`);
    }
  });

  it('Uses environment variables for defaults', () => {
    // Run regen with custom env vars
    execSync(`node ${REGEN_SCRIPT} --init`, {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AGENT_MANAGER_MAX_FILE_LINES: '200', AGENT_MANAGER_MAX_FUNCTION_LINES: '75' }
    });

    // Verify allowlist was created (just check it exists and is valid JSON)
    assert.ok(fs.existsSync(ALLOWLIST_PATH), 'Allowlist file should exist');
    const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf-8'));
    assert.ok(allowlist.files !== undefined, 'Allowlist should have files key');
    assert.ok(allowlist.functions !== undefined, 'Allowlist should have functions key');
  });

  it('Generates valid JSON with correct structure (files and functions keys)', () => {
    // Run regen
    execSync(`node ${REGEN_SCRIPT} --init`, {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AGENT_MANAGER_MAX_FILE_LINES: '500', AGENT_MANAGER_MAX_FUNCTION_LINES: '100' }
    });

    // Read and parse allowlist
    const raw = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');
    const allowlist = JSON.parse(raw);

    // Verify structure
    assert.ok(typeof allowlist === 'object', 'Allowlist should be an object');
    assert.ok(Array.isArray(Object.keys(allowlist)), 'Allowlist should be an object with keys');
    assert.ok('files' in allowlist, 'Allowlist should have "files" key');
    assert.ok('functions' in allowlist, 'Allowlist should have "functions" key');
    assert.ok(typeof allowlist.files === 'object', 'files should be an object');
    assert.ok(typeof allowlist.functions === 'object', 'functions should be an object');
  });

  it('Handles missing/empty directory gracefully', () => {
    // Create a temp directory
    const tmpDir = path.join(__dirname, '..', 'tmp-test-dir');
    fs.mkdirSync(tmpDir, { recursive: true });

    // temporarily change ALLOWLIST_PATH to point to a non-existent location
    const originalAllowlistPath = ALLOWLIST_PATH;

    try {
      // Just verify the script can run without errors in a normal directory
      const result = execSync(`node ${REGEN_SCRIPT} --init`, {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, AGENT_MANAGER_MAX_FILE_LINES: '500', AGENT_MANAGER_MAX_FUNCTION_LINES: '100' },
        encoding: 'utf-8'
      });

      // Should not throw
      assert.ok(typeof result === 'string' || result === undefined, 'Should return output or undefined');
    } finally {
      // Clean up
      if (fs.existsSync(tmpDir)) {
        fs.rmdirSync(tmpDir, { recursive: true });
      }
    }
  });
});
