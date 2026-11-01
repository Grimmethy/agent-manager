'use strict';

// Unit tests for scan-config-cache.js -- validates that createScanContext() reads
// lanes.json and dashboard-settings.json exactly once per call (no module-level
// caching across calls), and that the returned shape matches the contract
// { lanes, dashboardSettings, loaded: true }.
//
// Uses node:test (the project's test runner) and reuses the LANES fixture shape
// from src/next-claimable-task.test.js. Spies on fs.readFileSync via monkey-patch
// (no jest dependency) and counts reads of each config file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createScanContext } = require('./scan-config-cache.js');

// Reuse the lane fixture shape from next-claimable-task.test.js.
// LANES is a minimal array of lane objects with id fields.
const LANES = [{ id: 'worker-3090' }, { id: 'worker-p40' }];

function setupTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-config-cache-test-'));
  const lanesPath = path.join(tmpDir, 'lanes.json');
  const settingsPath = path.join(tmpDir, 'dashboard-settings.json');

  // Write valid JSON content for both config files.
  fs.writeFileSync(lanesPath, JSON.stringify(LANES, null, 2));
  fs.writeFileSync(settingsPath, JSON.stringify({ workerModelOverrides: {} }, null, 2));

  // Point the modules at our temp files via env vars.
  process.env.AGENT_MANAGER_LANES_PATH = lanesPath;
  process.env.AGENT_MANAGER_SETTINGS_PATH = settingsPath;

  return { tmpDir, lanesPath, settingsPath };
}

function teardownTestEnv() {
  delete process.env.AGENT_MANAGER_LANES_PATH;
  delete process.env.AGENT_MANAGER_SETTINGS_PATH;
}

function createPendingFixture(pendingDir, count = 300) {
  fs.mkdirSync(pendingDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const task = {
      id: `task-${String(i).padStart(4, '0')}`,
      source: 'trouble_log',
      promptContext: {},
    };
    fs.writeFileSync(
      path.join(pendingDir, `task-${String(i).padStart(4, '0')}.json`),
      JSON.stringify(task)
    );
  }
}

test('createScanContext reads lanes.json and dashboard-settings.json exactly once each', () => {
  const { tmpDir, lanesPath, settingsPath } = setupTestEnv();
  const pendingDir = path.join(tmpDir, 'queue', 'pending');
  createPendingFixture(pendingDir, 300);

  // Spy on fs.readFileSync and count calls per file path.
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const readCounts = { lanes: 0, settings: 0 };

  fs.readFileSync = function (filePath, ...args) {
    const strPath = String(filePath);
    if (strPath === lanesPath) readCounts.lanes += 1;
    if (strPath === settingsPath) readCounts.settings += 1;
    return originalReadFileSync(filePath, ...args);
  };

  try {
    const scanContext = createScanContext();

    // Assert the contract shape.
    assert.equal(scanContext.loaded, true, 'loaded should be true');
    assert.ok(Array.isArray(scanContext.lanes), 'lanes should be an array');
    assert.ok(scanContext.lanes.length > 0, 'lanes should not be empty');
    assert.ok(typeof scanContext.dashboardSettings === 'object', 'dashboardSettings should be an object');

    // Assert each config file was read at most 5 times (should be exactly 1).
    assert.ok(readCounts.lanes <= 5, `lanes.json should be read ≤5 times, got ${readCounts.lanes}`);
    assert.ok(readCounts.settings <= 5, `dashboard-settings.json should be read ≤5 times, got ${readCounts.settings}`);
  } finally {
    fs.readFileSync = originalReadFileSync;
    teardownTestEnv();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createScanContext does not cache across calls: mutation on disk is reflected in the next scan', () => {
  const { tmpDir, lanesPath, settingsPath } = setupTestEnv();
  const pendingDir = path.join(tmpDir, 'queue', 'pending');
  createPendingFixture(pendingDir, 300);

  try {
    // Run scan 1 and capture the lanes.
    const scan1 = createScanContext();
    const scan1Lanes = JSON.parse(JSON.stringify(scan1.lanes)); // deep clone for comparison

    // Mutate lanes.json on disk: change the first lane's id.
    const mutatedLanes = JSON.parse(fs.readFileSync(lanesPath, 'utf8'));
    mutatedLanes[0].id = 'worker-mutated';
    fs.writeFileSync(lanesPath, JSON.stringify(mutatedLanes, null, 2));

    // Run scan 2.
    const scan2 = createScanContext();

    // Assert the parsed lanes from scan 2 differ from scan 1 (proving no cache).
    assert.notDeepEqual(scan2.lanes, scan1Lanes, 'scan 2 lanes should differ from scan 1 after mutation');
    assert.equal(scan2.lanes[0].id, 'worker-mutated', 'scan 2 should reflect the mutated value');
  } finally {
    teardownTestEnv();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
