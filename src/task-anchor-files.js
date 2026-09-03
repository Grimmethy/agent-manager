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

// Line-anchored windowing (2026-09-03). windowedContent() used to center an oversized
// anchor file's window on task-named identifiers that ALREADY appear in the file, and
// head-truncate when none matched. A net-new route or a blueprint-wiring task names
// symbols that don't exist in the file yet -> head cut -> the real edit site (often
// thousands of lines down) is invisible, and the local 27B burns its whole turn budget
// paging read_file to find it. When the task carries grep hits (promptContext.harnessHits)
// or literal `path:line` refs into the file, window around THOSE line numbers instead,
// mirroring get-grounding-source.js's extractContentWindow on the review side.
const WINDOW_CONTEXT_LINES = 45;        // context lines each side of a hit cluster
const WINDOW_CLUSTER_GAP_LINES = 150;   // hits closer than this merge into one region
const WINDOW_MAX_REGIONS = 3;
const WINDOW_MAX_CHARS_MULTI = 22000;   // separate cap for the line-anchored path only
const WINDOW_TAIL_CUES = /\b(?:at|to|near) the (?:bottom|end) of (?:the )?file\b|register(?:ing|s)?\b[^.\n]{0,40}\bblueprint|\bappend(?:ed|s|ing)?\b|\badd(?:ed)?\b[^.\n]{0,30}\bto the end\b/i;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

// Sorted-unique 1-based line numbers -> greedy clusters (a gap > WINDOW_CLUSTER_GAP_LINES
// starts a new one), keep the WINDOW_MAX_REGIONS densest, return them re-sorted by
// position. Each cluster is { lines: [...], from, to } in 1-based line space with
// WINDOW_CONTEXT_LINES of padding already applied (clamped to the file at render time).
function clusterHitLines(sortedLines, totalLines) {
  const clusters = [];
  for (const ln of sortedLines) {
    const last = clusters[clusters.length - 1];
    if (last && ln - last.lines[last.lines.length - 1] <= WINDOW_CLUSTER_GAP_LINES) {
      last.lines.push(ln);
    } else {
      clusters.push({ lines: [ln] });
    }
  }
  clusters.sort((a, b) => b.lines.length - a.lines.length);
  const kept = clusters.slice(0, WINDOW_MAX_REGIONS);
  kept.sort((a, b) => a.lines[0] - b.lines[0]);
  for (const c of kept) {
    c.from = Math.max(1, c.lines[0] - WINDOW_CONTEXT_LINES);
    c.to = Math.min(totalLines, c.lines[c.lines.length - 1] + WINDOW_CONTEXT_LINES);
  }
  return kept;
}

// Render one or more line-range windows of `content` with real-line-number headers.
// Trims the last region if the total would exceed capChars.
function renderLineWindows(content, clusters, capChars) {
  const lines = content.split('\n');
  const total = lines.length;
  const parts = [];
  let prevTo = 0;
  let used = 0;
  for (let i = 0; i < clusters.length; i += 1) {
    const c = clusters[i];
    const gap = c.from - 1 - prevTo;
    if (i === 0 && c.from > 1) parts.push(`...[${c.from - 1} lines before]...`);
    else if (gap > 0) parts.push(`...[${gap} lines between windows]...`);
    const header = `...[showing lines ${c.from}-${c.to}, around grep hit(s) at line(s) ${c.lines.join(', ')}]...`;
    let body = lines.slice(c.from - 1, c.to).join('\n');
    const room = capChars - used - header.length;
    if (body.length > room) {
      body = `${body.slice(0, Math.max(0, room))}\n...[window truncated -- narrow with read_file offset]`;
    }
    parts.push(`${header}\n${body}`);
    used += header.length + body.length;
    prevTo = c.to;
    if (used >= capChars) break;
  }
  if (prevTo < total) parts.push(`...[${total - prevTo} lines after]...`);
  return parts.join('\n');
}

