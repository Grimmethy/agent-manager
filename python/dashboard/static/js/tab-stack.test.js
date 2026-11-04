'use strict';
// Run: node --test python/dashboard/static/js/tab-stack.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const tabStack = require('./tab-stack.js');

// Helper: create an empty registry
function emptyRegistry() {
  return { tabs: [], order: [] };
}

// Helper: create a registry with N tabs (A, B, C, ...)
function makeRegistry(n) {
  const registry = emptyRegistry();
  for (let i = 0; i < n; i++) {
    const id = String.fromCharCode(65 + i); // A, B, C, ...
    registry.tabs.push({ id, name: 'Tab ' + id, open: true, width: 380, lastActivatedAt: Date.now() });
    registry.order.push(id);
  }
  return registry;
}

test('registryKey returns correct format', () => {
  assert.equal(tabStack.registryKey('test-plugin'), 'agentManagerPluginTabs:test-plugin');
  assert.equal(tabStack.registryKey('my-app'), 'agentManagerPluginTabs:my-app');
  assert.equal(tabStack.registryKey(''), 'agentManagerPluginTabs:');
});

test('deserializeRegistry handles null and empty', () => {
  const result1 = tabStack.deserializeRegistry(null);
  assert.deepEqual(result1, { tabs: [], order: [] });
  
  const result2 = tabStack.deserializeRegistry('');
  assert.deepEqual(result2, { tabs: [], order: [] });
});

test('deserializeRegistry handles invalid JSON', () => {
  const result = tabStack.deserializeRegistry('not-json');
  assert.deepEqual(result, { tabs: [], order: [] });
});

test('deserializeRegistry handles malformed structure', () => {
  const result = tabStack.deserializeRegistry(JSON.stringify({ tabs: 'not-array', order: [] }));
  assert.deepEqual(result, { tabs: [], order: [] });
  
  const result2 = tabStack.deserializeRegistry(JSON.stringify({ tabs: [], order: 'not-array' }));
  assert.deepEqual(result2, { tabs: [], order: [] });
});

test('deserializeRegistry parses valid registry', () => {
  const raw = JSON.stringify({
    tabs: [{ id: 'A', name: 'Test', open: true, width: 380, lastActivatedAt: 123 }],
    order: ['A']
  });
  const result = tabStack.deserializeRegistry(raw);
  assert.equal(result.tabs.length, 1);
  assert.equal(result.order.length, 1);
  assert.equal(result.order[0], 'A');
});

test('createTab creates tab with correct structure', () => {
  const registry = emptyRegistry();
  const result = tabStack.createTab(registry, 'test-plugin', 'My Tab');
  
  assert.equal(result.tabs.length, 1);
  const tab = result.tabs[0];
  assert.ok(tab.id.startsWith('main-'));
  assert.equal(tab.name, 'My Tab');
  assert.equal(tab.open, true);
  assert.equal(tab.width, 380);
  assert.equal(result.order.length, 1);
  assert.equal(result.order[0], tab.id);
});

test('createTab enforces MAX_TABS limit (24)', () => {
  const registry = emptyRegistry();
  
  // Create tabs in batches: create 6 (MAX_OPEN), close all, create 6 more, etc.
  // This lets us test MAX_TABS without hitting MAX_OPEN
  for (let batch = 0; batch < 4; batch++) {
    // Create up to 6 open tabs
    for (let i = 0; i < 6; i++) {
      tabStack.createTab(registry, 'test-plugin', 'Tab ' + batch + '-' + i);
    }
    // Close all tabs to make room for next batch
    if (batch < 3) {
      for (const tab of registry.tabs) {
        tabStack.setOpen(registry, tab.id, false);
      }
    }
  }
  
  // Should have 24 tabs total
  assert.equal(registry.tabs.length, 24);
  
  // 25th should be rejected (MAX_TABS limit)
  tabStack.createTab(registry, 'test-plugin', 'Tab 25');
  assert.equal(registry.tabs.length, 24);
});

test('createTab enforces MAX_OPEN limit (6)', () => {
  const registry = emptyRegistry();
  
  // Create 6 open tabs
  for (let i = 0; i < 6; i++) {
    tabStack.createTab(registry, 'test-plugin', 'Tab ' + i);
  }
  assert.equal(registry.tabs.length, 6);
  
  // Close all of them
  for (const tab of registry.tabs) {
    tabStack.setOpen(registry, tab.id, false);
  }
  assert.equal(registry.tabs.filter(t => t.open).length, 0);
  
  // Now create a 7th tab (should work because none are open)
  tabStack.createTab(registry, 'test-plugin', 'Tab 7');
  assert.equal(registry.tabs.length, 7);
});

test('renameTab updates name in place', () => {
  const registry = makeRegistry(3);
  tabStack.renameTab(registry, 'B', 'Renamed B');
  assert.equal(registry.tabs[1].name, 'Renamed B');
  assert.equal(registry.order.length, 3);
});

test('renameTab with invalid tabId does nothing', () => {
  const registry = makeRegistry(3);
  tabStack.renameTab(registry, 'Z', 'New Name');
  assert.equal(registry.tabs[0].name, 'Tab A');
  assert.equal(registry.tabs[1].name, 'Tab B');
  assert.equal(registry.tabs[2].name, 'Tab C');
});

