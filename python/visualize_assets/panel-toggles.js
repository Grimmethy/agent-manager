// Wires panel-toggles.html's three checkboxes to show/hide their panels, persisted via
// localStorage using the same convention crossing-check.js's own autosort toggle already
// established -- a viewing preference, not per-project data, so one global key per panel
// is the right scope. Unchecked/hidden is the default the first time (no stored value
// yet): the whole point of this brain-dump entry was that the graph was too cramped, so
// starting with all three panels off keeps the canvas at full width until the user
// deliberately asks for one.
var AM_PANEL_TOGGLES = [
  { checkboxId: 'am-toggle-search', panelId: 'am-search-wrapper', storageKey: 'agent-manager-panel-search-visible', display: 'block' },
  { checkboxId: 'am-toggle-node-detail', panelId: 'am-node-detail', storageKey: 'agent-manager-panel-node-detail-visible', display: 'flex' },
  { checkboxId: 'am-toggle-community-stats', panelId: 'am-community-stats', storageKey: 'agent-manager-panel-community-stats-visible', display: 'flex' },
];

AM_PANEL_TOGGLES.forEach(function(cfg) {
  var checkbox = document.getElementById(cfg.checkboxId);
  var panel = document.getElementById(cfg.panelId);
  if (!checkbox || !panel) return;

  var stored = localStorage.getItem(cfg.storageKey);
  var visible = stored === null ? checkbox.checked : stored === 'true';
  checkbox.checked = visible;
  panel.style.display = visible ? cfg.display : 'none';

  checkbox.addEventListener('change', function() {
    localStorage.setItem(cfg.storageKey, checkbox.checked ? 'true' : 'false');
    panel.style.display = checkbox.checked ? cfg.display : 'none';
  });
});
