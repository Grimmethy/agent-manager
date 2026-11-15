'use strict';

// poll-calibrate.js -- scan a repository's tracked files with the poll detector and summarise the findings (ADR-0024 "triggers, not polls"). FOUNDATION ONLY, no gate calls it yet.
// Pure: the file list and the file contents are injected (listFiles, readFile), so tests use plain functions and the command line (src/poll-detector.js) passes real ones.
//
//   isSkippedPath(rel)                                       true for a path inside node_modules, .venv, venv, vendor, dist, build, graphify-out, task-logs, queue or __pycache__
//   scanFile({ rel, abs, readFile })                         -> { language, findings } | null   (null: skipped, not a scanned language, or unreadable)
//   scanRepo({ root, listFiles, readFile })                  -> { files, findings } | null      (null: listFiles said the root is missing)
//   calibrate({ projects, listFiles, readFile, sample })     -> { perLanguage, perRepo, samples, totals }
//   formatReport(report)                                     -> the report as text, ending with the provisional gate rule
//
// This piece sets NO threshold: the report prints counts and samples so a person can judge precision.

const fs = require('fs');
const path = require('path');
const detector = require('./poll-detector.js');

const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', 'vendor', 'dist', 'build', 'graphify-out', 'task-logs', 'queue', '__pycache__']);
const DEFAULT_SAMPLE = 30;

const PROVISIONAL_RULE = 'PROVISIONAL gate rule (the author\'s default, changeable by the owner; this report sets no threshold): the future pre-merge gate stays in shadow mode ' +
  '(it logs "would block" and blocks nothing) until a labelled sample of at least 50 flagged hits shows under 10% false positives.';

function isSkippedPath(rel) {
  const segments = String(rel || '').replace(/\\/g, '/').split('/');
  return segments.slice(0, -1).some((s) => SKIP_DIRS.has(s));
}

function scanFile({ rel, abs, readFile }) {
  if (isSkippedPath(rel)) return null;
  let language = detector.languageOf(rel);
  const base = String(rel).split('/').pop();
  if (!language && base.includes('.')) return null;           // a known non-code extension (.md, .json, .png ...): never read
  const text = readFile(abs);
  if (text == null) return null;
  if (!language) language = detector.shebangLanguage(String(text).split('\n', 1)[0]);   // extensionless: the first line decides
  if (!language) return null;
  return { language, findings: detector.scanText({ language, path: rel, text }) };
}

function scanRepo({ root, listFiles, readFile }) {
  let list;
  try { list = listFiles(root); } catch (e) { list = null; }
  if (!Array.isArray(list)) return null;
  const findings = [];
  let files = 0;
  for (const rel of list) {
    const res = scanFile({ rel, abs: path.join(root, rel), readFile });
    if (!res) continue;
    files += 1;
    for (const f of res.findings) findings.push(f);
  }
  return { files, findings };
}

const compareFindings = (a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0) || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// Every k-th finding of the sorted list, up to `sample`: deterministic, and spread over the whole list instead of the first few.
function pickSample(list, sample) {
  const sorted = [...list].sort(compareFindings);
  const step = Math.max(1, Math.floor(sorted.length / sample));
  const out = [];
  for (let i = 0; i < sorted.length && out.length < sample; i += step) out.push(sorted[i]);
  return out;
}

// The real path of a root when it exists (so /media/wok/model-cache/x and /media/model-cache/github/x that are the same directory compare equal); otherwise the path as given.
function realRoot(root) {
  try { return fs.realpathSync(root); } catch (e) { return path.resolve(String(root || '')); }
}

