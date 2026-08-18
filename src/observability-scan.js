'use strict';

// Deterministic, dependency-free observability-hygiene scanner. Same split as
// unused-export-scan.js: this script only DETECTS and flags candidates (queue/
// observability-flags.json); a downstream Ornith triage task judges genuine issue vs.
// false positive and proposes a fix. That split matters here more than usual -- every
// rule below is a heuristic (brace-matching, keyword windows), not a real parser, so
// false positives are expected and are Ornith's job to filter, not this script's.
//
// Rules encoded here come from two cloned reference repos (see project idea
// "OpenTelemetry-Observability-Idea", 2026-07-26):
//   - specification/error-handling.md (opentelemetry-specification): background/async
//     errors must not vanish silently; long-running processes should expose a health
//     signal.
//   - docs/general/naming.md (semantic-conventions): span/metric/attribute names must be
//     lowercase, dot-namespaced, snake_case per segment; counters must not use a
//     `_total` suffix; UpDownCounter names must not be pluralized.
// The naming/reserved-attribute rules only fire on a project that actually depends on
// an OpenTelemetry SDK -- agent-manager itself doesn't, so those two rules are expected
// to stay dormant against this repo and only activate against a scanned community
// project that has adopted OTel.

const fs = require('fs');
const path = require('path');

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'queue', 'instances', 'dist', 'build', 'coverage', 'venv', '.venv', '__pycache__']);
const LOOP_CONTEXT_WINDOW_LINES = 40;
const HEALTH_SIGNAL_RE = /heartbeat|health.?check|liveness|readiness/i;

function listSourceFiles(dir, extensions) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Dot-directories (.git, .claude/worktrees, .venv, etc.) are tooling/session
        // state, never a project's own reviewable source -- confirmed live scanning
        // this repo itself, which picked up stray .claude/worktrees/*/*.js copies
        // before this check existed.
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        result.push(...listSourceFiles(path.join(dir, entry.name), extensions));
      } else if (entry.isFile() && extensions.some((e) => entry.name.endsWith(e))) {
        result.push(path.resolve(dir, entry.name));
      }
    }
    return result;
  } catch {
    return [];
  }
}

// Minified/bundled build output (index-BoHO2STY.js-style hashed bundler filenames under
// static/assets/, dist/, etc.) has no meaningful line structure to reason about, but
// SKIP_DIRS above only catches known BUILD DIRECTORY names -- a bundler that outputs into
// static/assets/ (a real, common convention, not something worth guessing every variant
// of into an ever-growing SKIP_DIRS list) sails right through undetected. Confirmed live,
// 2026-08-18: queue/blocked/ had 100+ repeat-offender observability_review tasks against
// exactly this shape -- captain-claw/flight_deck/static/assets/index-BoHO2STY.js, a
// React production bundle (single-letter minified identifiers, zero whitespace) -- every
// one blocked in review because no drafting model can meaningfully fix (or even parse) a
// "silent catch block" inside minified third-party runtime code that was never meant to
// be hand-edited in the first place; even if it could, the fix belongs in the pre-bundle
// source, not the bundle. A minifier collapsing an entire module into one line routinely
// produces lines in the tens or hundreds of thousands of characters -- real hand-written
// source, however dense, essentially never does. Checked once per file, not per rule, so
// every rule in this module benefits without each needing its own guard.
const MINIFIED_LINE_LENGTH_THRESHOLD = 2000;
function isLikelyMinified(text) {
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      if (i - lineStart > MINIFIED_LINE_LENGTH_THRESHOLD) return true;
      lineStart = i + 1;
    }
  }
  return false;
}

function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

