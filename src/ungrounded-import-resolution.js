'use strict';
// Resolution for an "ungrounded import": a task whose cited Files: paths do not exist.
// resolveUngroundedImport is pure and stateless; gatherGroundingEvidence does the (bounded,
// synchronous, local-only) filesystem work. No timers, no model calls, no network.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  checkCitedPaths, extractFilesLine, formatFabricatedReason,
} = require('./candidate-path-grounding');

const MAX_TERMS = 8;
const MAX_EVIDENCE_FILES = 20;
const MAX_SCAN = 2000;
const SKIP_DIRS = new Set(['node_modules', '.git']);
const STOP = new Set(['the', 'and', 'for', 'src', 'with', 'that', 'this', 'from', 'files', 'file', 'add', 'into', 'task']);

function failureText(f) {
  if (!f) return '';
  if (typeof f === 'string') return f;
  return String(f.reason || f.message || f.error || '');
}

function isFabricatedRejection(f) {
  return /fabricated file path\(s\)/i.test(failureText(f));
}

function fingerprintOf(cited, evidence) {
  return crypto.createHash('sha1')
    .update(JSON.stringify({ cited: [...cited].sort(), evidence: [...evidence].sort() }))
    .digest('hex');
}

function resolveLegacy({
  citedPaths = [], existingPaths = [], evidenceFiles = [], hitCount = 0,
  priorFailure = null, priorFingerprint = null,
} = {}) {
  const cited = Array.isArray(citedPaths) ? citedPaths : [];
  const existing = new Set(Array.isArray(existingPaths) ? existingPaths : []);
  const evidence = Array.isArray(evidenceFiles) ? evidenceFiles : [];
  const hits = Number(hitCount) || 0;

  // Ordering: an existing cited path wins even with zero hits.
  if (cited.some((p) => existing.has(p))) return { action: 'proceed' };

  const fingerprint = fingerprintOf(cited, evidence);
  const mk = (action, extra) => {
    const record = {
      event: `ungrounded-import-${action}`,
      citedPaths: [...cited],
      hitCount: hits,
      evidenceCount: evidence.length,
      fingerprint,
    };
    if (extra.reason) record.reason = extra.reason;
    return { action, ...extra, fingerprint, record };
  };

  if (hits > 0 || evidence.length > 0) {
    if (isFabricatedRejection(priorFailure) && priorFingerprint && fingerprint === priorFingerprint) {
      return mk('hold-unchanged', {
        reason: 'same fabricated-path failure and same grounding evidence as the prior attempt',
      });
    }
    return mk('redraft', { evidence: [...evidence] });
  }
  return mk('archive', {
    reason: formatFabricatedReason(cited.map((claimedPath) => ({ claimedPath }))),
  });
}

function taskText(task) {
  if (!task) return '';
  if (typeof task === 'string') return task;
  const parts = [task.title, task.rawText, task.description, task.promptContext && task.promptContext.rawText];
  return parts.filter((x) => typeof x === 'string' && x).join('\n');
}

