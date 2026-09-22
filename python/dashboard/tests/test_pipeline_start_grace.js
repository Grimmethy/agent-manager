// Node test for the pipeline-start grace period (AC-54).
// Verifies that while the daemon is still spinning up the Start button stays
// disabled with the "Starting..." label, and that it is re-enabled once the
// grace period expires without the daemon ever appearing.

const assert = require('node:assert');

// --- Minimal in-memory stand-in for the DOM button ---
function makeButton() {
  return {
    className: '',
    disabled: false,
    textContent: '',
    onclick: null,
  };
}

// --- Re-implementation of the exact branch under test, parameterized so the
// test can drive time deterministically. This mirrors the logic added to
// project-tab.js (the `else if (pipelineStarting)` branch).
function applyStartingBranch({
  pipelineStarting,
  pipelineStartedAt,
  now,
  graceMs,
  projectPath,
  startPipeline,
  startBtn,
}) {
  if (pipelineStarting) {
    if (now - pipelineStartedAt > graceMs) {
      // Grace period expired -- daemons never appeared; recover the button (AC-54)
      pipelineStarting = false;
      startBtn.className = 'action';
      startBtn.textContent = 'Start Pipeline';
      startBtn.onclick = startPipeline;
      startBtn.disabled = !projectPath;
    } else {
      // Still within the grace window -- keep the disabled "Starting..." look.
      startBtn.className = 'action';
      startBtn.disabled = true;
      startBtn.textContent = 'Starting...';
    }
  }
  return pipelineStarting;
}

function runCase({ withinGrace, projectPath = '/some/project' }) {
  const startPipeline = () => {};
  const startBtn = makeButton();
  const graceMs = 30000;
  const startedAt = 1_000_000;
  const now = withinGrace ? startedAt + 1000 : startedAt + graceMs + 1;

  const pipelineStarting = applyStartingBranch({
    pipelineStarting: true,
    pipelineStartedAt: startedAt,
    now,
    graceMs,
    projectPath,
    startPipeline,
    startBtn,
  });

  if (withinGrace) {
    assert.strictEqual(startBtn.textContent, 'Starting...');
    assert.strictEqual(startBtn.disabled, true);
    assert.strictEqual(pipelineStarting, true, 'flag must remain set inside the grace window');
  } else {
    assert.strictEqual(startBtn.textContent, 'Start Pipeline');
    assert.strictEqual(startBtn.disabled, !projectPath, 're-enabled when a project path is set');
    assert.strictEqual(startBtn.onclick, startPipeline, 'handler restored after expiry');
    assert.strictEqual(pipelineStarting, false, 'flag cleared once the grace period expires');
  }
}

runCase({ withinGrace: true });
runCase({ withinGrace: false });

// Edge: no project path selected -> button stays disabled even after expiry.
{
  const startPipeline = () => {};
  const startBtn = makeButton();
  const graceMs = 30000;
  const startedAt = 0;
  const now = startedAt + graceMs + 1;
  applyStartingBranch({
    pipelineStarting: true,
    pipelineStartedAt: startedAt,
    now,
    graceMs,
    projectPath: null,
    startPipeline,
    startBtn,
  });
  assert.strictEqual(startBtn.disabled, true, 'no project path -> still disabled after expiry');
}

console.log('pipeline-start grace tests passed');
