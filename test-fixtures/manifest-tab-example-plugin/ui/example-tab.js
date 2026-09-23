'use strict';

// Fixture plugin UI script for the manifest-driven dashboard tab (docs/PLUGIN_API.md,
// "Dashboard tab" section; Docs/hub-tasks-extraction-plan.md section 5). This is a real,
// working example of what a plugin's own ui/<script>.js does: call
// registerPluginTabRenderer(key, renderFn) at load time, where key matches this plugin's
// declared tab.key in its plugins.json entry, and renderFn writes into #main exactly like
// any other render*Tab function in core-ui.js.
//
// scripts/manifest-tab-fixture-e2e.test.js and
// python/dashboard/test_manifest_tab_fixture_e2e.py both exercise this exact file: the
// Python test proves core serves these bytes correctly (and only when the plugin is
// enabled and the kill switch is on); the Node test proves the served content, run for
// real through core-ui.js's renderer dispatch, registers and renders as expected.
registerPluginTabRenderer('example-tab', function renderExampleTab() {
  document.getElementById('main').innerHTML =
    '<div id="example-plugin-content">Hello from the example plugin’s dashboard tab.</div>';
});
