#!/usr/bin/env node
'use strict';

// Acceptance recorder: runs a command (or a mutation check) and appends the REAL result to
// a JSON log, then renders the log as an 'Acceptance:' block that
// src/acceptance-criteria.js's parseAcceptanceBlock can parse. Nothing is written to the
// log that was not actually observed.
//
//   run    <label> [--out path] [--timeout ms] -- <cmd...>
//   mutate <label> --file path --sed expr [--out path] -- <test cmd...>
//   render [--out path]

const fs = require('fs');
const { spawnSync } = require('child_process');

const DEFAULT_OUT = './acceptance-log.json';
const TAIL_LINES = 20;
const VALUE_FLAGS = new Set(['out', 'timeout', 'file', 'sed']);

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const sep = args.indexOf('--');
  const head = sep === -1 ? args : args.slice(0, sep);
  const cmd = sep === -1 ? [] : args.slice(sep + 1);
  const positional = [];
  const flags = {};
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) flags[name] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(name)) { flags[name] = head[i + 1]; i++; }
      else flags[name] = true;
    } else {
      positional.push(a);
    }
  }
  if (flags.out === undefined || flags.out === true) flags.out = DEFAULT_OUT;
  return { positional, flags, cmd };
}

function readLog(out) {
  let raw;
  try {
    raw = fs.readFileSync(out, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`acceptance log ${out} is not valid JSON; refusing to overwrite it`);
  }
  if (!Array.isArray(parsed)) throw new Error(`acceptance log ${out} is not a JSON array; refusing to overwrite it`);
  return parsed;
}

function appendEntry(out, entry) {
  const log = readLog(out);
  log.push(entry);
  fs.writeFileSync(out, JSON.stringify(log, null, 2) + '\n');
  return log;
}

function tailLines(text, n = TAIL_LINES) {
  const lines = String(text || '').replace(/\n+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

// Only returns counts the output really reports (node:test TAP summary lines such as
// '# tests 5'). Otherwise null -- never invents a count.
function parseCounts(text) {
  const found = { tests: null, pass: null, fail: null };
  for (const line of String(text || '').split('\n')) {
    const parts = line.trim().replace(/^#/, '').trim().split(/\s+/);
    if (parts.length === 2 && Object.prototype.hasOwnProperty.call(found, parts[0]) && /^[0-9]+$/.test(parts[1])) {
      found[parts[0]] = Number(parts[1]);
    }
  }
  if (found.tests === null || found.pass === null || found.fail === null) return null;
  return found;
}

// Apply a sed expression to a Buffer/string via stdout (never in-place). Returns a Buffer.
function applySed(content, expr) {
  const r = spawnSync('sed', ['-e', expr], { input: content, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`sed failed (exit ${r.status}): ${String(r.stderr || '').trim()}`);
  return r.stdout;
}

function describeEntry(e) {
  if (e.kind === 'mutation') return `mutation of ${e.file} via sed ${e.sed} (${e.result})`;
  return String(e.command);
}

function renderLog(entries) {
  const out = ['Acceptance:'];
  const one = (x) => String(x).split(/[\r\n]+/).join(' ');
  (entries || []).forEach((e, i) => {
    let verdict;
    if (e.kind === 'mutation') {
      verdict = e.result === 'killed' ? 'PASS' : 'FAIL';
    } else if (e.exitCode === 0 && !e.timedOut) {
      verdict = 'PASS';
    } else {
      verdict = 'FAIL';
      if (e.timedOut) verdict += ' (timed out)';
      else if (e.exitCode === null || e.exitCode === undefined) verdict += ' (no exit code)';
      else if (e.counts && typeof e.counts.fail === 'number' && e.counts.fail > 0) verdict += ` ${e.counts.fail} failures`;
    }
    out.push(`${i + 1}. ${one(e.label)} -- ${one(describeEntry(e))} -- ${verdict}`);
  });
  return out.join('\n');
}

function parseTimeout(v) {
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function cmdRun(argv) {
  const { positional, flags, cmd } = parseArgs(argv);
  const label = positional[1];
  if (!label || !cmd.length) {
    process.stderr.write('usage: record-acceptance.js run <label> [--out path] [--timeout ms] -- <cmd...>\n');
    return 2;
  }
  const start = Date.now();
  const r = spawnSync(cmd[0], cmd.slice(1), {
    encoding: 'utf8', shell: false, timeout: parseTimeout(flags.timeout), maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - start;
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  const combined = `${r.stdout || ''}${r.stderr || ''}${r.error && !timedOut ? String(r.error.message) + '\n' : ''}`;
  const exitCode = typeof r.status === 'number' ? r.status : null;
  appendEntry(flags.out, {
    label,
    command: cmd.join(' '),
    exitCode,
    durationMs,
    outputTail: tailLines(combined, TAIL_LINES),
    counts: parseCounts(combined),
    timedOut,
  });
  return exitCode === null ? 1 : exitCode;
}

function cmdMutate(argv) {
  const { positional, flags, cmd } = parseArgs(argv);
  const label = positional[1];
  if (!label || !cmd.length || typeof flags.file !== 'string' || typeof flags.sed !== 'string') {
    process.stderr.write('usage: record-acceptance.js mutate <label> --file path --sed expr [--out path] -- <test cmd...>\n');
    return 2;
  }
  const file = flags.file;
  const original = fs.readFileSync(file);
  const mutated = applySed(original, flags.sed);
  if (Buffer.compare(original, mutated) === 0) {
    process.stdout.write('NOT APPLIED: sed expression left ' + file + ' unchanged\n');
    return 1;
  }
  let result;
  try {
    fs.writeFileSync(file, mutated);
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
    result = r.status === 0 ? 'survived' : 'killed';
  } finally {
    fs.writeFileSync(file, original);
  }
  appendEntry(flags.out, { label, command: cmd.join(' '), kind: 'mutation', file, sed: flags.sed, result });
  return 0;
}

function cmdRender(argv) {
  const { flags } = parseArgs(argv);
  process.stdout.write(renderLog(readLog(flags.out)) + '\n');
  return 0;
}

function main(argv) {
  const sub = (argv || [])[0];
  try {
    if (sub === 'run') return cmdRun(argv);
    if (sub === 'mutate') return cmdMutate(argv);
    if (sub === 'render') return cmdRender(argv);
  } catch (e) {
    process.stderr.write(`record-acceptance: ${e.message}\n`);
    return 1;
  }
  process.stderr.write('usage: record-acceptance.js <run|mutate|render> ...\n');
  return 2;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { parseArgs, readLog, appendEntry, tailLines, parseCounts, applySed, renderLog, main };
