'use strict';

// Deterministic doc-accuracy critic — no-memory pipeline: every run is stateless, reads
// only the repo tree, and emits a pure JSON verdict with no LLM call. The no-memory
// rationale this enforces: in this pipeline a stateful memory layer does not exist, so a
// durable doc (AGENTS.md) is the only standing statement of intent a future stateless
// pass will ever read — a path reference in it that names a file that is not in the tree
// is a permanent false claim handed to every subsequent agent, and catching it is a pure
// existence question with zero semantic residue, i.e. exactly the kind of check the
// ghost-in-the-machine principle says must never be delegated to a model.
//
// Mirrors the deterministic-first shape of src/deep-dive-grounding-check.js: its Check 1
// is a free, fully deterministic verification of a claim against ground truth before any
// judgment call — here the whole check IS that deterministic layer (does the referenced
// file exist in the tree?), and there is deliberately no cheap-model fallback because a
// file's existence is binary.
//
// If this module ever constructs a model prompt, it MUST inject currentDateLine() from
// ./current-date-line.js into that prompt, so the model is anchored to the real current
// date rather than a training-data intuition of "now" (same rule that closed the
// buildVerdictPrompt "future date" incident).

const fs = require('fs');
const path = require('path');
const { currentDateLine } = require('./current-date-line.js');

// Held for any future prompt-building code path in this module; the current
// deterministic-only path performs no model call and never reads it.
const DATE_LINE = currentDateLine();

// A repo-relative path reference: at least one directory segment + a file ending in
// .js or .md. The lookbehind refuses a match immediately preceded by a word char,
// dot, colon, slash, or hyphen -- so absolute paths (/media/wok/.../register.js),
// URL tails, and the inner segments of longer paths (e.g. the `cache/...` tail of
// `model-cache/...`) never match, and `src/*.js`-style
// wildcard prose (no literal filename) does not match at all. Single-segment bare
// mentions (`review-task.js`) are deliberately NOT claims: they name a module without
// a location, and AGENTS.md's bare names resolve under src/, so verifying them at the
// repo root would flag nearly every one as stale.
const PATH_REF_RE = /(?<![\w.:\/-])(?:[\w.\-]+\/)+[\w.\-]+\.(?:js|md)\b/g;

function parseRepoRoot(argv) {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo-root') {
      if (i + 1 >= args.length) {
        process.stderr.write('error: --repo-root requires a value\n');
        process.exit(2);
      }
      return path.resolve(args[i + 1]);
    }
  }
  return process.cwd();
}

// lines -> [{ ref, line }] for every repo-relative .js/.md reference (1-based line).
function extractPathRefs(lines) {
  const refs = [];
  lines.forEach((text, idx) => {
    PATH_REF_RE.lastIndex = 0;
    let m;
    while ((m = PATH_REF_RE.exec(text))) {
      let ref = m[0];
      if (ref.startsWith('./')) ref = ref.slice(2); // `require('./src/concepts.js')` form
      refs.push({ ref, line: idx + 1 });
    }
  });
  return refs;
}

// repoRoot -> { pass, stale_claims } -- one stale_claims entry per occurrence, so the
// same missing file cited on several lines is reported on every line it misleads.
function checkDocAccuracy(repoRoot) {
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return { pass: false, stale_claims: [{ ref: 'AGENTS.md', line: 0 }] };
  }
  const lines = fs.readFileSync(agentsPath, 'utf8').split('\n');
  const stale_claims = [];
  for (const { ref, line } of extractPathRefs(lines)) {
    if (!fs.existsSync(path.join(repoRoot, ref))) {
      stale_claims.push({ ref, line });
    }
  }
  return { pass: stale_claims.length === 0, stale_claims };
}

function main() {
  const repoRoot = parseRepoRoot(process.argv);
  const result = checkDocAccuracy(repoRoot);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.pass ? 0 : 1;
}

if (require.main === module) {
  main();
}

module.exports = { checkDocAccuracy, extractPathRefs, DATE_LINE };