// Best-effort brace-body extractor (not a real parser): given the index of an opening
// '{', returns the substring up to (exclusive of) its matching '}', tracking string
// literals and comments so a brace inside a string/comment doesn't miscount depth.
// Same reasoning as json-fence.js's extractBalancedJson, extended to cover the extra
// string/comment forms real source code has that raw JSON doesn't.
function extractBraceBody(text, openIndex) {
  let depth = 0;
  let inString = null; // one of "'", '"', '`', or null
  let inLineComment = false;
  let inBlockComment = false;
  let escapeNext = false;
  let bodyStart = -1;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '\\') { escapeNext = true; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }

    if (ch === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(bodyStart, i);
    }
  }
  return null; // unbalanced -- truncated file or scan artifact, nothing to report
}

// Strips comments from a body so a body that's "empty except for a comment explaining
// why it's intentionally empty" doesn't read as suspicious content.
function stripComments(body) {
  return body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

// error-handling.md's Guidance #2/#3/self-diagnostics: a caught error that is neither
// rethrown nor surfaced (logged, recorded as a metric, etc.) has silently vanished.
// Skips a body containing any of these tokens -- presence of ANY of them is read as
// "this error was surfaced somehow," even if imperfectly.
const SURFACES_ERROR_RE = /throw|console\.|log(ger)?\.|\.error\(|Error\(|raise\b|panic\(|record|notify|alert|metric/i;

function findSilentCatchBlocks(text, relPath) {
  const findings = [];
  const catchRe = /\bcatch\s*(\([^)]*\))?\s*\{/g;
  let m;
  while ((m = catchRe.exec(text))) {
    const openIndex = m.index + m[0].length - 1;
    const body = extractBraceBody(text, openIndex);
    if (body === null) continue;
    const stripped = stripComments(body);
    if (stripped.length === 0 || !SURFACES_ERROR_RE.test(stripped)) {
      findings.push({
        rule: 'silent-catch-block',
        file: relPath,
        line: lineOfIndex(text, m.index),
        detail: stripped.length === 0
          ? 'catch block is empty -- the error is silently discarded with no log/rethrow/metric'
          : 'catch block does not appear to log, rethrow, or otherwise surface the error',
      });
    }
  }
  return findings;
}

// self-observability.md: a long-running process should expose a health signal an
// operator can monitor. Heuristic: a while(true)/for(;;)/setInterval construct with no
// heartbeat/health-check/liveness keyword within the following N lines.
const LOOP_START_RE = /\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)|\bsetInterval\s*\(/g;

function findUnguardedLoops(text, relPath) {
  const findings = [];
  let m;
  LOOP_START_RE.lastIndex = 0;
  while ((m = LOOP_START_RE.exec(text))) {
    const startLine = lineOfIndex(text, m.index);
    const lines = text.split('\n');
    const windowText = lines.slice(startLine - 1, startLine - 1 + LOOP_CONTEXT_WINDOW_LINES).join('\n');
    if (!HEALTH_SIGNAL_RE.test(windowText)) {
      findings.push({
        rule: 'unguarded-long-running-loop',
        file: relPath,
        line: startLine,
        detail: `long-running loop with no heartbeat/health-check signal within ${LOOP_CONTEXT_WINDOW_LINES} lines`,
      });
    }
  }
  return findings;
}

// Only the naming/reserved-attribute rules are conditional on the project actually
// depending on an OpenTelemetry SDK -- everything else applies to any codebase.
function hasOtelDependency(repoRoot) {
  const checks = [
    { file: 'package.json', re: /"@opentelemetry\// },
    { file: 'requirements.txt', re: /\bopentelemetry-/ },
    { file: 'pyproject.toml', re: /opentelemetry-/ },
    { file: 'go.mod', re: /go\.opentelemetry\.io/ },
  ];
  for (const { file, re } of checks) {
    try {
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      if (re.test(text)) return true;
    } catch {}
  }
  return false;
}

// naming.md: lowercase, dot-namespaced, snake_case per segment.
function isValidOtelName(name) {
  if (name !== name.toLowerCase()) return 'name is not lowercase';
  if (!/^[a-z][a-z0-9_.]*[a-z0-9]$/.test(name)) {
    return 'name must be lowercase letters/digits/underscore/dot, starting with a letter and ending alphanumeric';
  }
  if (name.includes('..') || name.includes('__')) return 'name must not contain consecutive delimiters';
  return null;
}

const OTEL_CALL_RE = /\.(setAttribute|createCounter|createUpDownCounter|createHistogram|createGauge|startSpan)\(\s*['"]([^'"]+)['"]/g;

function findOtelNamingViolations(text, relPath) {
  const findings = [];
  let m;
  OTEL_CALL_RE.lastIndex = 0;
  while ((m = OTEL_CALL_RE.exec(text))) {
    const [, method, name] = m;
    const line = lineOfIndex(text, m.index);
    const nameError = isValidOtelName(name);
    if (nameError) {
      findings.push({ rule: 'otel-naming-convention', file: relPath, line, detail: `${method}('${name}'): ${nameError}` });
      continue;
    }
    if ((method === 'createCounter' || method === 'createUpDownCounter') && name.endsWith('_total')) {
      findings.push({ rule: 'otel-naming-convention', file: relPath, line, detail: `${method}('${name}'): counter/UpDownCounter names should not use a '_total' suffix (naming.md)` });
    }
    if (method === 'createUpDownCounter' && /s$/.test(name) && !/ss$/.test(name)) {
      findings.push({ rule: 'otel-naming-convention', file: relPath, line, detail: `${method}('${name}'): UpDownCounter names should not be pluralized (naming.md) -- verify this isn't a false positive on a naturally-plural word` });
    }
  }
  return findings;
}

// Reserved attributes (semantic-conventions.md): service.name/error.type/etc. must
// appear SOMEWHERE in an OTel-instrumented project. Repo-wide, not per-file -- these
// are meant to exist once (e.g. at Resource construction), not on every call site.
const RESERVED_ATTRIBUTES = ['service.name', 'error.type'];

function findMissingReservedAttributes(repoRoot, files) {
  const found = new Set();
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const attr of RESERVED_ATTRIBUTES) {
      if (found.has(attr)) continue;
      if (text.includes(attr)) found.add(attr);
    }
    if (found.size === RESERVED_ATTRIBUTES.length) break;
  }
  return RESERVED_ATTRIBUTES.filter((attr) => !found.has(attr)).map((attr) => ({
    rule: 'missing-reserved-attribute',
    file: null,
    line: null,
    detail: `project depends on an OpenTelemetry SDK but '${attr}' was not found anywhere in scanned source -- required by semantic-conventions.md`,
  }));
}

// Scans one project (a clonePath, already onboarded elsewhere -- this script never
// clones anything itself). Returns findings with projectSlug/scannedAt attached, ready
// to append to queue/observability-flags.json.
function scanProject(clonePath, projectSlug) {
  const allFiles = listSourceFiles(clonePath, SCAN_EXTENSIONS);
  // One read+check per file, up front, so every rule below (silent-catch-block,
  // unguarded-loop, OTel naming, reserved-attribute) skips minified/bundled files the
  // same way instead of each needing its own guard -- see isLikelyMinified's own comment.
  const files = allFiles.filter((file) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
    return !isLikelyMinified(text);
  });
  const scannedAt = new Date().toISOString();
  const findings = [];

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const relPath = path.relative(clonePath, file).replace(/\\/g, '/');
    findings.push(...findSilentCatchBlocks(text, relPath));
    findings.push(...findUnguardedLoops(text, relPath));
  }

  if (hasOtelDependency(clonePath)) {
    for (const file of files) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const relPath = path.relative(clonePath, file).replace(/\\/g, '/');
      findings.push(...findOtelNamingViolations(text, relPath));
    }
    findings.push(...findMissingReservedAttributes(clonePath, files));
  }

  return findings.map((f) => ({ ...f, projectSlug, scannedAt }));
}

module.exports = {
  scanProject,
  findSilentCatchBlocks,
  findUnguardedLoops,
  findOtelNamingViolations,
  findMissingReservedAttributes,
  hasOtelDependency,
  isValidOtelName,
  extractBraceBody,
  listSourceFiles,
  lineOfIndex,
  isLikelyMinified,
};
