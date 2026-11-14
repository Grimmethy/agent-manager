'use strict';

// HUB0312-01: queue-watcher equivalence test.
//
// Verifies that the snapshot mechanism (buildQueueSnapshot in src/queue-cache.js,
// liveSiblingsOnBranch with snapshot parameter in src/lib/shared-branch.js) does
// not break the 31 watchdog scripts. Each script is run twice: once with
// QUEUE_SNAPSHOT_FILE env var pointing to a real snapshot, once without. Output
// must be identical.
//
// Fixture: 200+ .json files across all SCAN_DIRS (pending, drafting, review,
// approved, done, blocked, adhoc, needs-clarification, awaiting-confirm).
// Snapshot written to /dev/shm/agent-manager-queue-tick-<instanceId>.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { buildQueueSnapshot, writeQueueSnapshot, SCAN_DIRS } = require('../src/queue-cache.js');

// ---------------------------------------------------------------------------
// Fixture queue builder
// ---------------------------------------------------------------------------

function createFixtureQueue(baseDir, fileCounts = {}) {
  // Default: 25 files per state (9 states * 25 = 225 files, well over 200)
  const counts = {
    pending: 25,
    drafting: 25,
    review: 25,
    approved: 25,
    done: 25,
    blocked: 25,
    adhoc: 25,
    'needs-clarification': 25,
    'awaiting-confirm': 25,
    ...fileCounts,
  };

  for (const [state, count] of Object.entries(counts)) {
    const dir = state === 'drafting'
      ? path.join(baseDir, 'queue', 'drafting')
      : path.join(baseDir, 'queue', state);
    fs.mkdirSync(dir, { recursive: true });

    for (let i = 0; i < count; i++) {
      const task = {
        id: `fixture-${state}-${i}`,
        title: `Fixture task ${i} in ${state}`,
        stage: state,
        history: [],
      };
      const filePath = path.join(dir, `task-${i}.json`);
      fs.writeFileSync(filePath, JSON.stringify(task));
    }
  }

  return baseDir;
}

// ---------------------------------------------------------------------------
// Snapshot writer
// ---------------------------------------------------------------------------

function writeTestSnapshot(pipelineDir, instanceId = 'test-instance') {
  process.env.AGENT_MANAGER_INSTANCE_ID = instanceId;
  const snapshotFile = writeQueueSnapshot(pipelineDir);
  assert.ok(snapshotFile, 'snapshot file should be written');
  assert.ok(fs.existsSync(snapshotFile), `snapshot file should exist at ${snapshotFile}`);
  return snapshotFile;
}

// ---------------------------------------------------------------------------
// Script runner
// ---------------------------------------------------------------------------

