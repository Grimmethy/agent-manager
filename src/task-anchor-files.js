'use strict';

// Anchor files for an adhoc task (2026-09-02). Root-caused live via two stuck
// needs-clarification tasks (job-list grouping, second-brain recurring source): the
// pipeline knows which file a task is about -- `promptContext.prefetchedPaths` is computed
// by brain_dump_sort's anchor-match and the dashboard path-resolve endpoint -- but NO
// prompt builder, tool client, or grounding assembler ever reads it. The only file
// grounding the drafting model gets is `harnessFiles`, a fuzzy grep driven by the local
// model's own QUERY: terms, which for an architectural task returns off-topic noise. The
// model, told to "ground your change ONLY in the file content shown above", then edits the
// wrong file (it wrote a dead stub INTO src/adhoc-harness-draft.js because that was the
// one file it was handed).
//
// This module extracts the file(s) the TASK ITSELF names -- prefetchedPaths, literal
// repo-relative paths in the rawText, backtick-quoted / pattern-adjacent filenames, ADR
// numbers -- and reads their real current content, so every adhoc tier's implement prompt
// can lead with "these are your edit targets / the patterns to mirror" instead of grep noise.

const fs = require('fs');
const path = require('path');
const { extractForbiddenPaths } = require('./adhoc-diff-sanity.js');

const DEFAULT_PREFIXES = ['', 'src/', 'python/', 'python/dashboard/', 'python/dashboard/templates/', 'scripts/', 'lib/', 'docs/', 'docs/adr/'];
const MAX_FILES = 6;
const MAX_CHARS_PER_FILE = 16000;

// A bare "staleness-audit.js" -> its real repo path, IF exactly one exists across the
// common prefixes (ambiguous / missing -> null, never a guess).
function resolveBareFilename(repoRoot, name) {
  const found = [];
  for (const pre of DEFAULT_PREFIXES) {
    const rel = pre + name;
    try {
      if (fs.statSync(path.join(repoRoot, rel)).isFile()) found.push(rel);
    } catch { /* not here */ }
  }
  return found.length === 1 ? found[0] : null;
}

// docs/adr/NNNN references ("mirroring 0018's project_search precedent") -> the real file.
function resolveAdrNumber(repoRoot, num) {
  const dir = path.join(repoRoot, 'docs', 'adr');
  const padded = String(num).padStart(4, '0');
  try {
    const hit = fs.readdirSync(dir).find((f) => f.startsWith(`${padded}-`) || f.startsWith(`${padded}.`));
    return hit ? `docs/adr/${hit}` : null;
  } catch { return null; }
}

function withinRoot(repoRoot, rel) {
  const full = path.resolve(repoRoot, rel);
  return full.startsWith(path.resolve(repoRoot) + path.sep) ? full : null;
}

// Distinctive identifiers the task names -- backtick-quoted tokens, snake_case /
// camelCase / SCREAMING names, `foo()` calls. Used to WINDOW an oversized anchor file
// around the part the task actually points at instead of head-truncating it.
function taskIdentifiers(rawText) {
  const out = new Set();
  for (const m of rawText.matchAll(/`([A-Za-z_][\w.]*(?:\(\))?)`/g)) out.add(m[1].replace(/\(\)$/, ''));
  for (const m of rawText.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})\b/g)) out.add(m[1]); // snake_case
  for (const m of rawText.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]+)\b/g)) out.add(m[1]);          // camelCase
  for (const m of rawText.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,})\b/g)) out.add(m[1]); // SCREAMING_SNAKE
  return [...out].filter((s) => s.length >= 5);
}

function windowedContent(content, maxChars, idents) {
  if (content.length <= maxChars) return content;
  const half = Math.floor(maxChars / 2);
  // First occurrence of each ident that is DISTINCTIVE in this file (appears <= 4 times --
  // a token used dozens of times like `localStorage` is noise, not a location signal).
  const marks = [];
  for (const id of idents) {
    let n = 0; let first = -1; let idx = content.indexOf(id);
    while (idx !== -1 && n < 5) { if (first === -1) first = idx; n += 1; idx = content.indexOf(id, idx + id.length); }
    if (first !== -1 && n <= 4) marks.push(first);
  }
  if (marks.length === 0) return `${content.slice(0, maxChars)}\n...[truncated -- ${content.length} chars total, head shown]`;
  // Center the window where the most distinctive marks cluster.
  let bestFrom = 0; let bestHits = -1;
  for (const m of marks) {
    const from = Math.max(0, Math.min(m - half, content.length - maxChars));
    const to = from + maxChars;
    const hits = marks.filter((x) => x >= from && x < to).length;
    if (hits > bestHits) { bestHits = hits; bestFrom = from; }
  }
  const to = Math.min(content.length, bestFrom + maxChars);
  const head = bestFrom > 0 ? `...[${bestFrom} chars before this window]\n` : '';
  const tail = to < content.length ? `\n...[${content.length - to} chars after this window]` : '';
  return `${head}${content.slice(bestFrom, to)}${tail}`;
}

