// Hard pre-implementation guard: blocks a draft when it claims files that do not
// exist and are not legitimate create-mode targets. Pure wrapper around
// checkDraft (fact-checker.js) -- no draft-pipeline imports, so it is unit-testable
// by stubbing ./fact-checker.js.
const { checkDraft } = require('./fact-checker.js');

// A Group B draft is a JSON edit list ({file, mode, find, replace | content}). `replace`
// and `content` are code the draft WRITES (new test bodies name runtime fixtures like
// 'bad-parse.json' that never exist in the repo), not claims about files that already
// exist, but PATH_EXT_RE matches every path-shaped token in them. Confirmed live
// 2026-09-25: 6 change_review_fix / pipeline_forensics_fix tasks blocked pre-critique on
// exactly this, and all 6 pass once those bodies are dropped. Keeps file/mode/find (find
// text must match real file content, so a path there is a genuine claim). Anything that
// is not a Group B edit list is returned untouched.
function withoutWrittenContent(draftText) {
  let parsed;
  try { parsed = JSON.parse(draftText); } catch { return draftText; }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const isGroupB = items.length > 0 && items.every((i) => i && typeof i === 'object' && typeof i.file === 'string' && typeof i.mode === 'string');
  if (!isGroupB) return draftText;
  return JSON.stringify(items.map(({ replace, content, ...rest }) => rest));
}

function missingFileCheck(draftText, repoRoot, extraRoots = []) {
  // sourceText = undefined: checkGroundedValues short-circuits to [] (not needed
  // here). ref = undefined: skips the stacked-ref git-grep path.
  const result = checkDraft(withoutWrittenContent(draftText), repoRoot, undefined, extraRoots, undefined);

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
