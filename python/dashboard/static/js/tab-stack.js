// Pure tab-stack registry: manages an array of tabs (id, name, open, width, lastActivatedAt)
// and an order list of ids, keyed per plugin via a storage key. No DOM, no localStorage.
// A plain global <script> holding only declarations, loaded by index.html; the guarded export
// below lets `node --test` require() it.

const MAX_OPEN = 6;
const MAX_TABS = 24;
const DEFAULT_WIDTH = 380;
const DEFAULT_TAB_ID = 'main';

// Returns the storage key used to persist this plugin's tab registry.
function registryKey(plugin) {
  return 'agentManagerPluginTabs:' + plugin;
}

// Parse a raw (stringified) registry, falling back to an empty one on any failure.
function deserializeRegistry(raw) {
  if (!raw) return { tabs: [], order: [] };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.tabs) && Array.isArray(parsed.order)) {
      return parsed;
    }
  } catch (_e) {
    // fall through
  }
  return { tabs: [], order: [] };
}

// Create a new tab. Returns the mutated registry. Enforces MAX_TABS / MAX_OPEN caps.
function createTab(registry, plugin, name) {
  if (registry.tabs.length >= MAX_TABS) return registry;
  const openCount = registry.tabs.filter(function (t) { return t.open; }).length;
  if (openCount >= MAX_OPEN) return registry;
  const id = DEFAULT_TAB_ID + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const tab = { id: id, name: name, open: true, width: DEFAULT_WIDTH, lastActivatedAt: Date.now() };
  registry.tabs.push(tab);
  registry.order.push(id);
  return registry;
}

// Rename an existing tab in place.
function renameTab(registry, tabId, newName) {
  for (var i = 0; i < registry.tabs.length; i++) {
    if (registry.tabs[i].id === tabId) {
      registry.tabs[i].name = newName;
      break;
    }
  }
  return registry;
}

// Delete a tab by id, removing it from both the tabs array and the order array.
function deleteTab(registry, tabId) {
  registry.tabs = registry.tabs.filter(function (t) { return t.id !== tabId; });
  registry.order = registry.order.filter(function (id) { return id !== tabId; });
  return registry;
}

// Reorder a tab by moving it left or right in the order array.
function reorder(registry, tabId, direction) {
  var idx = registry.order.indexOf(tabId);
  if (idx === -1) return registry;
  var targetIdx = direction === 'left' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= registry.order.length) return registry;
  registry.order.splice(idx, 1);
  registry.order.splice(targetIdx, 0, tabId);
  return registry;
}

// Set the open state of a tab.
function setOpen(registry, tabId, open) {
  for (var i = 0; i < registry.tabs.length; i++) {
    if (registry.tabs[i].id === tabId) {
      registry.tabs[i].open = !!open;
      break;
    }
  }
  return registry;
}

// Mark a tab as activated by updating its lastActivatedAt timestamp.
function markActivated(registry, tabId) {
  for (var i = 0; i < registry.tabs.length; i++) {
    if (registry.tabs[i].id === tabId) {
      registry.tabs[i].lastActivatedAt = Date.now();
      break;
    }
  }
  return registry;
}

// Return the id of the most recently activated tab (highest lastActivatedAt).
function mostRecentlyActivated(registry) {
  var best = null;
  var bestAt = -1;
  for (var i = 0; i < registry.tabs.length; i++) {
    if (registry.tabs[i].lastActivatedAt > bestAt) {
      bestAt = registry.tabs[i].lastActivatedAt;
      best = registry.tabs[i].id;
    }
  }
  return best;
}

// Return the order array filtered to only open tabs, preserving order.
function asideOrder(registry) {
  var openIds = new Set();
  for (var i = 0; i < registry.tabs.length; i++) {
    if (registry.tabs[i].open) openIds.add(registry.tabs[i].id);
  }
  return registry.order.filter(function (id) { return openIds.has(id); });
}

// Compute pill columns: how many pills fit per row given asideWidth.
function pillColumns(registry, asideWidth) {
  var pillWidth = 120;
  var gap = 8;
  return Math.max(1, Math.floor((asideWidth + gap) / (pillWidth + gap)));
}

if (typeof module !== 'undefined') module.exports = {
  MAX_OPEN, MAX_TABS, DEFAULT_WIDTH, DEFAULT_TAB_ID,
  registryKey, deserializeRegistry, createTab, renameTab, deleteTab,
  reorder, setOpen, markActivated, mostRecentlyActivated, asideOrder, pillColumns
};