function windowedContent(content, maxChars, { idents = [], hitLines = [], preferTail = false } = {}) {
  if (content.length <= maxChars) return content;

  // Priority 1: explicit line numbers (grep hits / `path:line` refs) into this file.
  if (hitLines.length) {
    const total = content.split('\n').length;
    return renderLineWindows(content, clusterHitLines(hitLines, total), WINDOW_MAX_CHARS_MULTI);
  }

  const half = Math.floor(maxChars / 2);
  // First occurrence of each ident that is DISTINCTIVE in this file (appears <= 4 times --
  // a token used dozens of times like `localStorage` is noise, not a location signal).
  const marks = [];
  for (const id of idents) {
    let n = 0; let first = -1; let idx = content.indexOf(id);
    while (idx !== -1 && n < 5) { if (first === -1) first = idx; n += 1; idx = content.indexOf(id, idx + id.length); }
    if (first !== -1 && n <= 4) marks.push(first);
  }
  if (marks.length === 0) {
    // Priority 4a: the task points at the END of the file ("at the bottom of", "register
    // the blueprint", "append") but names nothing that matches -- show the tail, not the head.
    if (preferTail) {
      const tail = content.slice(-maxChars);
      const totalLines = content.split('\n').length;
      return `...[head ${content.length - tail.length} chars omitted]\n...[showing the END of the file -- ${content.length} chars total, ${totalLines} lines]...\n${tail}`;
    }
    // Priority 4b: unchanged head slice.
    return `${content.slice(0, maxChars)}\n...[truncated -- ${content.length} chars total, head shown]`;
  }
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
  const preferTailGlobal = WINDOW_TAIL_CUES.test(rawText);
  const out = [];
  for (const rel of ordered) {
    if (out.length >= maxFiles) break;
    if (isForbidden(rel)) continue;
    const full = withinRoot(repoRoot, rel);
    if (!full) continue;
    let content;
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const hitLines = harnessHitLinesFor(task, rel, content);
    out.push({
      path: rel,
      content: windowedContent(content, maxCharsPerFile, {
        idents,
        hitLines,
        preferTail: preferTailGlobal && hitLines.length === 0,
      }),
      windowed: content.length > maxCharsPerFile,
      anchoredOnLines: hitLines.slice(0, 12),
    });
  }
  return out;
}

// Real line numbers pointing INTO `rel`, from two sources: promptContext.harnessHits
// (grep hits carrying { file, line }) and literal `path:line` / `basename:line` refs in
// the task text. Clamped to the file, sorted unique.
function harnessHitLinesFor(task, rel, content) {
  const pc = (task && task.promptContext) || {};
  const norm = (p) => String(p || '').replace(/^\.\//, '');
  const target = norm(rel);
  const base = target.split('/').pop();
  const out = new Set();
  for (const h of (Array.isArray(pc.harnessHits) ? pc.harnessHits : [])) {
    if (h && Number.isInteger(h.line) && norm(h.file) === target) out.add(h.line);
  }
  const rawText = String(pc.rawText || '');
  const re = new RegExp(`(?:${escapeRe(target)}|${escapeRe(base)}):(\\d+)(?:-(\\d+))?`, 'g');
  for (const m of rawText.matchAll(re)) {
    out.add(Number(m[1]));
    if (m[2]) out.add(Number(m[2]));
  }
  const lineCount = content.split('\n').length;
  return [...out].filter((n) => Number.isInteger(n) && n >= 1 && n <= lineCount).sort((a, b) => a - b);
}

// The prompt block every adhoc implement tier leads with. Resolves repoRoot itself so
// callers don't have to thread it; returns '' on any failure or when nothing was found.
function anchorFilesPromptBlock(task) {
  let repoRoot;
  try { ({ repoRoot } = require('./config.js').getConfig()); } catch { return ''; }
  const files = taskAnchorFiles(task, repoRoot);
  if (files.length === 0) return '';
  const anyWindowed = files.some((f) => f.windowed);
  const windowNote = anyWindowed
    ? ' Large files are shown as one or more WINDOWS -- each `...[showing lines X-Y ...]...` header gives REAL file line numbers you can hand straight to read_file `offset` to page outward; the window is a starting point, not the whole file. A window headed `around grep hit(s) at line(s) N` is where this repo\'s own grep placed this task\'s key symbols -- the edit almost certainly goes at or just after that region.'
    : '';
  return [
    `FILES THIS TASK NAMES (read from the repo just now). These are your edit target(s) and/or the pattern(s) to mirror -- this is authoritative for WHERE the change goes; any search results shown later are supplementary. Verify against the task before editing (a file may be named only as a pattern to imitate, not to change):${windowNote}`,
    '',
    files.map((f) => {
      const caption = f.anchoredOnLines && f.anchoredOnLines.length
        ? `--- ${f.path} (windowed around lines ${f.anchoredOnLines.join(', ')} from repo grep) ---`
        : `--- ${f.path} ---`;
      return `${caption}\n\`\`\`\n${f.content}\n\`\`\``;
    }).join('\n\n'),
    '',
  ].join('\n');
}

module.exports = { taskAnchorFiles, anchorFilesPromptBlock, resolveBareFilename };
