'use strict';

// poll-detector.js (command line) -- scan a repository or a diff for polls, keep a baseline of known ones, and print a calibration report (ADR-0024 "triggers, not polls";
// operator doc: docs/agents/poll-detector.md). FOUNDATION ONLY: nothing calls this yet; a later hub wires the pre-merge gate, the prompts and the scout lane.
//
//   node src/poll-detector.js scan --root <dir> [--baseline <file>] [--json]
//   node src/poll-detector.js scan --diff <file> [--baseline <file>] [--fail-on-new]
//   node src/poll-detector.js baseline --root <dir> --out <file> [--repo <name>]
//   node src/poll-detector.js calibrate [--projects <projects.json>] [--sample 30] [--repos a,b] [--out <file>] [--json]
//
// Exit codes: 0 ok, 1 an unexpected error (or --fail-on-new found a NEW poll), 2 a usage error.
// Baseline file: { version: 1, repo, findings: [ { signature, path, kind, language } ] } of the un-annotated findings, sorted by path, kind, signature (byte-stable).
// A finding is KNOWN when its signature is in the baseline; the signature has no line number, so a line move does not make a known finding new.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const detector = require('./lib/poll-detector.js');
const calibrateLib = require('./lib/poll-calibrate.js');

const USAGE = [
  'usage: poll-detector.js scan --root <dir> [--baseline <file>] [--json]',
  '       poll-detector.js scan --diff <file> [--baseline <file>] [--fail-on-new]',
  '       poll-detector.js baseline --root <dir> --out <file> [--repo <name>]',
  '       poll-detector.js calibrate [--projects <projects.json>] [--sample 30] [--repos a,b] [--out <file>] [--json]',
].join('\n');

const VALUE_OPTIONS = new Set(['root', 'diff', 'baseline', 'out', 'repo', 'projects', 'sample', 'repos']);
const FLAG_OPTIONS = new Set(['json', 'fail-on-new']);
const MAX_FILE_BYTES = 1024 * 1024;

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opt = {};
  for (let i = 0; i < rest.length; i += 1) {
    const m = /^--([\w-]+)$/.exec(rest[i]);
    if (!m) throw new UsageError(`unexpected argument: ${rest[i]}`);
    const name = m[1];
    if (FLAG_OPTIONS.has(name)) opt[name] = true;
    else if (VALUE_OPTIONS.has(name)) {
      if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) throw new UsageError(`--${name} needs a value`);
      opt[name] = rest[i + 1];
      i += 1;
    } else throw new UsageError(`unknown option: --${name}`);
  }
  return { command, opt };
}

// Real file access for the command line. listFiles: tracked files via git (it throws for a missing directory or a non-git one; scanRepo turns that into "root unusable"); readFile: text, or null for a big, binary or unreadable file.
function realListFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  return out.split('\0').filter(Boolean);
}
function realReadFile(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    const text = fs.readFileSync(file, 'utf8');
    return text.includes('\u0000') ? null : text;
  } catch (e) { return null; }
}

function scanRoot(root) {
  const res = calibrateLib.scanRepo({ root, listFiles: realListFiles, readFile: realReadFile });
  if (!res) throw new UsageError(`cannot list tracked files in --root ${root} (not a directory or not a git repository)`);
  return res.findings;
}

function loadBaseline(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new UsageError(`cannot read baseline ${file}: ${e.message}`); }
  if (!data || data.version !== 1 || !Array.isArray(data.findings)) throw new UsageError(`baseline ${file} is not a version 1 baseline`);
  return new Set(data.findings.map((f) => f.signature));
}

const byPathKindSignature = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);

function buildBaseline(findings, repo) {
  const entries = findings.filter((f) => !f.annotated).map((f) => ({ signature: f.signature, path: f.path, kind: f.kind, language: f.language })).sort(byPathKindSignature);
  const seen = new Set();
  const unique = entries.filter((e) => { const key = `${e.path}\u0000${e.kind}\u0000${e.signature}`; if (seen.has(key)) return false; seen.add(key); return true; });
  return JSON.stringify({ version: 1, repo, findings: unique }, null, 2) + '\n';
}

function classify(findings, known) {
  const out = { new: [], known: [], annotated: [] };
  for (const f of findings) {
    if (f.annotated) out.annotated.push(f);
    else if (known && known.has(f.signature)) out.known.push(f);
    else out.new.push(f);
  }
  return out;
}

