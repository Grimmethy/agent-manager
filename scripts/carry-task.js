#!/usr/bin/env node
'use strict';

// Hand-carry helper for pipeline tasks. One-shot CLI, no polling.
//
//   prepare <record>             strip stale draft state, truncate huge history details,
//                                append draft-started. Fetches grounding ITSELF (runs the real
//                                get-grounding-source.js) and refuses if it carries stale failure text.
//   check   <record>             print each acceptance criterion's pass flag; warn on 'fail' result
//                                phrasing without PASS context and on stated counts with no backing number.
//   review  <record> [--lane L]  run reviewTask once; if the leased lane fails, fall back ONCE to an unleased lane (logged).
//   place   <record>             refuse unless status is approved; copy to queue/approved/<id>.json and
//                                remove any live queue/adhoc/<id>.json copy.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseAcceptanceBlock } = require('../src/acceptance-criteria.js');

const HISTORY_DETAILS_MAX = 2000;
const STRIP_FIELDS = ['draftAttempts', 'claimedAt', 'localVotes', 'blockedReason'];
const DEFAULT_GROUNDING_SCRIPT = path.join(__dirname, '..', 'src', 'get-grounding-source.js');
// Failure markers that indicate stale worklog output from an earlier draft attempt.
const STALE_FAILURE_RE = /cannot access|No such file|ENOENT|\bfailed\b|\bfailing\b/i;
const FAIL_WORD_RE = /\bfails?\b|\bfailed\b|\bfailing\b/i;

function readRecord(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Runs the real grounding producer for this record. CARRY_TASK_GROUNDING_SCRIPT overrides the
// script path (used by tests only); the default is the production get-grounding-source.js.
function fetchGrounding(recordPath, env = process.env) {
  const script = env.CARRY_TASK_GROUNDING_SCRIPT || DEFAULT_GROUNDING_SCRIPT;
  const r = spawnSync(process.execPath, [script, recordPath], { encoding: 'utf8', env });
  if (r.status !== 0) {
    throw new Error(`grounding script failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return r.stdout || '';
}

function findStaleFailureLines(groundingText) {
  return String(groundingText || '').split('\n').filter((l) => STALE_FAILURE_RE.test(l));
}

// Pure: returns { ok, record, stale }. Does not touch the disk.
function prepareRecord(rec, groundingText, now = new Date()) {
  const stale = findStaleFailureLines(groundingText);
  if (stale.length > 0) return { ok: false, stale };
  const out = { ...rec };
  for (const f of STRIP_FIELDS) delete out[f];
  const history = Array.isArray(out.history) ? out.history : [];
  out.history = history.map((h) => {
    if (h && typeof h.details === 'string' && h.details.length > HISTORY_DETAILS_MAX) {
      return { ...h, details: h.details.slice(0, HISTORY_DETAILS_MAX) + '...[truncated]' };
    }
    return h;
  });
  out.history.push({ stage: 'draft-started', at: now.toISOString() });
  return { ok: true, record: out, stale: [] };
}

function cmdPrepare(recordPath) {
  const rec = readRecord(recordPath);
  const grounding = fetchGrounding(recordPath);
  const res = prepareRecord(rec, grounding);
  if (!res.ok) {
    console.error('prepare refused: grounding carries stale failure text:');
    for (const l of res.stale) console.error('  ' + l.trim());
    return 1;
  }
  fs.writeFileSync(recordPath, JSON.stringify(res.record, null, 2) + '\n');
  console.log(`prepared ${recordPath}`);
  return 0;
}

// Pure: returns { criteria, warnings }.
function checkRecord(rec) {
  const text = String(rec.implementResponse || rec.summary || '');
  const criteria = parseAcceptanceBlock(text);
  const warnings = [];
  for (const c of criteria) {
    const s = JSON.stringify(c);
    if (FAIL_WORD_RE.test(s) && !/\bPASS\b/.test(s)) {
      warnings.push(`criterion "${c.label || c.text || s.slice(0, 80)}" contains fail/failed wording without PASS context`);
    }
  }
  const countRe = /\b(\d+)\s+(mutations?|mutants?|cases?|tests?)\b/gi;
  let m;
  while ((m = countRe.exec(text)) !== null) {
    const n = m[1];
    const rest = text.slice(0, m.index) + text.slice(m.index + m[0].length);
    if (!new RegExp(`\\b${n}\\b`).test(rest)) {
      warnings.push(`stated count "${m[0]}" has no matching number in the record`);
    }
  }
  return { criteria, warnings };
}

function cmdCheck(recordPath) {
  const { criteria, warnings } = checkRecord(readRecord(recordPath));
  for (const c of criteria) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.label || c.text || ''}`.trimEnd());
  for (const w of warnings) console.log(`WARNING: ${w}`);
  return warnings.length > 0 ? 1 : 0;
}

// Runs reviewTask once. reviewer is injectable for tests.
async function reviewRecord(recordPath, { lane = null, reviewer } = {}) {
  const run = reviewer || require('../src/review-task.js').reviewTask;
  const rec = readRecord(recordPath);
  let result = await run(rec, { lane });
  if (lane && (!result || result.succeeded === false)) {
    console.error(`lane ${lane} unavailable; falling back once to an unleased lane`);
    result = await run(rec, { lane: null });
  }
  return result;
}

async function cmdReview(recordPath, flags) {
  const result = await reviewRecord(recordPath, { lane: flags.lane || null });
  console.log(JSON.stringify({ verdict: result && result.verdict, succeeded: result && result.succeeded }));
  return 0;
}

// Copies an approved record into queue/approved/<id>.json and removes any live adhoc copy.
function placeRecord(recordPath, { root = process.cwd() } = {}) {
  const rec = readRecord(recordPath);
  if (rec.status !== 'approved') {
    return { ok: false, reason: `status is "${rec.status}", not approved` };
  }
  const approvedDir = path.join(root, 'queue', 'approved');
  fs.mkdirSync(approvedDir, { recursive: true });
  const dest = path.join(approvedDir, `${rec.id}.json`);
  fs.copyFileSync(recordPath, dest);
  const adhoc = path.join(root, 'queue', 'adhoc', `${rec.id}.json`);
  if (fs.existsSync(adhoc)) fs.unlinkSync(adhoc);
  return { ok: true, dest };
}

function cmdPlace(recordPath) {
  const res = placeRecord(recordPath);
  if (!res.ok) {
    console.error(`place refused: ${res.reason}`);
    return 1;
  }
  console.log(`placed ${res.dest}`);
  return 0;
}

function parseCli(argv) {
  const [sub, recordPath, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--lane') { flags.lane = rest[i + 1]; i++; }
  }
  return { sub, recordPath, flags };
}

async function main(argv) {
  const { sub, recordPath, flags } = parseCli(argv);
  if (!sub || !recordPath || !['prepare', 'check', 'review', 'place'].includes(sub)) {
    console.error('usage: carry-task.js <prepare|check|review|place> <record> [--lane L]');
    return 2;
  }
  if (sub === 'prepare') return cmdPrepare(recordPath);
  if (sub === 'check') return cmdCheck(recordPath);
  if (sub === 'review') return cmdReview(recordPath, flags);
  return cmdPlace(recordPath);
}

module.exports = { prepareRecord, checkRecord, reviewRecord, placeRecord, findStaleFailureLines, parseCli };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e && e.message ? e.message : String(e));
    process.exitCode = 1;
  });
}
