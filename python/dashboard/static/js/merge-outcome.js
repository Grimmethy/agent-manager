// Pure display text for the live-checkout sync outcome of a merge. A plain global <script>
// in the browser and requireable from Node. No browser globals, no network calls, no timers.
// mergeOutcomeText(liveSync) takes the result.liveSync object (not the full merge result).
// Returns '' for a skipped or missing sync (neutral, no failure wording).
function mergeOutcomeText(liveSync) {
  if (!liveSync || typeof liveSync !== 'object') return '';
  if (liveSync.skipped) return '';
  if (liveSync.synced === true) {
    if (liveSync.changed === true && liveSync.restartTriggered === true) {
      return 'Merged -- dashboard reloading...';
    }
    return 'Merged and live';
  }
  if (liveSync.synced === false && liveSync.reason) {
    return 'Merged, but the live checkout was NOT updated: ' + liveSync.reason;
  }
  return '';
}

if (typeof module !== 'undefined') module.exports = { mergeOutcomeText };
