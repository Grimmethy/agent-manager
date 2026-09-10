// Hard pre-implementation guard: blocks a draft when it claims files that do not
// exist and are not legitimate create-mode targets. Pure wrapper around
// checkDraft (fact-checker.js) -- no draft-pipeline imports, so it is unit-testable
// by stubbing ./fact-checker.js.
const { checkDraft } = require('./fact-checker.js');

function missingFileCheck(draftText, repoRoot, extraRoots = []) {
  // sourceText = undefined: checkGroundedValues short-circuits to [] (not needed
  // here). ref = undefined: skips the stacked-ref git-grep path.
  const result = checkDraft(draftText, repoRoot, undefined, extraRoots, undefined);

  const missing = (result.fileChecks || []).filter(
    (entry) => entry.exists === false && !entry.isCreateTarget
  );

  if (missing.length === 0) {
    return { blocked: false };
  }

  const paths = missing.map((entry) => entry.claimedPath);
  return {
    blocked: true,
    reason: 'missing-file: ' + paths.join(', '),
    missing: paths,
  };
}

module.exports = { missingFileCheck };