function termsFor(text, missing) {
  const words = [];
  for (const m of missing) {
    const base = path.posix.basename(String(m).replace(/\\/g, '/')).replace(/\.[^.]+$/, '');
    words.push(...base.split(/[^A-Za-z0-9]+/));
  }
  words.push(...String(text || '').split(/[^A-Za-z0-9]+/));
  const out = [];
  for (const w of words) {
    const t = w.toLowerCase();
    if (t.length < 3 || STOP.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

function searchTerms(roots, terms, existing) {
  const found = [];
  let hitCount = 0;
  let scanned = 0;
  const seen = new Set();
  for (const { abs, rel } of roots) {
    const stack = [[abs, rel]];
    while (stack.length && scanned < MAX_SCAN && found.length < MAX_EVIDENCE_FILES) {
      const [dir, relDir] = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const e of entries) {
        if (scanned >= MAX_SCAN || found.length >= MAX_EVIDENCE_FILES) break;
        if (SKIP_DIRS.has(e.name)) continue;
        const relPath = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory()) { stack.push([path.join(dir, e.name), relPath]); continue; }
        if (!e.isFile()) continue;
        scanned++;
        if (seen.has(relPath) || existing.has(relPath)) continue;
        const lower = e.name.toLowerCase();
        if (terms.some((t) => lower.includes(t))) {
          seen.add(relPath);
          found.push(relPath);
          hitCount++;
        }
      }
    }
  }
  return { evidenceFiles: found, hitCount };
}

// Assumes the task text lives in title/rawText/description/promptContext.rawText.
function gatherLegacy(task, repoRoot, extraRoots = []) {
  const empty = { existingPaths: [], missingPaths: [], evidenceFiles: [], hitCount: 0 };
  if (!repoRoot) return empty;
  const text = taskText(task);
  let checked = [];
  let fabricated = [];
  try {
    ({ checked, fabricated } = checkCitedPaths(extractFilesLine(text), repoRoot, extraRoots));
  } catch { return empty; }
  const existingPaths = checked.filter((r) => r.exists).map((r) => r.claimedPath);
  const missingPaths = fabricated.map((r) => r.claimedPath);
  if (!missingPaths.length) return { existingPaths, missingPaths, evidenceFiles: [], hitCount: 0 };

  const terms = termsFor(text, missingPaths);
  const roots = [{ abs: path.resolve(repoRoot), rel: '' }];
  for (const x of Array.isArray(extraRoots) ? extraRoots : []) {
    if (typeof x !== 'string' || !x) continue;
    roots.push({ abs: path.resolve(repoRoot, x), rel: x.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') });
  }
  const { evidenceFiles, hitCount } = terms.length
    ? searchTerms(roots, terms, new Set(existingPaths))
    : { evidenceFiles: [], hitCount: 0 };
  return { existingPaths, missingPaths, evidenceFiles, hitCount };
}

// ---- Contract API (HUB0774) layered over the legacy evidence/decision functions above. ----
// Dispatch is by argument shape so existing callers/tests keep working.
const IMPORTED_TYPES = ['arch_import', 'arch_discovery', 'deep_dive'];
const ARCHIVED_COUNTER = 'ungrounded_import_archived';

function normalizeCitedPath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim();
  while (s.startsWith('./')) s = s.slice(2);
  return s.replace(/:\d+(?::\d+)?$/, '');
}

function normalizeList(paths) {
  const out = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    const n = normalizeCitedPath(p);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.sort();
}

function fingerprintRejection(taskId, rejectedPaths) {
  return `${taskId}|${normalizeList(rejectedPaths).join(',')}`;
}

function pathExists(rel) {
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) return false;
  try { return fs.statSync(path.resolve(process.cwd(), rel)).isFile(); } catch { return false; }
}

async function gatherEvidenceContract(task, rejectedPaths) {
  const evidenceFiles = normalizeList(rejectedPaths).filter(pathExists).slice(0, MAX_EVIDENCE_FILES);
  return { evidenceFiles };
}

function gatherGroundingEvidence(task, second, extraRoots) {
  if (Array.isArray(second)) return gatherEvidenceContract(task, second);
  return gatherLegacy(task, second, extraRoots);
}

function resolveContract({ task, rejectedPaths, fingerprint, counters }) {
  const t = task || {};
  const paths = normalizeList(rejectedPaths);
  if (!IMPORTED_TYPES.includes(t.type)) return { action: 'redraft', task: t };
  if (paths.some(pathExists)) return { action: 'redraft', task: t };
  const fp = fingerprint || fingerprintRejection(t.id, paths);
  const c = counters && typeof counters === 'object' ? counters : null;
  if (!c || !(c[fp] > 0)) {
    if (c) c[fp] = 1;
    return { action: 'redraft', task: t };
  }
  const reason = formatFabricatedReason(paths.map((claimedPath) => ({ claimedPath })));
  c[ARCHIVED_COUNTER] = (c[ARCHIVED_COUNTER] || 0) + 1;
  return {
    action: 'archive',
    task: { ...t, state: 'archived', archivedReason: reason },
    reason,
    historyEvent: {
      type: 'archived-ungrounded-import', taskId: t.id, fingerprint: fp, rejectedPaths: paths, reason,
    },
  };
}

function resolveUngroundedImport(args = {}) {
  const a = args || {};
  if (!('citedPaths' in a) && ('task' in a || 'rejectedPaths' in a)) return resolveContract(a);
  return resolveLegacy(a);
}

module.exports = {
  resolveUngroundedImport, gatherGroundingEvidence, normalizeCitedPath, fingerprintRejection, IMPORTED_TYPES,
};
