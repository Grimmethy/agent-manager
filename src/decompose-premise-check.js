'use strict';

// Stale-decompose-premise check (2026-09-15, filed as brain-dump bd-1789433484305,
// "pipeline hardening 3/5"). A sub-task filed by an internal decompose can cite a file --
// often with a specific ~line N -- that was accurate when the PARENT task was written, but
// has since moved, been removed, or been restructured by a LATER, independent decompose or
// redesign. The sub-task's own premise goes stale even though nothing about the sub-task
// record itself changed. Root-caused live, 3 separate real incidents this session:
//   - a sub-task cited src/local-draft.js "~line 2178" for a grounding gate; decompose
//     #226 had already split that file down to 1327 lines total by the time the sub-task
//     drafted -- the cited site could not possibly still be there
//   - a sub-task named src/apply-group-a.js as a "dispatch/enqueue loop" wiring target
//     that never existed there (a conceptual claim, not a line-count one -- NOT caught by
//     this check; see the header's "what this does not catch" note below)
//   - a sub-task named a pidfile-liveness mechanism a later PR replaced with a different,
//     bash-side design (also conceptual, also not caught here)
// Each burned a real draft attempt before a model correctly, but only reactively,
// diagnosed the drift and asked a human. This check is proactive for the ONE sub-case that
// is cheaply, deterministically checkable without any judgment call: a cited line number
// that has become impossible given the file's real, current length.
//
// What this does NOT catch (deliberately, matching candidate-premise-check.js's own
// posture of "cheap, high-confidence, not a judgment call" over completeness): a claim
// that some construct/mechanism exists or doesn't (needs real understanding of the file's
// content, not just its size), or a citation with no line number at all. Two of the three
// real incidents above are exactly that shape and are NOT caught by this check -- it closes
// one real, recurring, cheaply-detectable slice of the problem, not the whole thing.
//
// Deliberately narrow scope, same reasoning: only fires for a sub-task with
// promptContext.decomposedFrom set (an internal decompose product -- never a fresh manual
// task, avoiding false positives on a task that simply hasn't been drafted yet).

const fs = require('fs');
const path = require('path');

// A file path mentioned in prose, optionally backtick-quoted, optionally followed by a
// line reference (":N", "line N", "~line N"). No backtick requirement -- adhoc task text
// overwhelmingly writes "In src/foo.js, ..." in plain prose, unlike the more disciplined
// backtick-per-citation convention candidate-fulfillment markdown docs use.
const PATH_RE = /`?((?:src|python|scripts|lib|docs)\/[\w./-]+\.\w{1,5})`?/g;
const LINE_REF_RE = /(?:~?\s*line\s+|:)(\d{2,6})\b/gi;

// A cited line more than this many lines past the file's real, current length is treated
// as impossible -- generous slack (a task citing "line 1651" against a 1600-line file is
// plausibly just a rough/rounded estimate, not a stale premise) rather than flagging
// every citation that's merely approximate.
const LINE_OVERSHOOT_SLACK = 50;

function isEnabled() {
  return process.env.AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK !== 'false';
}

// Injectable for tests -- default reads the real file from disk.
function realLineCount(repoRoot, relPath) {
  try {
    const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    return content.split('\n').length;
  } catch {
    return null; // file does not exist
  }
}

function detectStaleDecomposePremise(task, { repoRoot, lineCountFn = realLineCount } = {}) {
  if (!isEnabled()) return null;
  const pc = (task && task.promptContext) || {};
  if (!pc.decomposedFrom) return null; // only ever a decompose product -- see header
  const rawText = String(pc.rawText || '');
  if (!rawText || !repoRoot) return null;

  const paths = [];
  const seen = new Set();
  let pm;
  PATH_RE.lastIndex = 0;
  while ((pm = PATH_RE.exec(rawText))) {
    if (!seen.has(pm[1])) { seen.add(pm[1]); paths.push({ relPath: pm[1], index: pm.index }); }
  }
  if (!paths.length) return null;

  const lineRefs = [...rawText.matchAll(LINE_REF_RE)].map((m) => ({ line: Number(m[1]), index: m.index }));
  if (!lineRefs.length) return null;

  // Rough association: a line reference belongs to the nearest file path mentioned at or
  // before it in the text -- matches the common "In <path>, ... (1) ~line N ... (2) ~line
  // M ..." shape every real incident this session used (one file named up front, several
  // line refs after it).
  function nearestPathFor(refIndex) {
    let best = null;
    for (const p of paths) {
      if (p.index <= refIndex && (!best || p.index > best.index)) best = p;
    }
    return best || paths[0];
  }

  const findings = [];
  const checkedFiles = new Map(); // relPath -> lineCount | null, avoid re-reading the same file per ref
  for (const ref of lineRefs) {
    const p = nearestPathFor(ref.index);
    if (!checkedFiles.has(p.relPath)) checkedFiles.set(p.relPath, lineCountFn(repoRoot, p.relPath));
    const lineCount = checkedFiles.get(p.relPath);
    if (lineCount === null) {
      findings.push({ kind: 'missing-file', relPath: p.relPath, detail: `cites \`${p.relPath}\`, but that file does not exist in the repo` });
      continue;
    }
    if (ref.line > lineCount + LINE_OVERSHOOT_SLACK) {
      findings.push({
        kind: 'line-overshoot', relPath: p.relPath, citedLine: ref.line, realLineCount: lineCount,
        detail: `cites line ${ref.line} of \`${p.relPath}\`, but that file is only ${lineCount} lines long now -- it has likely been restructured (a decompose, a split) since this citation was written`,
      });
    }
  }
  // A file cited more than once (missing-file / same overshoot) is reported once, not per line ref.
  const dedupedFindings = [];
  const dedupSeen = new Set();
  for (const f of findings) {
    const key = f.kind === 'missing-file' ? `missing:${f.relPath}` : `overshoot:${f.relPath}`;
    if (dedupSeen.has(key)) continue;
    dedupSeen.add(key);
    dedupedFindings.push(f);
  }

  if (!dedupedFindings.length) return null;
  return {
    stale: true,
    findings: dedupedFindings,
    reason: `This sub-task's premise may be stale (filed by an internal decompose, then the codebase moved on): ${dedupedFindings.map((f) => f.detail).join('; ')}.`,
  };
}

module.exports = { detectStaleDecomposePremise, PATH_RE, LINE_REF_RE, LINE_OVERSHOOT_SLACK };
