'use strict';

// file-decompose-plan-pass.js (2026-09-03, Grimmethy: "we need to figure out a way to get
// hub 1 to decompose itself ... make the system do the work without stepping in").
//
// The gap: a task whose target is a 5,000+ line file loops forever in the decompose
// backstop -- every attempt answers "decompose" but never produces usable pieces, because
// the local 27B cannot hold the whole file in its head to decide WHERE the module
// boundaries go (jsg0 / the job-list stage-groups hub, live). file-decompose-to-hub.js
// already turns a `moves[]` plan into a (stacked) hub the 27B CAN execute -- but authoring
// that plan was a human step.
//
// This pass authors it, cheapest strategy first:
//
//   A. SECTION GROUPING (no model). Big source files are already organised behind comment
//      banners -- `// --- Discovery tab ---`, `// Plugins tab -- ...`, a `@app.route`
//      URL-prefix family. Assign each symbol its nearest preceding banner, and if that
//      yields 3-8 balanced groups, emit them directly. Zero model risk.
//
//   B. MODEL GROUPS SECTIONS. If A is lopsided (one giant group, or 20 tiny ones), hand
//      the model the SECTIONS as the unit -- "merge these 18 sections into 3-8 modules" --
//      a far smaller labelling task than 147 raw names (the job-list case, where flat-name
//      grouping produced no usable split, live 2026-09-03).
//
//   C. MODEL GROUPS NAMES. No banner structure at all -> the original flat-name approach,
//      only for a file small enough (<= FLAT_NAME_CEILING) that one pass can hold it.
//
// Every grouped symbol is validated against the deterministically extracted set before the
// plan is written. Injectable `call` for tests; A + the parsers need no model.

const fs = require('fs');
const path = require('path');

const FLAT_NAME_CEILING = 45; // above this, a flat "group 147 names" pass just truncates

// --- deterministic symbol + section extraction --------------------------------------

// [{ name, line, kind }] for the file's top-level, movable symbols.
function extractTopLevelSymbols(text, ext) {
  const src = String(text || '');
  const lines = src.split('\n');
  const out = [];
  const seen = new Set();
  const add = (name, i, kind) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, line: i + 1, kind });
  };

  if (ext === '.py') {
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i])
        || /^class\s+([A-Za-z_]\w*)\b/.exec(lines[i]);
      if (m) add(m[1], i, lines[i].startsWith('class') ? 'class' : 'def');
    }
    return out;
  }

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i])
        || /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(lines[i]);
      if (m) add(m[1], i, 'fn');
    }
    return out;
  }

  if (ext === '.html' || ext === '.htm') {
    let inScript = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (/<script\b/i.test(lines[i])) inScript = true;
      if (/<\/script>/i.test(lines[i])) { inScript = false; continue; }
      if (!inScript) continue;
      const m = /^\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
      if (m) add(m[1], i, 'fn');
    }
    return out;
  }

  return out;
}

