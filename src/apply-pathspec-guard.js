'use strict';

// apply-pathspec-guard.js -- hard pre-apply guard for brain-dump pathspec values.
//
// Origin: incident adhoc-brain-dump-bd-1788744740947 ("fatal pathspec undefined
// apply failure") -- an apply operation died because a per-entry pathspec was
// `undefined`, and the failure surfaced late with a misleading git-level message.
//
// The apply path (see sibling task "Integrate guard into apply path") should call
// assertValidPathspec(path, entryId) for every resolved pathspec before handing it
// to git/apply machinery. If the value is not a usable non-empty string, we fail
// fast here with a message that names the offending entry and points at the config
// chain that is almost certainly responsible.
//
// Self-contained by design: no project imports, no I/O, no side-effects -- the
// same shape as plan-target-guard.js / draft-file-guard.js. It only asserts on the
// value it is given; resolving brainDumpPath/secondBrainDir correctly is the
// caller's job (see src/config.js -> getSecondBrainDir).

function assertValidPathspec(path, entryId) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(
      'assertValidPathspec: invalid pathspec for brain-dump entry ' +
        String(entryId) +
        ' (got ' + (typeof path === 'string' ? JSON.stringify(path) : String(typeof path) + ': ' + JSON.stringify(path)) +
        '). Expected a non-empty string path. ' +
        'Hint: check that brainDumpPath resolves correctly relative to secondBrainDir ' +
        '(see src/config.js -> getSecondBrainDir) -- an undefined/empty result there ' +
        'produces exactly this kind of pathspec.',
    );
  }
}

module.exports = { assertValidPathspec };
