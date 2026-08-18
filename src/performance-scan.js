'use strict';

// Deterministic, dependency-free performance-hygiene scanner -- Brain Dump #94
// ("our pretty little cpu is getting overloaded... we need to develop a performance
// review job for projects anyways"). Same split as observability-scan.js: this script
// only DETECTS and flags candidates (queue/performance-flags.json); a downstream Ornith
// triage task judges genuine issue vs. false positive and proposes a fix. That split
// matters here more than usual -- every rule below is a heuristic (brace-matching,
// keyword windows), not a real profiler or parser, so false positives are expected and
// are Ornith's job to filter, not this script's.
//
// Rules are JS/TS-specific (unlike observability-scan.js's file-level rules, which are
// language-agnostic) since two of the three key off Node-specific APIs (fs.*Sync,
// child_process's *Sync) and the third off a JS-only idiom -- scanning .py/.go source
// for them would just be noise.

const fs = require('fs');
const path = require('path');
const { extractBraceBody, listSourceFiles, lineOfIndex, isLikelyMinified } = require('./observability-scan.js');

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx'];
const LOOP_START_RE = /\bfor\s*\([^)]*\)\s*\{|\bwhile\s*\([^)]*\)\s*\{/g;

// A synchronous fs/child_process call blocks the event loop for its full duration --
// fine once, a CPU/latency problem when it runs once per loop iteration instead of
// once total or in parallel.
const SYNC_IO_RE = /\b(?:readFileSync|writeFileSync|appendFileSync|existsSync|statSync|lstatSync|readdirSync|mkdirSync|renameSync|copyFileSync|unlinkSync|execSync|spawnSync)\s*\(/;

// A sequential `await` inside a loop serializes work that's very often independent
// per-iteration (e.g. N separate network/file fetches) and could run concurrently via
// Promise.all -- not always wrong (a deliberate rate-limited/ordered sequence is a
// legitimate reason), which is exactly why this is a candidate for Ornith to judge, not
// an auto-fix.
const AWAIT_RE = /\bawait\b/;

function findLoopBodyIssues(text, relPath) {
  const findings = [];
  LOOP_START_RE.lastIndex = 0;
  let m;
  while ((m = LOOP_START_RE.exec(text))) {
    const openIndex = m.index + m[0].length - 1;
    const body = extractBraceBody(text, openIndex);
    if (body === null) continue;
    const line = lineOfIndex(text, m.index);
    if (SYNC_IO_RE.test(body)) {
      findings.push({
        rule: 'sync-io-in-loop',
        file: relPath,
        line,
        detail: 'a synchronous fs/child_process call runs inside this loop, blocking the event loop once per iteration',
      });
    }
    if (AWAIT_RE.test(body)) {
      findings.push({
        rule: 'sequential-await-in-loop',
        file: relPath,
        line,
        detail: 'an await inside this loop serializes work that may be independent per-iteration and could run concurrently (e.g. via Promise.all)',
      });
    }
  }
  return findings;
}

// JSON.parse(JSON.stringify(x)) is a common "deep clone" idiom that pays for a full
// serialize+reparse of the whole structure -- wasteful on a large/hot object compared
// to a real structural clone (structuredClone, or a targeted shallow copy).
const JSON_CLONE_RE = /JSON\.parse\s*\(\s*JSON\.stringify\s*\(/g;

function findJsonDeepCloneAntipattern(text, relPath) {
  const findings = [];
  JSON_CLONE_RE.lastIndex = 0;
  let m;
  while ((m = JSON_CLONE_RE.exec(text))) {
    findings.push({
      rule: 'json-deep-clone-antipattern',
      file: relPath,
      line: lineOfIndex(text, m.index),
      detail: 'JSON.parse(JSON.stringify(...)) used to deep-clone -- pays for a full serialize+reparse; consider structuredClone or a targeted copy',
    });
  }
  return findings;
}

// Scans one project (a clonePath, already onboarded elsewhere -- this script never
// clones anything itself). Returns findings with projectSlug/scannedAt attached, ready
// to append to queue/performance-flags.json. Same shape as observability-scan.js's
// scanProject on purpose -- task-sources.js's nextPerformanceReviewTask consumes it
// identically to nextObservabilityReviewTask's own scanProject call.
function scanProject(clonePath, projectSlug) {
  const files = listSourceFiles(clonePath, SCAN_EXTENSIONS);
  const scannedAt = new Date().toISOString();
  const findings = [];

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    // Same minified/bundled-build-output skip as observability-scan.js's own scanProject
    // -- a loop-body/deep-clone finding inside a hashed bundler output file is exactly as
    // unfixable-by-design as a silent-catch-block one there (see isLikelyMinified's
    // comment for the live-confirmed repeat-offender queue/blocked/ backlog this fixes).
    if (isLikelyMinified(text)) continue;
    const relPath = path.relative(clonePath, file).replace(/\\/g, '/');
    findings.push(...findLoopBodyIssues(text, relPath));
    findings.push(...findJsonDeepCloneAntipattern(text, relPath));
  }

  return findings.map((f) => ({ ...f, projectSlug, scannedAt }));
}

module.exports = {
  scanProject,
  findLoopBodyIssues,
  findJsonDeepCloneAntipattern,
};
