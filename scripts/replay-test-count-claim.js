#!/usr/bin/env node
'use strict';

// replay-test-count-claim.js -- discover pipelines from projects.json, scan their
// queue/done, queue/blocked, and queue/needs-clarification directories for tasks whose
// history or retryFeedback contains code 'false-test-count-claim', and print structured
// output showing claim kind, claimed N, added M, merge status, and N >= M comparison,
// with totals at the end.
//
// Read-only. Exits 0.
//
// Usage:
//   node scripts/replay-test-count-claim.js                       (uses projects.json at repo root)
//   AGENT_MANAGER_PROJECTS_REGISTRY_PATH=/x/projects.json node scripts/replay-test-count-claim.js
//
// Output is one row per affected task, followed by a totals line.

const fs = require('fs');
const path = require('path');

// Whole-suite run phrases: 'test/*.test.js', 'npm test', 'full suite', 'whole suite',
// 'all tests', 'node --test' (without file path), 'unittest discover', 'pytest' (without
// file path).
const WHOLE_SUITE_PHRASES = [
  'test/*.test.js',
  'npm test',
  'full suite',
  'whole suite',
  'all tests',
  'node --test',
  'unittest discover',
  'pytest',
];

function readProjectRegistry() {
  const registryPath = process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH
    || path.join(__dirname, '..', 'projects.json');
  try {
    const list = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function pipelineProjects(registry) {
  const out = [];
  for (const entry of registry) {
    if (!entry || typeof entry !== 'object') continue;
    const pipelineDir = typeof entry.pipelineDir === 'string' && entry.pipelineDir
      ? entry.pipelineDir
      : (typeof entry.repoRoot === 'string' && entry.repoRoot ? entry.repoRoot : null);
    if (!pipelineDir) continue;
    out.push({
      label: typeof entry.label === 'string' && entry.label ? entry.label : path.basename(pipelineDir),
      pipelineDir,
      repoRoot: typeof entry.repoRoot === 'string' && entry.repoRoot ? entry.repoRoot : null,
    });
  }
  return out;
}

// Extract a test-count claim from free text. Returns { kind, count, phrase } or null.
// kind is one of: 'added', 'pass', 'whole-suite'.
function extractClaimedTestCount(text) {
  const s = String(text || '');
  if (!s) return null;

  // "All N tests pass" / "All N tests pass on the full suite" / "All N tests pass on test/*.test.js" / "All N tests pass with pytest"
  let m = s.match(/\ball\s+(\d+)\s+tests?\s+pass(?:\s+on\s+(.+))?\b/i);
  if (m) {
    const count = Number(m[1]);
    if (Number.isFinite(count) && count > 0) {
      const qualifier = m[2] ? m[2].trim() : '';
      const kind = detectWholeSuite(qualifier) ? 'whole-suite' : 'pass';
      return { kind, count, phrase: `All ${count} tests pass${qualifier ? ' on ' + qualifier : ''}` };
    }
  }

  // "claims N tests but the diff only adds M" / "summary claims N tests" -- extract the CLAIMED count (N)
  m = s.match(/\bclaims\s+(\d+)\s+tests?\b/i);
  if (m) {
    const count = Number(m[1]);
    if (Number.isFinite(count) && count > 0) {
      return { kind: 'added', count, phrase: `claims ${count} tests` };
    }
  }

  // "N tests added" / "Added N tests"
  m = s.match(/\b(\d+)\s+tests?\s+added\b/i);
  if (m) {
    const count = Number(m[1]);
    if (Number.isFinite(count) && count > 0) {
      return { kind: 'added', count, phrase: `${count} tests added` };
    }
  }
  m = s.match(/\badded\s+(\d+)\s+tests?\b/i);
  if (m) {
    const count = Number(m[1]);
    if (Number.isFinite(count) && count > 0) {
      return { kind: 'added', count, phrase: `added ${count} tests` };
    }
  }

  // "M of N tests pass" (a partial-claim shape, still a count claim)
  m = s.match(/\b(\d+)\s+of\s+(\d+)\s+tests?\s+pass\b/i);
  if (m) {
    const passed = Number(m[1]);
    const total = Number(m[2]);
    if (Number.isFinite(passed) && Number.isFinite(total) && total > 0) {
      return { kind: 'pass', count: total, phrase: `${passed} of ${total} tests pass` };
    }
  }

  return null;
}

function detectWholeSuite(qualifier) {
  if (!qualifier) return false;
  for (const phrase of WHOLE_SUITE_PHRASES) {
    if (qualifier.toLowerCase().includes(phrase.toLowerCase())) return true;
  }
  return false;
}

// Count test definitions added in a raw git diff. Looks for test/it/describe/expect/test
// function defs at the start of a line in added lines.
function countAddedTestDefs(rawDiff) {
  const text = String(rawDiff || '');
  if (!text) return 0;
  let count = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1);
    const trimmed = body.trim();
    if (/^\s*(export\s+)?(const|let|var|function)\s+(test|it|describe|spec)\s*\(/.test(trimmed)) {
      count += 1;
      continue;
    }
    if (/^\s*(test|it|describe|spec)\s*\(/.test(trimmed)) {
      count += 1;
    }
  }
  return count;
}

function scanDir(dir) {
  const results = [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return results; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    let task;
    try { task = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (!task || typeof task !== 'object' || !task.id) continue;
    results.push(task);
  }
  return results;
}

function taskHasFalseTestCountClaim(task) {
  // Check retryFeedback
  const rf = String(task.retryFeedback || '');
  if (rf.includes('false-test-count-claim')) return true;

  // Check history events
  const history = Array.isArray(task.history) ? task.history : [];
  for (const evt of history) {
    if (evt && typeof evt === 'object' && evt.code === 'false-test-count-claim') return true;
  }

  return false;
}

// Try to reconstruct the claim info from a task's history/retryFeedback.
function extractClaimFromTask(task) {
  const history = Array.isArray(task.history) ? task.history : [];

  // Walk history for the false-test-count-claim event; its detail/reason often contains
  // the claim text.
  for (const evt of history) {
    if (!evt || typeof evt !== 'object' || evt.code !== 'false-test-count-claim') continue;
    const detail = String(evt.detail || evt.reason || evt.summary || '');
    const claim = extractClaimedTestCount(detail);
    if (claim) return claim;
  }

  // Fall back to retryFeedback
  const rf = String(task.retryFeedback || '');
  return extractClaimedTestCount(rf);
}

function getMergedStatus(task) {
  // A task that has been through the pipeline and has a terminal disposition of 'merged'
  // or 'done' with a final disposition.
  const disp = task.terminalDisposition || task.disposition || '';
  if (disp === 'merged') return 'merged';
  if (disp === 'done') return 'done';
  if (task.resolution === 'implemented' && task.branch) return 'merged';
  // Check history for a merge event
  const history = Array.isArray(task.history) ? task.history : [];
  for (const evt of history) {
    if (evt && evt.stage === 'merged') return 'merged';
  }
  return 'unmerged';
}

// Main
const projects = pipelineProjects(readProjectRegistry());
if (!projects.length) {
  console.error('No pipelines found in projects.json (or AGENT_MANAGER_PROJECTS_REGISTRY_PATH).');
  process.exit(0);
}

const scanDirs = ['done', 'blocked', 'needs-clarification'];
const allRows = [];

for (const proj of projects) {
  const q = path.join(proj.pipelineDir, 'queue');
  if (!fs.existsSync(q)) continue;

  for (const state of scanDirs) {
    const dir = path.join(q, state);
    const tasks = scanDir(dir);
    for (const task of tasks) {
      if (!taskHasFalseTestCountClaim(task)) continue;

      const claim = extractClaimFromTask(task);
      const claimedN = claim ? claim.count : null;
      const kind = claim ? claim.kind : null;
      const claimPhrase = claim ? claim.phrase : null;

      // Try to get the added count from the diff
      let addedM = null;
      const rawDiff = task.rawDiff || '';
      if (rawDiff) {
        addedM = countAddedTestDefs(rawDiff);
      }

      // If no rawDiff, try implementResponse
      if (addedM === null || addedM === 0) {
        let items = null;
        try {
          const { parseJsonMaybeFenced } = require('../src/json-fence.js');
          const v = parseJsonMaybeFenced(String(task.implementResponse || ''));
          if (v) items = Array.isArray(v) ? v : [v];
        } catch { /* ignore */ }
        if (items) {
          let diffText = '';
          for (const item of items) {
            if (item && typeof item === 'object' && item.diff) {
              diffText += item.diff + '\n';
            }
          }
          if (diffText) addedM = countAddedTestDefs(diffText);
        }
      }

      const merged = getMergedStatus(task);
      const nGteM = claimedN !== null && addedM !== null ? claimedN >= addedM : null;

      allRows.push({
        project: proj.label,
        state,
        taskId: task.id,
        kind,
        claimedN,
        addedM,
        merged,
        nGteM,
        phrase: claimPhrase,
      });
    }
  }
}

// Print header
console.log('false-test-count-claim replay');
console.log('=============================\n');

let totalClaimed = 0;
let totalAdded = 0;
let totalMerged = 0;
let totalNgteM = 0;
let totalRows = 0;

for (const row of allRows) {
  totalRows += 1;
  if (row.merged === 'merged') totalMerged += 1;
  if (row.nGteM === true) totalNgteM += 1;
  if (row.claimedN !== null) totalClaimed += 1;
  if (row.addedM !== null) totalAdded += 1;

  const claimStr = row.claimedN !== null ? `${row.claimedN}` : '(unknown)';
  const addedStr = row.addedM !== null ? `${row.addedM}` : '(unknown)';
  const compareStr = row.nGteM !== null
    ? (row.nGteM ? 'YES' : 'NO')
    : '(N/A)';

  console.log(
    `${row.project.padEnd(20)} ${row.state.padEnd(22)} ${row.taskId.slice(0, 40).padEnd(40)} ` +
    `kind=${String(row.kind || 'none').padEnd(12)} ` +
    `claimed=${claimStr.padEnd(6)} added=${addedStr.padEnd(6)} ` +
    `merged=${String(row.merged).padEnd(8)} N>=M=${compareStr}`
  );
  if (row.phrase) {
    console.log(`  phrase: "${row.phrase}"`);
  }
}

console.log('');
console.log('Totals:');
console.log(`  tasks with false-test-count-claim: ${totalRows}`);
console.log(`  merged: ${totalMerged}`);
console.log(`  unmerged: ${totalRows - totalMerged}`);
console.log(`  with claim count: ${totalClaimed}`);
console.log(`  with added count: ${totalAdded}`);
console.log(`  N >= M (claim >= added): ${totalNgteM}`);
console.log(`  N < M (claim < added, potential false claim): ${totalRows - totalNgteM - (totalRows - totalClaimed - (totalRows - totalAdded))}`);
