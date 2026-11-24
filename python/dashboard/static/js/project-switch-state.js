// Pure helpers for the Project tab's selected-vs-running state. No DOM access at load time, so node --test can require() this file.
// Browser: a plain <script src> tag loads it, and its top-level names become shared globals (no module system needed).

function switchNoticePathKey(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function switchNoticeBaseName(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// state: 'differs' only when a pipeline is running against activeRepoRoot and the selected path is a different project.
// 'match' when running against the selected project; 'none' otherwise (including no pipeline running).
function projectSwitchState(selectedPath, activeRepoRoot, pipelineRunning) {
  const selectedName = switchNoticeBaseName(selectedPath);
  const activeName = switchNoticeBaseName(activeRepoRoot);
  let state = 'none';
  if (pipelineRunning && activeRepoRoot) {
    state = switchNoticePathKey(selectedPath) === switchNoticePathKey(activeRepoRoot) ? 'match' : 'differs';
  }
  return { state, selectedName, activeName };
}

function switchNoticeEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// HTML for the 'differs' notice, its single Switch button, and the progress line (progressText, may be ''). Returns '' for any other state.
function renderProjectSwitchNoticeHtml(selectedPath, activeRepoRoot, pipelineRunning, progressText) {
  const info = projectSwitchState(selectedPath, activeRepoRoot, pipelineRunning);
  if (info.state !== 'differs') return '';
  const text = `Selected: ${info.selectedName}. Pipeline still running against ${info.activeName}. Stop it, then Start to switch.`;
  const title = switchNoticeEscape('Selected: ' + selectedPath + ' | Running against: ' + activeRepoRoot);
  return '<div class="row" id="project-switch-notice" title="' + title + '">'
    + '<span>' + switchNoticeEscape(text) + '</span>'
    + '<button class="danger" id="switch-project-btn">Switch project</button>'
    + '</div>'
    + '<div class="meta" id="switch-project-progress">' + switchNoticeEscape(progressText || '') + '</div>';
}

// Bounded wait used only by the Switch flow after a click (never an idle timer).
function switchSleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (typeof module !== 'undefined' && module.exports) module.exports = { projectSwitchState, renderProjectSwitchNoticeHtml, switchNoticeBaseName, switchSleepMs };
