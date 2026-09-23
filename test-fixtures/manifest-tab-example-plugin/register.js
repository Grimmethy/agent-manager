'use strict';

// Fixture register.js for the manifest-driven dashboard tab's end-to-end proof (piece 6;
// Docs/hub-tasks-extraction-plan.md section 5; documented in docs/PLUGIN_API.md's
// "Dashboard tab" section). A script-loaded plugin is required to have a register.js that
// exists on disk (POST /api/plugins/add checks it) even when, like this fixture, it
// registers no task source at all -- its only job here is to own ui/example-tab.js.
//
// See ui/example-tab.js for the actual tab content this plugin declares.
module.exports = {};
