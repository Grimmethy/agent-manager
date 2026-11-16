#!/usr/bin/env node
'use strict';

// review-quality-report: a read-only, one-shot summary of review quality per task family.
// It reads AGENT_MANAGER_PIPELINE_DIR/queue/{done,blocked,approved}/*.json and queue/branch-verdicts.json, then prints a table.
//   node scripts/review-quality-report.js [--days N]     (N = positive integer, default 14)
// Uses only fs and path. No network, no child processes, no timers, no file changes.

const fs = require('fs');
const path = require('path');

const DEFAULT_DAYS = 14;
const MIN_N = 10;
const STATES = ['done', 'blocked', 'approved'];
const DAY_MS = 86400000;
const USAGE = `usage: node scripts/review-quality-report.js [--days N]   (N = positive integer, default ${DEFAULT_DAYS})`;

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseDays(argv) {
  let days = DEFAULT_DAYS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== '--days') fail(`unknown argument: ${arg}\n${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined || !/^[1-9]\d*$/.test(value)) {
      fail(`--days needs a positive integer, got: ${value === undefined ? '(nothing)' : value}\n${USAGE}`);
    }
    days = Number(value);
    i += 1;
  }
  return days;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listJson(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
}

function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function pct(a, b) {
  return b ? `${Math.round((100 * a) / b)}%` : 'n/a';
}

function isUnanimousApprove(votes) {
  return votes.length > 0 && votes.every((v) => v && String(v.verdict || '').toUpperCase() === 'APPROVE');
}

// Top-level task .json files only (the _archived sub-folders are skipped by the filter).
// A record's time is its createdAt; if that is missing or unparseable, the file mtime is used.
function loadRecords(pipelineDir, cutoffMs) {
  const records = [];
  const scanned = {};
  for (const state of STATES) {
    const dir = path.join(pipelineDir, 'queue', state);
    scanned[state] = 0;
    for (const name of listJson(dir)) {
      const file = path.join(dir, name);
      const task = readJson(file);
      if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
      let whenMs = Date.parse(task.createdAt);
      if (Number.isNaN(whenMs)) whenMs = mtimeMs(file);
      if (whenMs < cutoffMs) continue;
      scanned[state] += 1;
      records.push({ state, id: String(task.id || name.replace(/\.json$/, '')), task });
    }
  }
  return { records, scanned };
}

// Family key = task.source (no separate task-level family field was found on the records).
function aggregate(records) {
  const fams = {};
  for (const r of records) {
    const key = String(r.task.source || 'unknown');
    if (!fams[key]) {
      fams[key] = {
        n: 0,
        hasVotes: false, votedTasks: 0, unanimous: [],
        hasRawDiff: false, rawDiffWithValue: 0,
        hasPromptContext: false, priorVerdictCount: 0,
        hasHistory: false, historyEntries: 0, historyTasks: 0,
      };
    }
    const f = fams[key];
    f.n += 1;
    if (Array.isArray(r.task.localVotes)) {
      f.hasVotes = true;
      if (r.state !== 'blocked' && r.task.localVotes.length > 0) {
        f.votedTasks += 1;
        if (isUnanimousApprove(r.task.localVotes)) f.unanimous.push(r.id);
      }
    }
    if ('rawDiff' in r.task) {
      f.hasRawDiff = true;
      if (String(r.task.rawDiff || '').trim()) f.rawDiffWithValue += 1;
    }
    if (r.task.promptContext && typeof r.task.promptContext === 'object') {
      f.hasPromptContext = true;
      if (r.task.promptContext.priorVerdict) f.priorVerdictCount += 1;
    }
    if (Array.isArray(r.task.history)) {
      f.hasHistory = true;
      f.historyTasks += 1;
      f.historyEntries += r.task.history.length;
    }
  }
  return fams;
}

// Builds the printed cells for one family. proxyRate is numeric only when measurable.
function metricsFor(f, blockedIds) {
  const m = {};
  m.unanimous = f.hasVotes ? `${f.unanimous.length}/${f.votedTasks} (${pct(f.unanimous.length, f.votedTasks)})` : 'not measurable';
  if (!f.hasVotes) {
    m.proxy = 'not measurable';
  } else if (f.unanimous.length === 0) {
    m.proxy = 'n/a (0 unanimous)';
  } else {
    const hits = f.unanimous.filter((id) => blockedIds.has(id)).length;
    m.proxyHits = hits;
    m.proxyDenom = f.unanimous.length;
    m.proxyRate = hits / f.unanimous.length;
    m.proxy = `${hits}/${f.unanimous.length} (${pct(hits, f.unanimous.length)})`;
  }
  m.rawDiff = f.hasRawDiff ? `${f.rawDiffWithValue}/${f.n} (${pct(f.rawDiffWithValue, f.n)})` : 'not measurable';
  m.priorVerdict = f.hasPromptContext ? `${f.priorVerdictCount}/${f.n} (${pct(f.priorVerdictCount, f.n)})` : 'not measurable';
  m.history = f.hasHistory ? (f.historyEntries / f.historyTasks).toFixed(1) : 'not measurable';
  return m;
}

function fmtCounts(obj) {
  const parts = Object.entries(obj).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(', ') : 'none';
}

// queue/branch-verdicts.json: { <branch>: { <headSha>: { verdict, reasons, source, verifiedAt } } }
function summarizeBranchVerdicts(pipelineDir, cutoffMs) {
  const store = readJson(path.join(pipelineDir, 'queue', 'branch-verdicts.json'));
  if (!store || typeof store !== 'object') return ['owner branch verdicts: queue/branch-verdicts.json missing or unreadable'];
  const byVerdict = {};
  const bySource = {};
  let total = 0;
  for (const branch of Object.keys(store)) {
    const bySha = store[branch];
    if (!bySha || typeof bySha !== 'object') continue;
    for (const sha of Object.keys(bySha)) {
      const e = bySha[sha];
      if (!e || typeof e !== 'object') continue;
      const at = Date.parse(e.verifiedAt);
      if (!Number.isNaN(at) && at < cutoffMs) continue;
      total += 1;
      const v = String(e.verdict || 'unknown');
      const s = String(e.source || 'unknown');
      byVerdict[v] = (byVerdict[v] || 0) + 1;
      bySource[s] = (bySource[s] || 0) + 1;
    }
  }
  return [
    `owner branch verdicts in window: ${total} (verdict: ${fmtCounts(byVerdict)}; source: ${fmtCounts(bySource)})`,
    'owner branch verdicts are keyed by branch, not by task family: per-family verdict metrics are not measurable',
  ];
}

function main() {
  const pipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR;
  if (!pipelineDir || !pipelineDir.trim()) {
    fail('AGENT_MANAGER_PIPELINE_DIR is not set; point it at the pipeline directory and rerun.');
  }
  const days = parseDays(process.argv.slice(2));
  const cutoffMs = Date.now() - days * DAY_MS;
  const { records, scanned } = loadRecords(pipelineDir, cutoffMs);
  const blockedIds = new Set(records.filter((r) => r.state === 'blocked').map((r) => r.id));
  const fams = aggregate(records);

  const out = [];
  out.push(`review quality report -- pipeline: ${pipelineDir} -- window: last ${days} day(s), since ${new Date(cutoffMs).toISOString()}`);
  out.push(`records scanned: done ${scanned.done}, blocked ${scanned.blocked}, approved ${scanned.approved}`);
  out.push('family key = task.source (no task-level family field found); "not measurable" = input field absent from every record of that family');
  out.push('');

  const rows = Object.keys(fams).map((name) => ({ name, f: fams[name], m: metricsFor(fams[name], blockedIds) }));
  rows.sort((a, b) => (b.f.n - a.f.n) || a.name.localeCompare(b.name));
  const header = ['family', 'n', 'note', 'unanimous-approve', 'false-approve proxy', 'rawDiff present', 'priorVerdict', 'avg history'];
  const table = [header, ...rows.map((r) => [
    r.name, String(r.f.n), r.f.n < MIN_N ? 'low n' : '',
    r.m.unanimous, r.m.proxy, r.m.rawDiff, r.m.priorVerdict, r.m.history,
  ])];
  if (rows.length === 0) {
    out.push('no records in the window.');
  } else {
    const widths = header.map((_, i) => Math.max(...table.map((row) => row[i].length)));
    for (const row of table) out.push(row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
  }
  out.push('');

  const ranked = rows.filter((r) => r.m.proxyRate !== undefined)
    .sort((a, b) => (b.m.proxyRate - a.m.proxyRate) || (b.f.n - a.f.n) || a.name.localeCompare(b.name))
    .slice(0, 3);
  out.push('top families by false-approve proxy (share of unanimous-approve tasks later found in blocked):');
  if (ranked.length === 0) {
    out.push('  none: no family has a measurable false-approve proxy');
  } else {
    ranked.forEach((r, i) => {
      out.push(`  ${i + 1}. ${r.name} -- ${r.m.proxyHits}/${r.m.proxyDenom} unanimous approvals later blocked (${pct(r.m.proxyHits, r.m.proxyDenom)}) -- n=${r.f.n}${r.f.n < MIN_N ? ' low n' : ''}`);
    });
    if (ranked.length < 3) out.push(`  (only ${ranked.length} famil${ranked.length === 1 ? 'y has' : 'ies have'} a measurable proxy)`);
  }
  out.push('');
  out.push(...summarizeBranchVerdicts(pipelineDir, cutoffMs));
  out.push('per-round rawDiff: not measurable (rawDiff is a single task-level value on the records read)');
  process.stdout.write(`${out.join('\n')}\n`);
}

if (require.main === module) main();
