'use strict';

// Pure pre-filter for two loop patterns flagged by the deterministic recheck
// (src/deterministic-recheck-registry.js). It returns dismiss: true only on an explicit
// positive match; every other input fails open to investigate with dismiss: false.
// No timers, no file or process I/O, no logging: the caller records each decision.

const LOOP_HEADER_RE = /\b(?:for|while)\s*(?:await\s*)?\(/;
const SLICE_BOUND_RE = /\.slice\(\s*0\s*,\s*[\w$.]+\s*\)/;
const CHUNK_STEP_RE = /\+=\s*([A-Za-z_$][\w$.]*)/;
const CHUNK_NAME_RE = /batch|chunk/i;
const AWAIT_RE = /\bawait\b/;
const DELIBERATE_COMMENT_RE = /deliberate|rate.?limit|throttle|intentionally sequential/i;
const COMMENT_START_RE = /\/\/|\/\*/;
const BLOCK_CONTINUATION_RE = /^\s*\*/;
const SYNC_MARKER_RE = /deliberate:\s*sync-io-in-loop\b/;
const SEQUENTIAL_NAMES = ['sequential-await-in-loop', 'sequential await in loop'];
const SYNC_IO_NAMES = ['sync-io-in-loop', 'sync io in loop'];

function decide(dismiss, rule, reason) {
  return { dismiss, rule, reason };
}

function fallThrough(reason) {
  return decide(false, null, reason);
}

// The flagLine must match exactly one trimmed line of the snippet; otherwise the location is ambiguous.
function locateFlagLine(lines, flagLine) {
  const want = flagLine.trim();
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === want) {
      if (found !== -1) return -1;
      found = i;
    }
  }
  return found;
}

// Index of the line where the block opened on lines[h] closes, or -1 when it never closes.
function blockEnd(lines, h) {
  let depth = 0;
  let opened = false;
  for (let i = h; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}' && opened) {
        depth--;
      }
    }
    if (opened && depth <= 0) return i;
  }
  return -1;
}

// Bounded means .slice(0, N) on the header's iterator, or a chunk step named batch/chunk.
function isBoundedHeader(header) {
  if (SLICE_BOUND_RE.test(header)) return true;
  const step = CHUNK_STEP_RE.exec(header);
  return step !== null && CHUNK_NAME_RE.test(step[1]);
}

function mentionsDeliberateInComment(line) {
  const start = line.search(COMMENT_START_RE);
  let text = null;
  if (start >= 0) text = line.slice(start);
  else if (BLOCK_CONTINUATION_RE.test(line)) text = line;
  return text !== null && DELIBERATE_COMMENT_RE.test(text);
}

function ruleR1(lines, h, end) {
  if (!isBoundedHeader(lines[h])) {
    return fallThrough('R1 not applied: the loop iterator is not visibly bounded');
  }
  let awaitInBody = false;
  for (let i = h + 1; i <= end; i++) {
    if (AWAIT_RE.test(lines[i])) {
      awaitInBody = true;
      break;
    }
  }
  if (!awaitInBody) return fallThrough('R1 not applied: no await in the loop body');
  const adjacent = [];
  if (h > 0) adjacent.push(lines[h - 1]);
  for (let i = h; i <= end; i++) adjacent.push(lines[i]);
  if (!adjacent.some(mentionsDeliberateInComment)) {
    return fallThrough('R1 not applied: no adjacent deliberate or rate-limit comment');
  }
  return decide(true, 'R1', 'bounded loop, awaited call in body, adjacent deliberate comment');
}

function ruleR2(lines, h) {
  const markedHere = SYNC_MARKER_RE.test(lines[h]);
  const markedAbove = h > 0 && SYNC_MARKER_RE.test(lines[h - 1]);
  if (!markedHere && !markedAbove) {
    return fallThrough('R2 not applied: no adjacent deliberate sync-io-in-loop marker');
  }
  return decide(true, 'R2', 'adjacent deliberate: sync-io-in-loop marker on the flagged loop');
}

function shouldAutoDismiss(patternName, snippet, flagLine) {
  if (typeof patternName !== 'string' || typeof snippet !== 'string' || typeof flagLine !== 'string') {
    return fallThrough('invalid input: expected three strings');
  }
  const name = patternName.trim().toLowerCase();
  const isSequential = SEQUENTIAL_NAMES.includes(name);
  const isSyncIo = SYNC_IO_NAMES.includes(name);
  if (!isSequential && !isSyncIo) {
    return fallThrough('no pre-filter rule for pattern ' + patternName);
  }
  const lines = snippet.split(/\r?\n/);
  const h = locateFlagLine(lines, flagLine);
  if (h < 0) return fallThrough('flagLine is missing or not unique in snippet');
  if (!LOOP_HEADER_RE.test(lines[h])) return fallThrough('flagLine is not a loop header');
  if (isSequential) {
    const end = blockEnd(lines, h);
    if (end < 0) return fallThrough('R1 not applied: loop body does not close');
    return ruleR1(lines, h, end);
  }
  return ruleR2(lines, h);
}

module.exports = { shouldAutoDismiss };
