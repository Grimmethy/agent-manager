'use strict';

// Tests for the critique skip behavior (HUB0131): brain_dump_sort tasks skip the
// critique model call entirely, while other sources (e.g. code_review) do not.
// The stub targets src/lib/implement-critique.js's runCritiqueAndRevision export
// directly, BEFORE local-draft.js is required, so the internal reference in that
// module resolves to the spy. No real model is reached.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Setup: neutralize real plugin loading ---

function neutralizeRealPluginLoading() {
  const configModule = require('./config.js');
  if (!configModule.__hygieneStubsOnly) {
    configModule.ensureRegistered = () => {};
    configModule.__hygieneStubsOnly = true;
  }
}

// --- Setup: register code_review source with valid prompt builders ---

function registerCodeReviewSource() {
  const { registerTaskSource, getRegisteredSource, updateTaskSource } = require('./task-source-registry.js');
  
  // Register code_review with minimal config
  if (!getRegisteredSource('code_review')) {
    registerTaskSource('code_review', { 
      priority: 80, 
      next: () => null,
    });
  }
  
  // Add buildPlanPrompt and buildImplementPrompt so prompts.js doesn't fall through
  // to genericFallbackPlanPrompt (which throws "no prompt template"). These return
  // a minimal valid prompt that the stubbed localCall can satisfy.
  updateTaskSource('code_review', {
    buildPlanPrompt: (task) => `Plan the implementation for: ${task.title || task.promptContext?.rawText || 'task'}. Output ONLY valid JSON with keys: scope, steps, file_changes.`,
    buildImplementPrompt: (task) => `Implement the plan for: ${task.title || task.promptContext?.rawText || 'task'}. Output ONLY valid JSON with keys: FALSE_POSITIVE, file_changes.`,
  });
}

// --- Setup: stub runCritiqueAndRevision BEFORE requiring local-draft.js ---

let critiqueCallCount = 0;
let originalModuleLoad;

function stubCritique() {
  // Clear the module cache for implement-critique.js so we can stub it
  const implementCritiquePath = require.resolve('./lib/implement-critique.js');
  delete require.cache[implementCritiquePath];
  
  // Save the original Module._load and replace with our stub
  const Module = require('module');
  originalModuleLoad = Module._load;
  
  Module._load = function (request, parent, isMain) {
    if (request === './lib/implement-critique.js' || request === '../lib/implement-critique.js') {
      const stubModule = {
        exports: {
          runCritiqueAndRevision: async (task, opts) => {
            critiqueCallCount++;
            // Return a minimal result that won't break downstream logic
            return { succeeded: true, blocked: false };
          },
          // Re-export other functions with no-op stubs to avoid missing export errors
          computeImplementBudget: () => 1200,
          callImplementModel: async () => ({ response: 'stub', degenerate: null, attempts: 1 }),
          recheckFinalEdits: async () => ({ verified: [], unverified: [] }),
          revisionKeepsAnswerShape: () => true,
          checkFindStrings: () => [],
        },
      };
      return stubModule.exports;
    }
    return originalModuleLoad.apply(this, arguments);
  };
}

function restoreCritiqueStub() {
  if (originalModuleLoad) {
    const Module = require('module');
    Module._load = originalModuleLoad;
  }
}

// --- Test helpers ---

function withFixtureRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'critique-skip-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  process.env.LOCAL_MODEL = 'test-local-model';
  
  console.log('[DEBUG] Setting AGENT_MANAGER_REPO_ROOT to:', dir);
  console.log('[DEBUG] Current env:', process.env.AGENT_MANAGER_REPO_ROOT);
  
  const { clearRegistry } = require('./task-source-registry.js');
  clearRegistry();
  require('./model-profile-registry.js').clearModelProfileRegistry();
  
  delete require.cache[require.resolve('./task-sources.js')];
  delete require.cache[require.resolve('./prompts.js')];
  delete require.cache[require.resolve('./local-draft.js')];
  
  require('./task-sources.js');
  require('./prompts.js');
  registerCodeReviewSource();
  
  stubCritique();
  
  const { draftTask } = require('./local-draft.js');
  
  try {
    return fn(draftTask);
  } finally {
    restoreCritiqueStub();
    delete process.env.AGENT_MANAGER_REPO_ROOT;
    delete process.env.AGENT_MANAGER_PIPELINE_DIR;
    delete process.env.LOCAL_MODEL;
  }
}

// --- Tests ---

test('brain_dump_sort: zero critique calls (critique is skipped)', async () => {
  await withFixtureRepo(async (draftTask) => {
    critiqueCallCount = 0;
    
    const task = {
      id: 'brain-dump-test-1',
      domain: 'default',
      source: 'brain_dump_sort',
      title: 'test',
      promptContext: { rawText: 'a note to classify', tags: [] },
    };
    
    // Provide a minimal localCall stub for the plan/implement passes
    const localCall = async () => ({
      response: 'Plan: do the thing\n\n1. Step one\n2. Step two',
      degenerate: null,
      attempts: 1,
    });
    
    await draftTask(task, { localCall });
    
    assert.equal(critiqueCallCount, 0, 'brain_dump_sort should skip critique entirely');
  });
});

test('code_review: exactly one critique call', async () => {
  await withFixtureRepo(async (draftTask) => {
    critiqueCallCount = 0;
    
    const task = {
      id: 'code-review-test-1',
      domain: 'default',
      source: 'code_review',
      title: 'test',
      promptContext: { rawText: 'review this code', tags: [] },
    };
    
    // Provide a minimal localCall stub for the plan/implement passes
    const localCall = async () => ({
      response: 'Plan: review the code\n\n1. Step one\n2. Step two',
      degenerate: null,
      attempts: 1,
    });
    
    await draftTask(task, { localCall });
    
    assert.equal(critiqueCallCount, 1, 'code_review should call critique exactly once');
  });
});