const line = (f, tag) => `${f.path}:${f.line}  ${f.kind}  [${f.severity}${tag ? `, ${tag}` : ''}]  ${f.snippet}`;

function main(argv, io = { stdout: process.stdout, stderr: process.stderr }, config = {}) {   // config.defaultProjects: tests point the --projects default somewhere safe
  const say = (text) => io.stdout.write(text);
  const err = (text) => io.stderr.write(text);
  let parsed;
  try {
    parsed = parseArgs(argv);
    const { command, opt } = parsed;
    if (!['scan', 'baseline', 'calibrate'].includes(command)) throw new UsageError(command ? `unknown command: ${command}` : 'a command is required');

    if (command === 'scan') {
      if (!!opt.root === !!opt.diff) throw new UsageError('scan needs exactly one of --root and --diff');
      if (opt['fail-on-new'] && !opt.diff) throw new UsageError('--fail-on-new belongs to scan --diff');
      const known = opt.baseline ? loadBaseline(opt.baseline) : null;
      if (opt.diff) {
        let diff;
        try { diff = fs.readFileSync(opt.diff, 'utf8'); } catch (e) { throw new UsageError(`cannot read diff ${opt.diff}: ${e.message}`); }
        const found = classify(detector.scanDiff(diff), known);
        say(JSON.stringify(found, null, 2) + '\n');
        return opt['fail-on-new'] && found.new.some((f) => f.severity === 'poll') ? 1 : 0;
      }
      const findings = scanRoot(opt.root);
      const decorated = findings.map((f) => ({ ...f, known: !!(known && !f.annotated && known.has(f.signature)) }));
      if (opt.json) {
        const counts = { poll: 0, info: 0, annotated: 0, known: 0 };
        for (const f of decorated) { counts[f.severity === 'info' ? 'info' : 'poll'] += 1; if (f.annotated) counts.annotated += 1; if (f.known) counts.known += 1; }
        say(JSON.stringify({ root: opt.root, counts, findings: decorated }, null, 2) + '\n');
      } else {
        for (const f of decorated) say(line(f, f.annotated ? 'annotated' : f.known ? 'known' : '') + '\n');
        say(`${decorated.length} finding(s)\n`);
      }
      return 0;
    }

    if (command === 'baseline') {
      if (!opt.root || !opt.out) throw new UsageError('baseline needs --root and --out');
      const text = buildBaseline(scanRoot(opt.root), opt.repo || path.basename(path.resolve(opt.root)));
      fs.writeFileSync(opt.out, text);
      say(`wrote ${opt.out} (${JSON.parse(text).findings.length} known finding(s))\n`);
      return 0;
    }

    // calibrate
    if (opt.sample !== undefined && !/^\d+$/.test(opt.sample)) throw new UsageError('--sample must be a whole number, 0 or more');
    const sample = opt.sample === undefined ? calibrateLib.DEFAULT_SAMPLE : Number(opt.sample);
    const projectsFile = opt.projects || config.defaultProjects || path.join(__dirname, '..', 'projects.json');
    let projects;
    try { projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8')); } catch (e) { throw new UsageError(`cannot read projects file ${projectsFile} (pass --projects): ${e.message}`); }
    if (!Array.isArray(projects)) projects = projects && Array.isArray(projects.projects) ? projects.projects : null;
    if (!projects) throw new UsageError(`projects file ${projectsFile} holds no project list`);
    let pooled = projects.filter((p) => p && p.pool && p.repoRoot);
    if (opt.repos) {
      const wanted = new Set(opt.repos.split(',').map((s) => s.trim()).filter(Boolean));
      pooled = pooled.filter((p) => wanted.has(p.label || path.basename(p.repoRoot)));
    }
    const report = calibrateLib.calibrate({
      projects: pooled, listFiles: realListFiles, readFile: realReadFile, sample,
      onProgress: (label, i, n) => err(`[${i + 1}/${n}] ${label}\n`),
    });
    if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(report, null, 2) + '\n');
    say(opt.json ? JSON.stringify(report, null, 2) + '\n' : calibrateLib.formatReport(report));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { err(`poll-detector: ${e.message}\n${USAGE}\n`); return 2; }
    err(`poll-detector: ${e.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs, buildBaseline, classify, loadBaseline, UsageError };
