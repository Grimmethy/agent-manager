#!/usr/bin/env node
'use strict';

// Mutation-check runner: node scripts/mutate.js <spec.json>
//
// Spec: { "test": "<command>", "cwd"?: "<dir>", "timeoutMs"?: N,
//         "mutations": [ { "name", "file", "find", "replace" } ] }
//
// Each mutation's `find` must occur EXACTLY once (overlapping matches counted),
// otherwise it is reported `inapplicable` and nothing is written or run.
// Original bytes are restored in a finally block, and sha256 hashes of all
// target files are compared before/after the run; any mismatch fails loudly.
//
// Output: summary JSON on stdout, one summary line on stderr.
// Exit codes: 0 done (survivors do not change the exit code), 1 baseline red or
// integrity failure, 2 usage/spec error.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 300000;

class SpecError extends Error {}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Count occurrences of `find` in `text`, including overlapping ones.
function countOccurrences(text, find) {
  let count = 0;
  let first = -1;
  let idx = text.indexOf(find);
  while (idx !== -1) {
    if (count === 0) first = idx;
    count++;
    idx = text.indexOf(find, idx + 1);
  }
  return { count, first };
}

function isWithin(resolvedFile, resolvedCwd) {
  return resolvedFile === resolvedCwd || resolvedFile.startsWith(resolvedCwd + path.sep);
}

function parseCommand(cmd) {
  const parts = [];
  let current = '';
  let quote = null;
  let has = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (current || has) parts.push(current);
      current = '';
      has = false;
    } else {
      current += ch;
    }
  }
  if (current || has) parts.push(current);
  return parts;
}

function defaultRunTest(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const parts = parseCommand(command);
    let child;
    try {
      child = spawn(parts[0], parts.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (e) {
      resolve({ code: 127, timedOut: false, error: e.message });
      return;
    }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('close', (code) => done({ code, timedOut: false }));
    child.on('error', (err) => done({ code: 127, timedOut: false, error: err.message }));
  });
}

function validateSpec(spec, specDir) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new SpecError('spec must be a JSON object');
  }
  if (typeof spec.test !== 'string' || !spec.test.trim()) {
    throw new SpecError('spec.test must be a non-empty string');
  }
  if (spec.cwd !== undefined && typeof spec.cwd !== 'string') {
    throw new SpecError('spec.cwd must be a string');
  }
  if (spec.timeoutMs !== undefined && (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0)) {
    throw new SpecError('spec.timeoutMs must be a positive integer');
  }
  if (!Array.isArray(spec.mutations) || spec.mutations.length === 0) {
    throw new SpecError('spec.mutations must be a non-empty array');
  }
  const cwd = spec.cwd ? path.resolve(specDir, spec.cwd) : specDir;
  const seen = new Set();
  spec.mutations.forEach((m, i) => {
    const label = `spec.mutations[${i}]`;
    if (!m || typeof m !== 'object') throw new SpecError(`${label} must be an object`);
    for (const key of ['name', 'file', 'find', 'replace']) {
      if (typeof m[key] !== 'string') throw new SpecError(`${label}.${key} must be a string`);
    }
    if (!m.name) throw new SpecError(`${label}.name must be non-empty`);
    if (!m.file) throw new SpecError(`${label}.file must be non-empty`);
    if (!m.find) throw new SpecError(`${label}.find must be non-empty`);
    if (seen.has(m.name)) throw new SpecError(`${label}.name "${m.name}" is duplicated`);
    seen.add(m.name);
    if (!isWithin(path.resolve(cwd, m.file), cwd)) {
      throw new SpecError(`${label}.file "${m.file}" escapes cwd`);
    }
  });
  return cwd;
}