// A "section banner" -> a short label. STRICT: only an explicit divider comment, never
// flowing JSDoc prose (a comment ending in "view"/"state"/"section" is almost always a
// sentence, not a header -- confirmed against index.html, which produced 27 junk
// "sections" from a looser rule).
//   // --- Discovery tab ---            // === Chat panel ===            # --- foo ---
function bannerLabel(line) {
  const m = /^\s*(?:\/\/|#)\s*[-=]{3,}\s*(.+?)\s*[-=]{2,}\s*$/.exec(line);
  return m ? _trimLabel(m[1]) : null;
}
function _trimLabel(s) {
  return String(s).split(/\s+--\s+|[,(]/)[0].trim().replace(/\s+/g, ' ').slice(0, 50);
}

// "Anchor" functions -- a render<Foo>Tab / enter<Foo>Tab / <foo>Panel that clearly heads a
// feature cluster. index.html is one big soup of per-tab render functions + their helpers;
// grouping every symbol under the nearest preceding anchor recovers the tab structure the
// comments don't machine-encode. Returns the feature label (e.g. "job-list") or null.
function anchorLabel(name) {
  const m = /^(?:render|enter|leave|init|show|open|mount)([A-Z][A-Za-z0-9]*?)(?:Tab|Panel|Modal|View|Section)$/.exec(name);
  if (!m) return null;
  return m[1].replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// For a .py flask file, the @app.route("/api/<family>/...") prefix is a strong section
// signal -- route families cluster by URL. Returns the family for the def starting at
// `lineIdx`, scanning up to 3 decorator lines above it.
function routeFamily(lines, lineIdx) {
  for (let j = lineIdx - 1; j >= 0 && j >= lineIdx - 4; j -= 1) {
    const m = /@\w+\.route\(\s*["']\/(?:api\/)?([a-z0-9_-]+)/i.exec(lines[j]);
    if (m) return m[1];
    if (!/^\s*@/.test(lines[j]) && lines[j].trim() !== '') break;
  }
  return null;
}

// Assigns each symbol a `section`, cheapest-signal-first:
//   1. an explicit `// --- X ---` divider it sits under
//   2. (.py) the @app.route("/api/<family>/") family of the def
//   3. the nearest preceding "anchor" function (render<Foo>Tab &c) -- for a file that is
//      one flat run of per-feature functions with no dividers (index.html)
// null when none applies.
function assignSections(text, ext, symbols) {
  const lines = String(text || '').split('\n');
  const bannerByLine = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const lbl = bannerLabel(lines[i]);
    if (lbl) current = lbl;
    bannerByLine[i] = current;
  }
  // anchor label active from each anchor's line onward, until the next anchor
  const sorted = [...symbols].sort((a, b) => a.line - b.line);
  const anchorByLine = [];
  let curAnchor = null;
  let si = 0;
  for (let i = 0; i < lines.length; i += 1) {
    while (si < sorted.length && sorted[si].line - 1 === i) {
      const al = anchorLabel(sorted[si].name);
      if (al) curAnchor = al;
      si += 1;
    }
    anchorByLine[i] = curAnchor;
  }
  for (const s of symbols) {
    // .py: the @app.route family is the strongest signal (route families = modules); a
    // file-level `# --- X ---` divider in a 6,900-line file is far too coarse.
    let section = ext === '.py' ? routeFamily(lines, s.line - 1) : null;
    if (!section) section = bannerByLine[s.line - 1] || null;
    if (!section) section = anchorByLine[s.line - 1] || null;
    s.section = section;
  }
  return symbols;
}

// { label -> [symbols] }, symbols with no section under a shared "" key.
function groupBySection(symbols) {
  const groups = new Map();
  for (const s of symbols) {
    const k = s.section || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  return groups;
}

// --- move construction --------------------------------------------------------------

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'file';
}

function moveTemplateFor(sourceFile) {
  const ext = path.extname(sourceFile);
  const dir = path.dirname(sourceFile);
  if (ext === '.html' || ext === '.htm') {
    return { kind: 'script-extract', newFile: (slug) => `${dir}/static/js/${slug}.js` };
  }
  if (ext === '.py') {
    return { kind: 'flask-blueprint', newFile: (slug) => `${dir}/routes/${slug}.py`, blueprint: (slug) => `${slug.replace(/-/g, '_')}_bp` };
  }
  return { kind: 'module-extract', newFile: (slug) => `${dir}/lib/${slug}${ext}` };
}

function buildMove(sourceFile, label, symbolObjs, reason) {
  const tpl = moveTemplateFor(sourceFile);
  const slug = slugify(label);
  const move = { newFile: tpl.newFile(slug), kind: tpl.kind, symbols: symbolObjs.map((s) => s.name) };
  if (tpl.blueprint) move.blueprint = tpl.blueprint(slug);
  if (reason) move.notes = String(reason).slice(0, 300);
  return move;
}

// --- Path A: deterministic section grouping ---------------------------------------

// Returns moves[] (>=2) or null if the section structure isn't clean enough to trust.
function planFromSections(sourceFile, symbols) {
  const groups = groupBySection(symbols);
  const sectionless = (groups.get('') || []).length;
  const named = [...groups.entries()].filter(([k]) => k !== '');
  if (named.length < 3) return null; // not enough banner structure
  if (sectionless > symbols.length * 0.35) return null; // too much doesn't fit a section
  // A single group holding most of the file means the sectioning is too coarse to trust
  // (app.py's 6 file-level `# --- X ---` dividers put 115 symbols in one "section").
  const biggest = Math.max(...named.map(([, s]) => s.length));
  if (biggest > Math.max(30, symbols.length * 0.45)) return null;

  // Merge trivially small sections (1 symbol) into a shared "misc" bucket so we don't
  // emit a dozen one-function files.
  const misc = [];
  const kept = [];
  for (const [label, syms] of named) {
    if (syms.length === 1) misc.push(...syms);
    else kept.push([label, syms]);
  }
  if (kept.length < 3 || kept.length > 8) return null; // too few / too many -> let the model merge (Path B)
  const moves = kept.map(([label, syms]) => buildMove(sourceFile, label, syms, `section: ${label}`));
  const miscAll = [...misc, ...(groups.get('') || [])];
  if (miscAll.length >= 2 && miscAll.length < symbols.length * 0.4) {
    moves.push(buildMove(sourceFile, 'shared-misc', miscAll, 'symbols with no clear section -- grouped together, split later if needed'));
  }
  return moves.length >= 2 ? moves : null;
}

// --- Path B: model groups the sections ---------------------------------------------

function sectionMergePrompt(sourceFile, groups) {
  const named = [...groups.entries()].filter(([k]) => k !== '');
  return [
    `${sourceFile} is too long and must be split into 3-8 modules. It is already organised into these sections (by its own comment banners). Some are too small to be their own module.`,
    '',
    'SECTIONS:',
    ...named.map(([label, syms]) => `  "${label}" -- ${syms.length} symbol(s): ${syms.slice(0, 8).map((s) => s.name).join(', ')}${syms.length > 8 ? ', ...' : ''}`),
    (groups.get('') || []).length ? `  (unsectioned) -- ${groups.get('').length} symbol(s)` : '',
    '',
    'Merge/keep these sections into 3 to 8 modules. Each module is a list of section labels (verbatim from above) that belong together. Every section must appear in exactly one module. Put unsectioned symbols in whichever module fits best via "includeUnsectioned": true on ONE module.',
    '',
    'Answer with ONLY a JSON array: [{"module": "short-kebab-name", "sections": ["Label A", "Label B"], "includeUnsectioned": false}]',
  ].filter(Boolean).join('\n');
}

function planFromSectionMerge(sourceFile, groups, response) {
  const named = new Map([...groups.entries()].filter(([k]) => k !== ''));
  const unsectioned = groups.get('') || [];
  let raw = String(response || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const a = raw.indexOf('['); const b = raw.lastIndexOf(']');
  if (a === -1 || b < a) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length < 2) return null;

  const usedSections = new Set();
  const moves = [];
  for (const m of parsed) {
    if (!m || typeof m !== 'object') continue;
    const secs = Array.isArray(m.sections) ? m.sections.filter((l) => named.has(l) && !usedSections.has(l)) : [];
    for (const l of secs) usedSections.add(l);
    let syms = secs.flatMap((l) => named.get(l));
    if (m.includeUnsectioned) syms = syms.concat(unsectioned);
    if (syms.length < 1) continue;
    moves.push(buildMove(sourceFile, m.module || secs[0] || 'module', syms, `merged sections: ${secs.join(' + ')}`));
  }
  // Any section the model forgot -> its own move rather than silently dropped.
  for (const [label, syms] of named) {
    if (!usedSections.has(label)) moves.push(buildMove(sourceFile, label, syms, `section: ${label}`));
  }
  return moves.length >= 2 ? moves : null;
}

// --- Path C: model groups raw names (small structureless files) --------------------

function flatNamePrompt(sourceFile, symbols, headText) {
  const tpl = moveTemplateFor(sourceFile);
  return [
    `${sourceFile} is too long and must be split into smaller modules. Below is the COMPLETE list of its top-level symbols (extracted mechanically -- do not look for others).`,
    '',
    'Group these symbols into 3 to 6 cohesive modules (symbols that call each other or serve the same concern belong together). Every symbol goes in exactly one group.',
    '',
    `SYMBOLS (${symbols.length}):`,
    ...symbols.map((s) => `  ${s.name}  (${s.kind}, line ${s.line})`),
    '',
    'Context (first lines of the file):', '```', headText.slice(0, 2000), '```',
    '',
    'Answer with ONLY a JSON array. One object per module:',
    `[{"newFile": "${tpl.newFile('<name>')}", "kind": "${tpl.kind}", ${tpl.blueprint ? '"blueprint": "<name>_bp", ' : ''}"symbols": ["a", "b"], "reason": "..."}]`,
    'Use ONLY names from the list above, spelled exactly. Do not leave any symbol ungrouped.',
  ].join('\n');
}

function parseMovesJson(response, { validSymbols }) {
  const valid = new Set(validSymbols.map((s) => (typeof s === 'string' ? s : s.name)));
  const problems = [];
  let raw = String(response || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('['); const end = raw.lastIndexOf(']');
  if (start === -1 || end < start) return { moves: [], dropped: [...valid], problems: ['no JSON array in response'] };
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (e) { return { moves: [], dropped: [...valid], problems: [`JSON parse failed: ${e.message}`] }; }
  if (!Array.isArray(parsed)) return { moves: [], dropped: [...valid], problems: ['top-level value is not an array'] };

  const moves = [];
  const claimed = new Set();
  for (const m of parsed) {
    if (!m || typeof m !== 'object') { problems.push('non-object entry skipped'); continue; }
    const syms = Array.isArray(m.symbols) ? m.symbols.filter((s) => valid.has(s) && !claimed.has(s)) : [];
    for (const s of syms) claimed.add(s);
    if (syms.length === 0) { problems.push(`"${m.newFile || '?'}" has no valid unclaimed symbols`); continue; }
    if (!m.newFile || typeof m.newFile !== 'string') { problems.push('entry missing newFile'); continue; }
    const move = { newFile: m.newFile, kind: m.kind || 'module-extract', symbols: syms };
    if (m.blueprint) move.blueprint = m.blueprint;
    if (m.reason) move.notes = String(m.reason).slice(0, 300);
    moves.push(move);
  }
  return { moves, dropped: [...valid].filter((s) => !claimed.has(s)), problems };
}

// --- the pass ---------------------------------------------------------------------

async function runFileDecomposePlanPass(sourceFile, {
  repoRoot,
  call = require('./local-client.js').call,
  requestId,
  minSymbols = 6,
} = {}) {
  const abs = path.isAbsolute(sourceFile) ? sourceFile : path.join(repoRoot || '.', sourceFile);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const ext = path.extname(sourceFile);
  const symbols = assignSections(text, ext, extractTopLevelSymbols(text, ext));
  if (symbols.length < minSymbols) return null;

  const headText = text.split('\n').slice(0, 80).join('\n');
  const doCall = (prompt) => call({ prompt, think: false, temperature: 0.2, source: 'file_decompose_plan' });
  let moves = null;
  let strategy = null;

  // A. deterministic section grouping
  moves = planFromSections(sourceFile, symbols);
  if (moves) strategy = 'sections (deterministic)';

  // B. model merges the sections
  if (!moves) {
    const groups = groupBySection(symbols);
    const named = [...groups.keys()].filter((k) => k !== '');
    if (named.length >= 3) {
      try {
        const r = await doCall(sectionMergePrompt(sourceFile, groups));
        moves = planFromSectionMerge(sourceFile, groups, r && r.response);
        if (moves) strategy = 'model merged sections';
      } catch { /* fall through */ }
    }
  }

  // C. model groups raw names -- only for a small enough structureless file
  if (!moves && symbols.length <= FLAT_NAME_CEILING) {
    try {
      const r = await doCall(flatNamePrompt(sourceFile, symbols, headText));
      const parsed = parseMovesJson(r && r.response, { validSymbols: symbols });
      if (parsed.moves.length >= 2 && parsed.dropped.length <= symbols.length * 0.4) {
        moves = parsed.moves;
        strategy = 'model grouped names';
      }
    } catch { /* fall through */ }
  }

  if (!moves || moves.length < 2) return null;

  // Final validation: every symbol referenced by a move must be a real extracted one, and
  // no symbol claimed twice.
  const valid = new Set(symbols.map((s) => s.name));
  const claimed = new Set();
  const clean = [];
  for (const mv of moves) {
    const syms = (mv.symbols || []).filter((s) => valid.has(s) && !claimed.has(s));
    for (const s of syms) claimed.add(s);
    if (syms.length) clean.push({ ...mv, symbols: syms });
  }
  if (clean.length < 2) return null;
  const dropped = [...valid].filter((s) => !claimed.has(s));
  if (dropped.length > symbols.length * 0.4) return null;

  return {
    id: requestId || `autodecomp-${slugify(sourceFile)}`,
    sourceFile,
    moves: clean,
    autoAuthored: true,
    planPassNote: `${clean.length} module(s) via ${strategy} from ${symbols.length} symbols`
      + (dropped.length ? ` (${dropped.length} left in place: ${dropped.slice(0, 8).join(', ')})` : ''),
  };
}

module.exports = {
  runFileDecomposePlanPass, extractTopLevelSymbols, assignSections, groupBySection,
  planFromSections, planFromSectionMerge, parseMovesJson, bannerLabel, routeFamily,
};
