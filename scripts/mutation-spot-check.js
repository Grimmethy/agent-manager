#!/usr/bin/env node
'use strict';
// Mutation spot-check: for each added (non-comment) JS line on the branch vs
// <base>, apply one operator mutation, run the test command, and report which
// mutants survive (tests did not notice). Restores every file in a finally.
//
// Usage: node scripts/mutation-spot-check.js --repo <dir> --base <ref> --tests <cmd>
//        [--max 12] [--timeout-ms 60000]
// Exit: 0 ok (survivors allowed), 2 bad args, 3 baseline tests fail, 4 tree not restored.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OPS = [
  ['>=', '>'],
  ['<=', '<'],
  ['===', '!=='],
  ['!==', '==='],
  ['&&', '||'],
  ['||', '&&'],
  ['+', '-'],
  ['-', '+'],
];

const STR_FLAGS = new Map([['--repo', 'repo'], ['--base', 'base'], ['--tests', 'tests']]);
const INT_FLAGS = new Map([['--max', 'max'], ['--timeout-ms', 'timeoutMs']]);

function parseArgs(argv) {
  const opts = { repo: null, base: null, tests: null, max: 12, timeoutMs: 60000 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!STR_FLAGS.has(flag) && !INT_FLAGS.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (STR_FLAGS.has(flag)) {
      opts[STR_FLAGS.get(flag)] = value;
    } else {
      if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag} must be a positive integer`);
      opts[INT_FLAGS.get(flag)] = Number(value);
    }
  }
  for (const key of ['repo', 'base', 'tests']) {
    if (!opts[key]) throw new Error(`missing required --${key}`);
  }
  return opts;
}

function isSourceFile(file) {
  if (!file || !file.endsWith('.js') || file.endsWith('.test.js')) return false;
  return !file.split('/').some((seg) => seg === 'test' || seg === 'tests');
}

function isComment(text) {
  const t = text.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

// Parse `git diff --unified=0` output into added lines with new-file line numbers.
function changedLines(diffText) {
  const out = [];
  let file = null;
  let newLine = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('+')) {
      const text = line.slice(1);
      if (isSourceFile(file) && !isComment(text)) out.push({ file, line: newLine, text });
      newLine++;
    }
  }
  return out;
}

// First operator in the table that appears on the line; only its first occurrence is replaced.
function pickMutant(text) {
  for (const [from, to] of OPS) {
    if (text.includes(from)) return { from, to, op: `${from}->${to}` };
  }
  return null;
}

function run(opts, deps) {
  const timeoutMs = opts.timeoutMs || 60000;
  const max = opts.max || 12;
  const diff = deps.git(['diff', '--unified=0', `${opts.base}...HEAD`, '--', '*.js'], opts.repo);
  if (diff.status !== 0) return { exitCode: 2, message: `git diff failed against base ${opts.base}` };
  const sites = changedLines(diff.stdout || '');

  const before = deps.git(['status', '--porcelain'], opts.repo).stdout;
  const baseline = deps.run(opts.tests, opts.repo, timeoutMs);
  if (baseline.timedOut || baseline.status !== 0) return { exitCode: 3, message: 'baseline tests fail' };

  let killed = 0;
  let total = 0;
  const survivors = [];
  for (const site of sites) {
    if (total >= max) break;
    const full = path.join(opts.repo, site.file);
    const original = fs.readFileSync(full, 'utf8');
    const lines = original.split('\n');
    const idx = site.line - 1;
    const mutant = lines[idx] === undefined ? null : pickMutant(lines[idx]);
    if (!mutant) continue;
    total++;
    lines[idx] = lines[idx].replace(mutant.from, mutant.to);
    let res;
    try {
      fs.writeFileSync(full, lines.join('\n'));
      res = deps.run(opts.tests, opts.repo, timeoutMs);
    } finally {
      fs.writeFileSync(full, original);
    }
    if (res.timedOut || res.status !== 0) killed++;
    else survivors.push({ file: site.file, line: site.line, op: mutant.op });
  }

  const after = deps.git(['status', '--porcelain'], opts.repo).stdout;
  if (after !== before) return { exitCode: 4, message: 'TREE NOT RESTORED' };
  return {
    exitCode: 0,
    report: { killed, survived: survivors.length, total, survivors },
  };
}

function realDeps() {
  return {
    run(cmd, cwd, timeoutMs) {
      const r = spawnSync(cmd, { cwd, shell: true, stdio: 'ignore', timeout: timeoutMs });
      return {
        status: r.status === null ? 1 : r.status,
        timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'),
      };
    },
    git(args, cwd) {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '' };
    },
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const result = run(opts, realDeps());
  if (result.message) process.stderr.write(`${result.message}\n`);
  if (result.report) process.stdout.write(`${JSON.stringify(result.report)}\n`);
  process.exitCode = result.exitCode;
}

if (require.main === module) main();

module.exports = { run, parseArgs, changedLines, pickMutant };
