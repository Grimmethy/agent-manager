'use strict';

// Pure decision helper for a plugin tab: should the tab load its page, or show a "not running" view?
// No DOM access, no network calls, no timers -- testable from Node.

// Returns "load" when the tab should autostart its server or the server is already running, otherwise "not-running".
function decidePluginTabState({ autostart, running } = {}) {
  return (autostart || running) ? 'load' : 'not-running';
}

if (typeof window !== 'undefined') window.PluginTabState = { decidePluginTabState };
if (typeof module !== 'undefined' && module.exports) module.exports = { decidePluginTabState };
