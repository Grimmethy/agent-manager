'use strict';

// Worker context factory. Groups caller-supplied hook functions into three
// frozen domains (draft, review, apply) and returns them alongside options.
// Pure construction: no timers, no polling, no I/O, and no model or
// context-size choices.

const DOMAINS = ['draft', 'review', 'apply'];

function pickFunctions(domainName, source) {
  if (source === undefined) return Object.freeze({});
  if (source === null || typeof source !== 'object') {
    throw new TypeError(`hooks.${domainName} must be an object when provided`);
  }
  const out = {};
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'function') out[key] = source[key];
  }
  return Object.freeze(out);
}

function createWorkerContext({ options = {}, hooks = {} } = {}) {
  if (hooks === null || typeof hooks !== 'object') {
    throw new TypeError('hooks must be an object');
  }
  const domains = {};
  for (const name of DOMAINS) domains[name] = pickFunctions(name, hooks[name]);
  return Object.freeze({
    draft: domains.draft,
    review: domains.review,
    apply: domains.apply,
    options,
  });
}

module.exports = { createWorkerContext };