// task, repoRoot -> [{ path, content }] (bounded). Files a "do NOT touch" clause names
// are excluded -- handing the model a forbidden file as an edit target is exactly the
// failure adhoc-diff-sanity.js's forbidden-path check catches after the fact.
function taskAnchorFiles(task, repoRoot, { maxFiles = MAX_FILES, maxCharsPerFile = MAX_CHARS_PER_FILE } = {}) {
  if (!repoRoot || !task) return [];
  if (task.source !== 'manual' && task.domain !== 'adhoc') return []; // adhoc tasks only
  const pc = task.promptContext || {};
  const rawText = String(pc.rawText || '');
  if (!rawText && !(Array.isArray(pc.prefetchedPaths) && pc.prefetchedPaths.length)) return [];

  const forbidden = extractForbiddenPaths(`${rawText}\n${task && task.planResponse ? task.planResponse : ''}`);
  const isForbidden = (rel) => forbidden.some((f) => {
    const cp = rel.replace(/^\.\//, '');
    if (f.endsWith('/')) return cp === f.slice(0, -1) || cp.startsWith(f);
    if (cp === f) return true;
    if (f.includes('/') && !/\.\w+$/.test(f)) return cp === f || cp.startsWith(`${f}.`);
    if (!f.includes('/')) { const b = cp.split('/').pop(); return b === f || b.startsWith(`${f}.`); }
    return false;
  });

  const ordered = []; // preserve discovery order: prefetched first, then task-text order
  const seen = new Set();
  const add = (rel) => {
    if (!rel) return;
    const norm = String(rel).replace(/^\.\//, '').replace(/[`'".,;:)]+$/, '');
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    ordered.push(norm);
  };

  // 1. the pipeline's own computed answer
  for (const p of (Array.isArray(pc.prefetchedPaths) ? pc.prefetchedPaths : [])) add(p);

  // 2. literal repo-relative paths written in the task
  for (const m of rawText.matchAll(/\b(?:src|python|scripts|lib|test|tests|docs)(?:\/[\w.@-]+)+\.\w{1,5}\b/g)) add(m[0]);

  // 3. backtick-quoted filenames, and bare filenames next to a "mirror/pattern/precedent/
  //    existing/consumer/gap for" cue (the human pointing at code to imitate).
  for (const m of rawText.matchAll(/`([\w@-]+\.(?:js|jsx|ts|tsx|py|sh|md|html|css))`/g)) add(resolveBareFilename(repoRoot, m[1]));
  const CUE = /(?:mirror(?:ing)?|pattern|precedent|existing|like|same (?:as|style)|consumer|gap for|reuse|per|see)\s+[^.\n]{0,60}?\b([\w@-]+\.(?:js|py|sh))\b|\b([\w@-]+\.(?:js|py|sh))\b[^.\n]{0,45}?(?:pattern|precedent|already (?:exists|left|has)|consumer)/gi;
  for (const m of rawText.matchAll(CUE)) add(resolveBareFilename(repoRoot, m[1] || m[2]));

  // 4. ADR references -- a 2-4 digit number with an ADR cue ("precedent", "ADR",
  //    "mirroring 0018's ...") within ~45 chars on either side.
  for (const m of rawText.matchAll(/\b(?:ADR[- ]?)?0*(\d{2,4})['’]?s?\b/gi)) {
    const at = m.index;
    const around = rawText.slice(Math.max(0, at - 45), at + m[0].length + 45);
    if (/\b(?:ADR|adr|precedent|mirror\w*)\b/.test(around)) add(resolveAdrNumber(repoRoot, m[1]));
  }

  const idents = taskIdentifiers(rawText);
  const out = [];
  for (const rel of ordered) {
    if (out.length >= maxFiles) break;
    if (isForbidden(rel)) continue;
    const full = withinRoot(repoRoot, rel);
    if (!full) continue;
    let content;
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    out.push({ path: rel, content: windowedContent(content, maxCharsPerFile, idents) });
  }
  return out;
}

// The prompt block every adhoc implement tier leads with. Resolves repoRoot itself so
// callers don't have to thread it; returns '' on any failure or when nothing was found.
function anchorFilesPromptBlock(task) {
  let repoRoot;
  try { ({ repoRoot } = require('./config.js').getConfig()); } catch { return ''; }
  const files = taskAnchorFiles(task, repoRoot);
  if (files.length === 0) return '';
  return [
    'FILES THIS TASK NAMES (read from the repo just now). These are your edit target(s) and/or the pattern(s) to mirror -- this is authoritative for WHERE the change goes; any search results shown later are supplementary. Verify against the task before editing (a file may be named only as a pattern to imitate, not to change):',
    '',
    files.map((f) => `--- ${f.path} ---\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n'),
    '',
  ].join('\n');
}

module.exports = { taskAnchorFiles, anchorFilesPromptBlock, resolveBareFilename };
