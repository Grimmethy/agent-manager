'use strict';

// Scan context cache: reads lanes.json and dashboard-settings.json exactly once,
// parses both, and returns them together. The lifetime is one scan -- each call
// to createScanContext() returns an independent object with no module-level state.
//
// lanes.json path is resolved via lanesRegistryPath() from src/lanes.js.
// dashboard-settings.json path is resolved via settingsPath() from src/worker-model-override.js.

const fs = require('fs');
const path = require('path');
const { lanesRegistryPath } = require('./lanes.js');
const { settingsPath } = require('./worker-model-override.js');

function createScanContext() {
  let lanes = [];
  try {
    const lanesPath = lanesRegistryPath(process.env);
    const text = fs.readFileSync(lanesPath, 'utf8');
    const parsed = JSON.parse(text);
    lanes = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    lanes = [];
  }

  let dashboardSettings = {};
  try {
    const settingsPathValue = settingsPath();
    const text = fs.readFileSync(settingsPathValue, 'utf8');
    const parsed = JSON.parse(text);
    dashboardSettings = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    dashboardSettings = {};
  }

  return { lanes, dashboardSettings, loaded: true };
}

module.exports = { createScanContext };