test('deleteTab removes tab from registry', () => {
  const registry = makeRegistry(3);
  tabStack.deleteTab(registry, 'B');
  assert.equal(registry.tabs.length, 2);
  assert.equal(registry.tabs[0].id, 'A');
  assert.equal(registry.tabs[1].id, 'C');
});

test('deleteTab removes tab from order', () => {
  const registry = makeRegistry(3);
  tabStack.deleteTab(registry, 'B');
  assert.equal(registry.order.length, 2);
  assert.equal(registry.order[0], 'A');
  assert.equal(registry.order[1], 'C');
});

test('reorder moves tab left', () => {
  const registry = makeRegistry(4); // A, B, C, D
  tabStack.reorder(registry, 'C', 'left');
  assert.deepEqual(registry.order, ['A', 'C', 'B', 'D']);
});

test('reorder moves tab right', () => {
  const registry = makeRegistry(4); // A, B, C, D
  tabStack.reorder(registry, 'B', 'right');
  assert.deepEqual(registry.order, ['A', 'C', 'B', 'D']);
});

test('reorder with invalid tabId does nothing', () => {
  const registry = makeRegistry(3);
  tabStack.reorder(registry, 'Z', 'left');
  assert.deepEqual(registry.order, ['A', 'B', 'C']);
});

test('reorder cannot move past boundaries', () => {
  const registry = makeRegistry(3); // A, B, C
  // Try to move A left (would go to index -1)
  tabStack.reorder(registry, 'A', 'left');
  assert.deepEqual(registry.order, ['A', 'B', 'C']);
  
  // Try to move C right (would go to index 3)
  tabStack.reorder(registry, 'C', 'right');
  assert.deepEqual(registry.order, ['A', 'B', 'C']);
});

test('setOpen sets tab to open', () => {
  const registry = makeRegistry(3);
  tabStack.setOpen(registry, 'B', true);
  assert.equal(registry.tabs[1].open, true);
});

test('setOpen sets tab to closed', () => {
  const registry = makeRegistry(3);
  tabStack.setOpen(registry, 'B', false);
  assert.equal(registry.tabs[1].open, false);
});

test('setOpen with invalid tabId does nothing', () => {
  const registry = makeRegistry(3);
  tabStack.setOpen(registry, 'Z', false);
  assert.equal(registry.tabs[0].open, true);
  assert.equal(registry.tabs[1].open, true);
  assert.equal(registry.tabs[2].open, true);
});

test('markActivated updates lastActivatedAt', () => {
  const registry = makeRegistry(3);
  const before = registry.tabs[1].lastActivatedAt;
  tabStack.markActivated(registry, 'B');
  assert.ok(registry.tabs[1].lastActivatedAt >= before);
});

test('markActivated with invalid tabId does nothing', () => {
  const registry = makeRegistry(3);
  const time = registry.tabs[0].lastActivatedAt;
  tabStack.markActivated(registry, 'Z');
  assert.equal(registry.tabs[0].lastActivatedAt, time);
});

test('mostRecentlyActivated returns most recent tab', () => {
  const registry = makeRegistry(3);
  // Mark B as activated
  tabStack.markActivated(registry, 'B');
  // Wait a bit
  const before = Date.now();
  while (Date.now() === before) {}
  // Mark C as activated
  tabStack.markActivated(registry, 'C');
  assert.equal(tabStack.mostRecentlyActivated(registry), 'C');
});

test('mostRecentlyActivated handles empty registry', () => {
  const registry = emptyRegistry();
  assert.equal(tabStack.mostRecentlyActivated(registry), null);
});

test('asideOrder returns only open tabs', () => {
  const registry = makeRegistry(3);
  tabStack.setOpen(registry, 'B', false);
  const result = tabStack.asideOrder(registry);
  assert.deepEqual(result, ['A', 'C']);
});

test('asideOrder respects order array', () => {
  const registry = makeRegistry(3);
  tabStack.reorder(registry, 'A', 'right'); // Now order is B, A, C
  tabStack.setOpen(registry, 'B', false);
  const result = tabStack.asideOrder(registry);
  assert.deepEqual(result, ['A', 'C']);
});

test('pillColumns calculates correct columns', () => {
  const registry = emptyRegistry();
  // With asideWidth=400: Math.max(1, Math.floor((400 + 8) / (120 + 8))) = Math.max(1, Math.floor(408/128)) = Math.max(1, 3) = 3
  assert.equal(tabStack.pillColumns(registry, 400), 3);
});

test('pillColumns returns at least 1 column', () => {
  const registry = emptyRegistry();
  assert.equal(tabStack.pillColumns(registry, 0), 1);
  assert.equal(tabStack.pillColumns(registry, 50), 1);
});

test('pillColumns uses formula correctly', () => {
  const registry = emptyRegistry();
  // Test with various widths
  assert.equal(tabStack.pillColumns(registry, 128), 1); // (128+8)/(120+8) = 1
  assert.equal(tabStack.pillColumns(registry, 256), 2); // (256+8)/(120+8) = 2
  assert.equal(tabStack.pillColumns(registry, 384), 3); // (384+8)/(120+8) = 3
});
