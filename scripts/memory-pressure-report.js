#!/usr/bin/env node
'use strict';

// memory-pressure-report: on demand, say where the host's memory goes. READ-ONLY: it reads /proc and the existing broker marker file and prints text.
// It never kills, signals, writes, stops or changes anything (pinned by scripts/memory-pressure-report.test.js, which makes every write and signal call throw).
// Owner direction 2026-11-10: memory pressure is "a reason to optimize, not quit or slow down" -- this finds out what the cost is before anything is cut.
//   node scripts/memory-pressure-report.js [--json]

const fs = require('fs');
const path = require('path');

const MARKER = '/dev/shm/agent-manager-mem-pressure.json';
const PIPELINE_PATTERNS = [
  ['lane scripts', /scripts\/(local-worker|review-runner|queue-watcher|apply-loop)\.sh|agent-manager\/(src|scripts)\//],
  ['ollama / llama-server', /\bollama\b|llama-server/],
  ['dashboard', /python\/dashboard|dashboard\/app\.py/],
  ['plugin servers', /plugins?[-_/]|forge|\bgpu-broker|goatmon|chat-plugin|mailroom|sparforge|questforge/i],
  ['vite / dev servers', /\bvite\b|webpack|next dev|esbuild/],
  ['browsers', /brave|chrome|chromium|firefox/i],
  ['qemu', /qemu-system/],
];

// VmRSS from the text of /proc/<pid>/status -> kB (null when absent)
function parseStatusRssKb(text) {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

// /proc/pressure/<name> -> { some: {avg10, avg60, avg300, total}, full: {...} }
function parsePressure(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^(some|full)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const kv = {};
    for (const part of m[2].split(/\s+/)) { const [k, v] = part.split('='); if (k && v !== undefined) kv[k] = Number(v); }
    out[m[1]] = kv;
  }
  return out;
}

// /proc/meminfo -> { memTotalMb, memAvailableMb, swapTotalMb, swapFreeMb, swapUsedMb }
function parseMeminfo(text) {
  const kb = (key) => { const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(String(text || '')); return m ? Number(m[1]) : null; };
  const mb = (v) => (v === null ? null : Math.round(v / 1024));
  const swapTotal = kb('SwapTotal'); const swapFree = kb('SwapFree');
  return { memTotalMb: mb(kb('MemTotal')), memAvailableMb: mb(kb('MemAvailable')), swapTotalMb: mb(swapTotal), swapFreeMb: mb(swapFree), swapUsedMb: swapTotal === null || swapFree === null ? null : mb(swapTotal - swapFree) };
}

// the marker file the broker writes: { state, reason, ... } -> { state, reason, ageSeconds } or null
function parseMarker(text, mtimeMs, nowMs) {
  try { const o = JSON.parse(text); return { state: o.state || 'unknown', reason: o.reason || '', ageSeconds: Math.round((nowMs - mtimeMs) / 1000) }; } catch { return null; }
}

function trimCmd(cmd, n = 80) { const c = String(cmd || '').replace(/\s+/g, ' ').trim(); return c.length > n ? `${c.slice(0, n - 1)}…` : c; }

function classify(cmd) {
  for (const [name, re] of PIPELINE_PATTERNS) if (re.test(cmd)) return name;
  return null;
}

// a llama-server runner command line -> the model it has resident (its --model argument), or null. Only llama-server processes count: a shell that merely
// mentions ollama in its text must not be listed as a model.
function modelOf(cmd) {
  if (!/(^|\/)llama-server(\s|$)/.test(cmd)) return null;
  const m = /--model\s+(\S+)/.exec(cmd);
  return m ? m[1] : null;
}

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

// Reads a /proc-shaped tree (procRoot, default /proc). Returns a plain object; performs no write and sends no signal.
function buildReport({ procRoot = '/proc', markerPath = MARKER, nowMs = Date.now(), top = 15 } = {}) {
  const procs = [];
  let pids = [];
  try { pids = fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n)); } catch { /* none */ }
  for (const pid of pids) {
    const rssKb = parseStatusRssKb(readText(path.join(procRoot, pid, 'status')));
    if (rssKb === null) continue;   // kernel thread or already gone
    const cmd = readText(path.join(procRoot, pid, 'cmdline')).split('\0').join(' ').trim() || (/^Name:\s+(.*)$/m.exec(readText(path.join(procRoot, pid, 'status'))) || [])[1] || '?';
    let keepAlive = null;
    if (/(^|\/)ollama(\s|$)/.test(cmd)) { const m = /(?:^|\0)OLLAMA_KEEP_ALIVE=([^\0]*)/.exec(readText(path.join(procRoot, pid, 'environ'))); keepAlive = m ? m[1] : null; }
    procs.push({ pid: Number(pid), rssMb: Math.round(rssKb / 1024), cmd, group: classify(cmd), model: modelOf(cmd), keepAlive });
  }
  procs.sort((a, b) => b.rssMb - a.rssMb);
  let marker = null;
  try { marker = parseMarker(fs.readFileSync(markerPath, 'utf8'), fs.statSync(markerPath).mtimeMs, nowMs); } catch { marker = null; }
  const groups = {};
  for (const p of procs) { const g = p.group || 'other'; groups[g] = groups[g] || { rssMb: 0, count: 0 }; groups[g].rssMb += p.rssMb; groups[g].count += 1; }
  const pipelineMb = procs.filter((p) => p.group).reduce((s, p) => s + p.rssMb, 0);
  return {
    marker,
    memory: parseMeminfo(readText(path.join(procRoot, 'meminfo'))),
    pressure: { memory: parsePressure(readText(path.join(procRoot, 'pressure', 'memory'))), io: parsePressure(readText(path.join(procRoot, 'pressure', 'io'))) },
    top: procs.slice(0, top).map((p) => ({ pid: p.pid, rssMb: p.rssMb, group: p.group || 'other', cmd: trimCmd(p.cmd) })),
    models: procs.filter((p) => p.model).map((p) => ({ pid: p.pid, rssMb: p.rssMb, model: p.model, keepAlive: p.keepAlive })),
    groups,
    totals: { listedProcessesMb: procs.reduce((s, p) => s + p.rssMb, 0), pipelineGroupsMb: pipelineMb },
  };
}