async function main(specPath, deps) {
  const d = Object.assign({
    fs,
    runTest: defaultRunTest,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  }, deps || {});

  let spec;
  let cwd;
  try {
    if (!specPath || typeof specPath !== 'string') throw new SpecError('usage: node scripts/mutate.js <spec.json>');
    const resolvedSpec = path.resolve(specPath);
    let raw;
    try {
      raw = d.fs.readFileSync(resolvedSpec, 'utf8');
    } catch (e) {
      throw new SpecError(`cannot read spec ${resolvedSpec}: ${e.message}`);
    }
    try {
      spec = JSON.parse(raw);
    } catch (e) {
      throw new SpecError(`spec is not valid JSON: ${e.message}`);
    }
    cwd = validateSpec(spec, path.dirname(resolvedSpec));
  } catch (e) {
    d.stderr(`mutate: error: ${e.message}\n`);
    return { exitCode: 2, summary: null };
  }

  const timeoutMs = spec.timeoutMs || DEFAULT_TIMEOUT_MS;
  const files = [...new Set(spec.mutations.map((m) => path.resolve(cwd, m.file)))];
  const originals = new Map();
  const hashesBefore = {};
  try {
    for (const f of files) {
      const buf = d.fs.readFileSync(f);
      originals.set(f, buf);
      hashesBefore[f] = sha256(buf);
    }
  } catch (e) {
    d.stderr(`mutate: error: cannot read target file: ${e.message}\n`);
    return { exitCode: 2, summary: null };
  }

  const results = [];
  const counts = { killed: 0, survived: 0, inapplicable: 0 };
  let baseline = null;
  let fatal = null;

  try {
    baseline = await d.runTest(spec.test, cwd, timeoutMs);
    if (baseline.code !== 0) {
      fatal = `baseline test failed (code=${baseline.code}, timedOut=${!!baseline.timedOut})`;
    } else {
      for (const m of spec.mutations) {
        const file = path.resolve(cwd, m.file);
        const original = originals.get(file);
        const text = original.toString('utf8');
        const { count, first } = countOccurrences(text, m.find);
        if (count !== 1) {
          counts.inapplicable++;
          results.push({ name: m.name, file: m.file, status: 'inapplicable', occurrences: count });
          continue;
        }
        const mutated = text.slice(0, first) + m.replace + text.slice(first + m.find.length);
        let status;
        let restoreError = null;
        try {
          d.fs.writeFileSync(file, mutated, 'utf8');
          const r = await d.runTest(spec.test, cwd, timeoutMs);
          status = r.code === 0 ? 'survived' : 'killed';
        } finally {
          try {
            d.fs.writeFileSync(file, original);
          } catch (e) {
            restoreError = e;
          }
        }
        if (restoreError) {
          throw new Error(`failed to restore ${file}: ${restoreError.message}`);
        }
        counts[status]++;
        results.push({ name: m.name, file: m.file, status, occurrences: 1 });
      }
    }
  } catch (e) {
    fatal = e.message;
  } finally {
    // Best-effort restore of every target, then integrity check.
    for (const [f, buf] of originals) {
      try {
        const cur = d.fs.readFileSync(f);
        if (Buffer.compare(cur, buf) !== 0) d.fs.writeFileSync(f, buf);
      } catch (_) { /* surfaced by the hash check below */ }
    }
  }

  const hashesAfter = {};
  const mismatches = [];
  for (const f of files) {
    let h;
    try { h = sha256(d.fs.readFileSync(f)); } catch (e) { h = `unreadable: ${e.message}`; }
    hashesAfter[f] = h;
    if (h !== hashesBefore[f]) mismatches.push(`${f} before=${hashesBefore[f]} after=${h}`);
  }
  if (mismatches.length) {
    fatal = `hash mismatch after run: ${mismatches.join('; ')}`;
  }

  const summary = {
    baseline: baseline ? { code: baseline.code, timedOut: !!baseline.timedOut } : null,
    results,
    counts,
    hashes: { before: hashesBefore, after: hashesAfter },
    error: fatal,
  };
  d.stdout(`${JSON.stringify(summary)}\n`);
  if (fatal) {
    d.stderr(`mutate: FAILED: ${fatal}\n`);
    return { exitCode: 1, summary };
  }
  d.stderr(`mutate: ${spec.mutations.length} mutations: ${counts.killed} killed, ${counts.survived} survived, ${counts.inapplicable} inapplicable\n`);
  return { exitCode: 0, summary };
}

module.exports = { main, countOccurrences, validateSpec, sha256 };

if (require.main === module) {
  main(process.argv[2]).then(
    (r) => { process.exitCode = r.exitCode; },
    (e) => {
      process.stderr.write(`mutate: fatal: ${e.message}\n`);
      process.exitCode = 1;
    }
  );
}
