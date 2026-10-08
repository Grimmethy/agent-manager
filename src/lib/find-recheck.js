'use strict';

// find-recheck.js -- will the FINAL edit set of a Group B draft actually apply?
//
// 2026-10-08 (TaxHarvest AC-271): the redraft's first edit used `find: "from django.conf import settings"` in a file that is not Django. The pre-critique
// find-string check (implement-critique.js checkFindStrings) flagged it, but only as an ADVISORY handed to the critic; the critic's revision replaced the
// edit set and nothing looked at the result again, review approved it (2/3) and apply blocked on "find string not found". Measured over task history,
// that class shows up at apply-failed in 8 of 1,644 TaxHarvest tasks and 4 of 6,279 agent-manager tasks.
//
// This replays the edit set IN APPLY ORDER against an in-memory copy of the files, exactly as apply-group-b.js applyOneChange would (create refuses an
// existing file, edit needs the file and a find that matches EXACTLY once in the text the earlier items left behind, delete removes), and reports every
// item that would throw. The sequential replay fixes two blind spots of the disk-only check: an edit whose find only exists after an earlier edit was
// reported as missing, and an edit on a file an earlier item CREATES was skipped altogether.
//
// Pure and synchronous; reads files only through `readFile` (default fs). Never throws: anything unparsable means "no flags".
// AGENT_MANAGER_FIND_RECHECK=block|advisory|off (default block).

const fs = require('fs');
const path = require('path');

function recheckMode(env = process.env) {
  const v = String(env.AGENT_MANAGER_FIND_RECHECK || '').trim().toLowerCase();
  return v === 'advisory' || v === 'off' ? v : 'block';
}

const EXCERPT_RADIUS = 3;
const EXCERPT_MAX_CHARS = 700;

// Lines around the best match for the find string's most distinctive line, so a redraft can copy real text. Falls back to the head of the file.
function nearestExcerpt(text, find) {
  const lines = String(text).split('\n');
  const probes = String(find).split('\n').map((l) => l.trim()).filter((l) => l.length >= 6).sort((a, b) => b.length - a.length);
  let at = -1;
  for (const p of probes) {
    at = lines.findIndex((l) => l.includes(p));
    if (at >= 0) break;
  }
  if (at < 0) {
    // No exact line: try the longest identifier-ish token of the find.
    const tokens = (String(find).match(/[A-Za-z_$][\w$]{5,}/g) || []).sort((a, b) => b.length - a.length);
    for (const t of tokens) {
      at = lines.findIndex((l) => l.includes(t));
      if (at >= 0) break;
    }
  }
  const from = at >= 0 ? Math.max(0, at - EXCERPT_RADIUS) : 0;
  const to = at >= 0 ? Math.min(lines.length, at + EXCERPT_RADIUS + 1) : Math.min(lines.length, 12);
  const body = lines.slice(from, to).map((l, i) => `${from + i + 1}| ${l}`).join('\n').slice(0, EXCERPT_MAX_CHARS);
  return { nearLine: at >= 0 ? at + 1 : null, text: body };
}

/**
 * @param {Array<object>} items  parsed Group B change set
 * @param {string} repoRoot
 * @param {{ readFile?: (abs: string) => (string|null) }} [o]
 * @returns {Array<{ type: string, index: number, file: string, detail: string, excerpt?: {nearLine: number|null, text: string} }>}
 */
function simulateEdits(items, repoRoot, o = {}) {
  return simulateEditsDetailed(items, repoRoot, o).flags;
}

/**
 * Same replay, plus the resulting file texts for a downstream check (lib/edit-set-syntax.js).
 * @returns {{ flags: Array<object>, files: Array<{ file: string, base: (string|null), text: (string|null) }> }}
 *   files: every path the set touches, in first-touch order; `base` is the text on disk before the set (null = absent), `text` the text after the
 *   whole set (null = deleted).
 */
function simulateEditsDetailed(items, repoRoot, { readFile } = {}) {
  const read = readFile || ((abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } });
  const flags = [];
  const touched = new Map(); // abs -> { file, base }
  const virt = new Map(); // abs path -> text, or null when deleted
  try {
    if (!Array.isArray(items)) items = items ? [items] : [];
    const get = (abs) => (virt.has(abs) ? virt.get(abs) : read(abs));
    items.forEach((item, index) => {
      if (!item || typeof item.file !== 'string' || !item.file) return;
      const abs = path.resolve(repoRoot, item.file);
      if (!touched.has(abs)) touched.set(abs, { file: item.file, base: read(abs) });
      if (item.mode === 'create') {
        if (get(abs) !== null && get(abs) !== undefined) flags.push({ type: 'create_exists', index, file: item.file, detail: `item ${index + 1}: ${item.file} already exists (create refuses to overwrite)` });
        virt.set(abs, String(item.content || ''));
        return;
      }
      if (item.mode === 'delete') { virt.set(abs, null); return; }
      if (item.mode !== 'edit') return;
      const text = get(abs);
      if (text === null || text === undefined) {
        flags.push({ type: 'missing_file', index, file: item.file, detail: `item ${index + 1}: ${item.file} does not exist, cannot edit` });
        return;
      }
      const find = typeof item.find === 'string' ? item.find : '';
      const count = find ? text.split(find).length - 1 : 0;
      if (count === 0) {
        flags.push({ type: 'find_not_found', index, file: item.file, detail: `item ${index + 1}: find string not found in ${item.file}`, excerpt: nearestExcerpt(text, find) });
        return;
      }
      if (count > 1) {
        flags.push({ type: 'find_ambiguous', index, file: item.file, detail: `item ${index + 1}: find string matches ${count} times in ${item.file} (must match exactly once)`, excerpt: nearestExcerpt(text, find) });
        return;
      }
      virt.set(abs, text.replace(find, () => (typeof item.replace === 'string' ? item.replace : '')));
    });
  } catch { return { flags: [], files: [] }; }
  return { flags, files: [...touched].map(([abs, t]) => ({ file: t.file, base: t.base === undefined ? null : t.base, text: virt.has(abs) ? virt.get(abs) : t.base })) };
}

// The text a revise call / redraft sees: what failed and the real nearby lines to copy from.
function feedbackFor(flags) {
  return flags.map((f) => {
    const ex = f.excerpt && f.excerpt.text
      ? ` The file ${f.excerpt.nearLine ? `near line ${f.excerpt.nearLine}` : '(head)'} actually reads:\n${f.excerpt.text}\nCopy the \`find\` text from these real lines, character for character.`
      : '';
    return `${f.detail}.${ex}`;
  }).join('\n\n');
}

const signatureOf = (flags) => flags.map((f) => `${f.type}:${f.file}:${f.index}`).sort().join('|');

module.exports = { recheckMode, simulateEdits, simulateEditsDetailed, feedbackFor, nearestExcerpt, signatureOf };