function format(r) {
  const L = [];
  L.push(`broker marker: ${r.marker ? `${r.marker.state} (${r.marker.ageSeconds}s old) ${r.marker.reason}` : 'missing or unreadable'}`);
  const m = r.memory;
  L.push(`memory: ${m.memAvailableMb} MB available of ${m.memTotalMb} MB; swap used ${m.swapUsedMb} MB of ${m.swapTotalMb} MB (free ${m.swapFreeMb} MB)`);
  const p = r.pressure;
  const st = (x) => (x && x.avg10 !== undefined ? `avg10 ${x.avg10} avg60 ${x.avg60} avg300 ${x.avg300}` : 'n/a');
  L.push(`psi memory some: ${st(p.memory.some)} | full: ${st(p.memory.full)}`);
  L.push(`psi io     some: ${st(p.io.some)} | full: ${st(p.io.full)}`);
  L.push('top processes by RSS:');
  for (const t of r.top) L.push(`  ${String(t.rssMb).padStart(6)} MB  ${t.group.padEnd(22)} ${t.pid}  ${t.cmd}`);
  L.push('resident models (llama-server / ollama runner):');
  if (!r.models.length) L.push('  none found');
  for (const x of r.models) L.push(`  ${String(x.rssMb).padStart(6)} MB  pid ${x.pid}  ${x.model}  keep_alive ${x.keepAlive === null ? 'not visible in /proc (the ollama server owns it)' : x.keepAlive}`);
  L.push('by group (RSS summed over every process):');
  for (const [g, v] of Object.entries(r.groups).sort((a, b) => b[1].rssMb - a[1].rssMb)) L.push(`  ${String(v.rssMb).padStart(6)} MB  ${g} (${v.count} processes)`);
  return L.join('\n');
}

module.exports = { parseStatusRssKb, parsePressure, parseMeminfo, parseMarker, trimCmd, classify, modelOf, buildReport, format };

if (require.main === module) {
  const r = buildReport();
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : format(r));
}