function calibrate({ projects, listFiles, readFile, sample = DEFAULT_SAMPLE, onProgress } = {}) {
  const perLanguage = {};
  const perRepo = {};
  const byLanguage = {};
  const totals = { repos: 0, files: 0, skippedRepos: [], duplicateRepos: [] };
  const list = Array.isArray(projects) ? projects : [];
  const scannedRoots = new Set();
  list.forEach((project, index) => {
    const label = project.label || path.basename(String(project.repoRoot || ''));
    if (onProgress) onProgress(label, index, list.length);
    const root = realRoot(project.repoRoot);
    if (scannedRoots.has(root)) { totals.duplicateRepos.push(label); return; }     // the same checkout listed twice (two path spellings) must not be counted twice
    scannedRoots.add(root);
    const scanned = scanRepo({ root: project.repoRoot, listFiles, readFile });
    if (!scanned) { totals.skippedRepos.push(label); return; }
    totals.repos += 1;
    totals.files += scanned.files;
    const repoKey = perRepo[label] ? `${label} (${project.repoRoot})` : label;      // two different checkouts with one label stay apart
    perRepo[repoKey] = { poll: 0, info: 0 };
    for (const f of scanned.findings) {
      const lang = (perLanguage[f.language] = perLanguage[f.language] || { poll: 0, info: 0, annotated: 0, byKind: {} });
      lang[f.severity === 'info' ? 'info' : 'poll'] += 1;
      if (f.annotated) lang.annotated += 1;
      lang.byKind[f.kind] = (lang.byKind[f.kind] || 0) + 1;
      perRepo[repoKey][f.severity === 'info' ? 'info' : 'poll'] += 1;
      (byLanguage[f.language] = byLanguage[f.language] || []).push({ repo: repoKey, path: f.path, line: f.line, kind: f.kind, severity: f.severity, snippet: f.snippet, signature: f.signature });
    }
  });
  const samples = {};
  for (const [language, found] of Object.entries(byLanguage)) {
    samples[language] = pickSample(found, sample).map(({ signature, ...rest }) => rest);
  }
  return { perLanguage, perRepo, samples, totals };
}

function formatReport(report) {
  const lines = [];
  const t = report.totals || { repos: 0, files: 0, skippedRepos: [], duplicateRepos: [] };
  const notes = [];
  if (t.skippedRepos.length) notes.push(`skipped (root missing): ${t.skippedRepos.join(', ')}`);
  if ((t.duplicateRepos || []).length) notes.push(`skipped (same checkout listed twice): ${t.duplicateRepos.join(', ')}`);
  lines.push(`Poll detector calibration: ${t.repos} repo(s), ${t.files} file(s) scanned${notes.length ? `; ${notes.join('; ')}` : ''}`);
  lines.push('', 'Findings per language (poll = idle polls, info = listed only, annotated = carrying poll-ok:)');
  for (const [language, c] of Object.entries(report.perLanguage).sort()) {
    const kinds = Object.entries(c.byKind).sort().map(([k, n]) => `${k} ${n}`).join(', ');
    lines.push(`  ${language.padEnd(8)} poll ${String(c.poll).padStart(5)}  info ${String(c.info).padStart(5)}  annotated ${String(c.annotated).padStart(4)}   ${kinds}`);
  }
  lines.push('', 'Findings per repo');
  for (const [label, c] of Object.entries(report.perRepo).sort()) lines.push(`  ${label.padEnd(36)} poll ${String(c.poll).padStart(5)}  info ${String(c.info).padStart(5)}`);
  for (const [language, list] of Object.entries(report.samples).sort()) {
    lines.push('', `Sample for ${language} (${list.length} of ${report.perLanguage[language].poll + report.perLanguage[language].info}), judge each: is this really an idle poll?`);
    for (const s of list) lines.push(`  ${s.repo} ${s.path}:${s.line} [${s.kind}/${s.severity}]  ${s.snippet}`);
  }
  lines.push('', PROVISIONAL_RULE);
  return lines.join('\n') + '\n';
}

module.exports = { isSkippedPath, scanFile, scanRepo, calibrate, formatReport, pickSample, PROVISIONAL_RULE, SKIP_DIRS, DEFAULT_SAMPLE };
