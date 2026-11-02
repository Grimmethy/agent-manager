'use strict';

// Script handlers (2026-11-02, owner rule: every Agent Manager loop is a lane). A task source whose work is a SCRIPT, not a model-drafted diff
// (a tuning experiment, an archive, a ledger line), registers a handler here. src/local-draft.js draftTask() calls it BEFORE any model call and
// records the result on the task (terminalDisposition 'recorded'); scripts/local-worker.sh then files the task straight into done/.
//
// fn(task, ctx) is async and returns { outcome: string, summary: string, detail?: object }. Throwing is allowed: the worker's normal draft-failure
// accounting (draftFailureCount, infra requeue rounds, blocked/) then applies. Same module-level registry shape as task-source-registry.js.

const registry = {};

function registerScriptHandler(sourceName, fn) {
  if (typeof sourceName !== 'string' || !sourceName.trim()) throw new TypeError('registerScriptHandler: sourceName must be a non-empty string');
  if (typeof fn !== 'function') throw new TypeError(`registerScriptHandler: handler for "${sourceName}" must be a function`);
  if (registry[sourceName] !== undefined) throw new Error(`Script handler for "${sourceName}" is already registered`);
  registry[sourceName] = fn;
}

function getScriptHandler(sourceName) {
  return Object.prototype.hasOwnProperty.call(registry, sourceName) ? registry[sourceName] : undefined;
}

function _resetForTests() {
  for (const k of Object.keys(registry)) delete registry[k];
}

module.exports = { registerScriptHandler, getScriptHandler, _resetForTests };
