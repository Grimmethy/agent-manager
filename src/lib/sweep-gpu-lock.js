'use strict';

const path = require('path');
const { sharedInstancesDir } = require('../instances-dir.js');
const gpuArbiter = require('../gpu-arbiter.js');
const { localOllamaLockKey } = require('./draft-lifecycle.js');
const { getConfig } = require('../config.js');

// 2026-09-18, pipeline hardening: local-client.js's call()/majorityVote() use
// model-inflight-lock.js internally, which is DELIBERATELY not a mutex (see that file's
// own header -- worker-1 and the reviewer legitimately overlap on the same model). Real
// GPU serialization only ever happened because local-draft.js and review-task.js each
// wrap their calls in gpuArbiter.withGpu themselves (see draft-context.js's maybeLocked).
// Every OTHER direct local-client.js caller got none of that. Confirmed live: with the
// 240s-timeout fix already shipped today, a fresh stall showed a NEW failure mode --
// Ollama's own "server busy, maximum pending requests exceeded" 503 -- traced via
// `ss -tnp` to proactive-file-decompose-sweep.js holding a live connection to the host
// Ollama instance with no arbiter ticket at all, at the same moment a real worker was
// mid-generation. adhoc-staleness-flag.js, auto-confirm-review.js and
// needs-clarification-triage.js all have the identical gap -- each is a standalone
// queue-watcher.sh sweep tick (no daemon of its own, no arbiter participation) that can
// fire a real model call at any moment, unserialized against draft/review.
//
// Fix: wrap each sweep's local-client.js function in this before injecting it, so every
// call still goes through the SAME real mutex (same lockKey -- the resolved Ollama
// endpoint -- as maybeLocked uses) before ever reaching Ollama. Priority class 'audit'
// (the lowest -- see gpu-arbiter.js's CLASS_RANK) is deliberate: a sweep's vote/plan call
// is background housekeeping and should queue behind real draft/review work, never
// preempt it, while still being guaranteed to eventually run (the arbiter is a queue, not
// a drop).
function lockedModelFn(fn, { phase } = {}) {
  if (typeof fn !== 'function') return fn;
  return (...args) => {
    const instancesDir = sharedInstancesDir(getConfig().pipelineDir);
    return gpuArbiter.withGpu(
      instancesDir,
      { cls: 'audit', lockKey: localOllamaLockKey(), phase },
      () => fn(...args),
    );
  };
}

module.exports = { lockedModelFn };