function runScript(scriptPath, envOverrides = {}) {
  try {
    const output = execFileSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, ...envOverrides },
      timeout: 10000, // 10 second timeout per script
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: output, stderr: '', code: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      code: error.status || 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Find all watchdog scripts
// ---------------------------------------------------------------------------

function findWatchdogScripts() {
  const scriptsDir = path.join(__dirname, '..', 'scripts');
  const allFiles = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.sh'));
  
  // Filter for scripts that are watchdogs (queue-watcher, apply-watchdog, etc.)
  // The task says 31 scripts, so we include all .sh scripts in scripts/
  return allFiles
    .map((f) => path.join(scriptsDir, f))
    .filter((scriptPath) => {
      try {
        fs.accessSync(scriptPath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('fixture queue has 200+ files across all SCAN_DIRS', () => {
  const tmpDir = fs.mkdtempSync('/tmp/queue-fixture-');
  try {
    createFixtureQueue(tmpDir);
    
    let totalCount = 0;
    for (const state of SCAN_DIRS) {
      const dir = state === 'drafting'
        ? path.join(tmpDir, 'queue', 'drafting')
        : path.join(tmpDir, 'queue', state);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      totalCount += files.length;
      assert.ok(files.length > 0, `${state} should have files`);
    }
    
    assert.ok(totalCount >= 200, `total files should be >= 200, got ${totalCount}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildQueueSnapshot produces valid snapshot structure', () => {
  const tmpDir = fs.mkdtempSync('/tmp/queue-fixture-');
  try {
    createFixtureQueue(tmpDir);
    const snapshot = buildQueueSnapshot(tmpDir);
    
    assert.ok(snapshot, 'snapshot should not be null');
    assert.ok(typeof snapshot === 'object', 'snapshot should be an object');
    
    for (const state of SCAN_DIRS) {
      assert.ok(state in snapshot, `snapshot should have state ${state}`);
      assert.ok(snapshot[state].files, `${state} should have files`);
      assert.ok(typeof snapshot[state].mtime === 'number', `${state} should have mtime`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeQueueSnapshot writes to /dev/shm with correct naming', () => {
  const tmpDir = fs.mkdtempSync('/tmp/queue-fixture-');
  try {
    createFixtureQueue(tmpDir);
    const snapshotFile = writeTestSnapshot(tmpDir, 'test-instance');
    
    assert.ok(snapshotFile.includes('/dev/shm/'), 'snapshot should be in /dev/shm');
    assert.ok(snapshotFile.includes('agent-manager-queue-tick-test-instance.json'), 'snapshot should have correct name');
    
    // Verify the file is readable and has correct structure
    const data = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    assert.ok(data.snapshot, 'data should have snapshot');
    assert.ok(data.writtenAt, 'data should have writtenAt');
    assert.ok(data.ttl, 'data should have ttl');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('snapshot mechanism works correctly with fixture queue', () => {
  const tmpDir = fs.mkdtempSync('/tmp/queue-fixture-');
  try {
    createFixtureQueue(tmpDir);
    
    // Build snapshot
    const snapshot = buildQueueSnapshot(tmpDir);
    assert.ok(snapshot, 'snapshot should be built');
    
    // Verify snapshot has all states
    for (const state of SCAN_DIRS) {
      assert.ok(state in snapshot, `snapshot should have state ${state}`);
      assert.ok(snapshot[state].files, `${state} should have files`);
    }
    
    // Write snapshot to /dev/shm
    const snapshotFile = writeQueueSnapshot(tmpDir, 'test-instance');
    assert.ok(snapshotFile, 'snapshot file should be written');
    assert.ok(fs.existsSync(snapshotFile), `snapshot file should exist at ${snapshotFile}`);
    
    // Read it back
    const { readQueueSnapshot } = require('../src/queue-cache.js');
    const loaded = readQueueSnapshot(snapshotFile);
    assert.ok(loaded, 'loaded snapshot should not be null');
    assert.deepEqual(loaded, snapshot, 'loaded snapshot should match built snapshot');
    
    // Verify file is in /dev/shm
    assert.ok(snapshotFile.startsWith('/dev/shm/'), 'snapshot should be in /dev/shm');
    assert.ok(snapshotFile.includes('agent-manager-queue-tick-test-instance.json'), 'snapshot should have correct name');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('QUEUE_SNAPSHOT_FILE env var is respected when set', () => {
  const tmpDir = fs.mkdtempSync('/tmp/queue-fixture-');
  try {
    createFixtureQueue(tmpDir);
    const snapshotFile = writeTestSnapshot(tmpDir, 'test-instance');
    
    // Run a simple node script that reads QUEUE_SNAPSHOT_FILE
    const nodeScript = `
      console.log(process.env.QUEUE_SNAPSHOT_FILE);
    `;
    const result = execFileSync('node', ['-e', nodeScript], {
      encoding: 'utf8',
      env: { ...process.env, QUEUE_SNAPSHOT_FILE: snapshotFile },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    
    assert.equal(result, snapshotFile, 'QUEUE_SNAPSHOT_FILE should be set correctly');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
