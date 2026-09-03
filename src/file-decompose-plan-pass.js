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
// This pass authors it. It plays to the local model's actual strength -- it does NOT ask
// "hold this file and split it", it hands the model a DETERMINISTICALLY EXTRACTED list of
// the file's top-level symbols and asks only "group these names into cohesive modules".
// That is a bounded labelling task, not a comprehension-of-a-huge-file task. The result is
// validated (every grouped symbol must be one we actually extracted) before it is written
// as a queue/file-decompose-requests/<slug>.json.
//
// Injectable `call` for tests; deterministic symbol extraction + moves parsing are the
// testable core and need no model at all.

const fs = require('fs');
const path = require('path');

// --- deterministic symbol extraction -------------------------------------------------

// Returns [{ name, line, kind }] for the file's top-level, movable symbols. Per language:
//   .py    -> module-level `def` / `async def` / `class`, and a `@app.route`-decorated def
//   .js    -> top-level `function NAME`, `const/let/var NAME = (…) =>` / `= function`
//   .html  -> `function NAME(` declared inside a <script> block (the Jinja-template case:
//             these become plain browser scripts loaded by <script src>)
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
      // top-level (2-space or less indent) function declarations inside the block
      const m = /^\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
      if (m) add(m[1], i, 'fn');
    }
    return out;
  }

  return out;
}

// --- prompt -------------------------------------------------------------------------

function planPrompt(sourceFile, symbols, headText) {
  const ext = path.extname(sourceFile);
  const kind = ext === '.py' ? 'flask-blueprint' : ext === '.html' ? 'script-extract' : 'module-extract';
  const newDir = ext === '.html'
    ? `${path.dirname(sourceFile)}/static/js`
    : `${path.dirname(sourceFile)}/${ext === '.py' ? 'routes' : 'lib'}`;
  return [
    `${sourceFile} is too long and must be split into smaller modules. Below is the COMPLETE list of its top-level symbols (extracted mechanically -- do not look for others).`,
    '',
    'Your ONLY job: group these symbols into 3 to 8 cohesive new modules. Group by feature / concern (symbols that call each other, or serve the same UI area / endpoint family, belong together). Every symbol must go in exactly one group. A helper used by only one group goes with it.',
    '',
    `SYMBOLS (${symbols.length}):`,
    ...symbols.map((s) => `  ${s.name}  (${s.kind}, line ${s.line})`),
    '',
    'For context, the first lines of the file:',
    '```',
    headText.slice(0, 2500),
    '```',
    '',
    'Answer with ONLY a JSON array, nothing else. One object per new module:',
    `[{"newFile": "${newDir}/<name>${ext === '.html' ? '.js' : ext}", "kind": "${kind}", ${ext === '.py' ? '"blueprint": "<name>_bp", ' : ''}"symbols": ["symbolA", "symbolB"], "reason": "why these belong together"}]`,
    '',
    'Rules: use ONLY symbol names from the list above, spelled exactly. Do not invent names. Do not leave any symbol ungrouped. Prefer fewer, larger modules over many tiny ones.',
  ].join('\n');
}

// --- moves parsing / validation ---------------------------------------------------

// Returns { moves, dropped, problems } -- `moves` is the validated subset ready to write.
function parseMovesJson(response, { validSymbols, sourceFile }) {
  const valid = new Set(validSymbols.map((s) => (typeof s === 'string' ? s : s.name)));
  const problems = [];
  let raw = String(response || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return { moves: [], dropped: [], problems: ['no JSON array in response'] };
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (e) { return { moves: [], dropped: [], problems: [`JSON parse failed: ${e.message}`] }; }
  if (!Array.isArray(parsed)) return { moves: [], dropped: [], problems: ['top-level value is not an array'] };

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
  const dropped = [...valid].filter((s) => !claimed.has(s));
  return { moves, dropped, problems };
}

// --- the pass -------------------------------------------------------------------------

// runFileDecomposePlanPass(sourceFile, { repoRoot, call, requestId })
//   -> { id, sourceFile, moves, planPassNote } ready for queue/file-decompose-requests/,
//   or null if the file couldn't be read, had too few symbols to bother, or the model
//   never produced a usable grouping.
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
  const symbols = extractTopLevelSymbols(text, ext);
  if (symbols.length < minSymbols) return null; // not enough structure to split mechanically

  const prompt = planPrompt(sourceFile, symbols, text.split('\n').slice(0, 80).join('\n'));
  let result;
  try {
    // think:false, same reasoning as decompose-pass.js -- this is a bounded labelling task,
    // native reasoning just eats the generation budget and truncates the JSON.
    result = await call({ prompt, think: false, temperature: 0.2, source: 'file_decompose_plan' });
  } catch { return null; }

  const { moves, dropped, problems } = parseMovesJson(result && result.response, { validSymbols: symbols, sourceFile });
  if (moves.length < 2) return null; // one group == "don't split", which is the loop we're breaking
  // A handful of dropped helpers is fine (they stay in the source file); a large drop
  // means the model ignored the instruction -- don't file a half-plan.
  if (dropped.length > symbols.length * 0.4) return null;

  return {
    id: requestId || `autodecomp-${slugify(sourceFile)}`,
    sourceFile,
    moves,
    autoAuthored: true,
    planPassNote: `moves[] authored by file-decompose-plan-pass from ${symbols.length} extracted symbols`
      + (dropped.length ? ` (${dropped.length} helper(s) left in place: ${dropped.slice(0, 8).join(', ')})` : '')
      + (problems.length ? ` | parser notes: ${problems.slice(0, 3).join('; ')}` : ''),
  };
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'file';
}

module.exports = { runFileDecomposePlanPass, extractTopLevelSymbols, parseMovesJson, planPrompt };
