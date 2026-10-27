'use strict';

// leftover-references.js -- draft-time check: did the diff remove (or rename) a name that the tree still uses?
//
// 2026-10-07 (TaxHarvest needs-work tally, 51 chat-recorded verdicts): the largest deterministic class was "the draft
// removed or renamed an identifier and left a use behind" -- arch-review-ac-46 (twice) and ac-47 destructured the
// STATUS_* constants away and left `prev.status !== STATUS_PENDING` behind (ReferenceError on every task claim), ac-262
// renamed the `coord_only` keyword while four callers still passed it (TypeError). Each reached review-time or a human,
// and the redraft repeated the mistake because nothing told it which line it missed. This is the cheap check that does.
//
// Method (no model, no worktree needed beyond a base-tree grep the caller injects):
//   1. From the diff, take each file's REMOVED text and ADDED text. Names a file's removed text declares (function,
//      class, const/let/var, destructured and imported bindings, module.exports.x, and for Python def/class/top-level
//      assignments/imports plus def parameters) minus names any added text declares again = names that really went away.
//   2. grepBase(name) returns every word-boundary hit in the BASE tree. A hit is gone if the diff removes that very line
//      (matched per file by trimmed text, multiset); comment lines never count; added lines in changed files that
//      mention the name count as remaining references.
//   3. NARROW SCOPE, by design: a leftover in a file where the name was declared always counts (same-file). A leftover in
//      another file counts only for an EXPORTED name (JS export / module.exports, Python top-level non-underscore
//      def/class) or a removed Python PARAMETER used as a `name=` keyword -- and never in a file that declares the name
//      itself. Short or generic names are ignored. Everything else is left to review.
//
// WIRED into the agentic draft path only (agentic-draft-common.js resolveAgenticDraft). The Group B JSON change-set path
// (deterministic-draft-registry.js, script-extract.js via group-b-worktree-diff.js) does not call it yet.
//
// NOT covered (a known gap, filed as a brain dump): object-key renames (`tax2024:` -> `currentTax:`), property reads of
// a key the defining object lacks (`STATUS.PENDING` vs lowercase keys), and semantic changes where the name survives
// (a function that turns async). A clean pass here means "no leftover reference found", not "the change is correct".

const MIN_NAME_LENGTH = 5;
const MAX_NAMES_CHECKED = 12;
const MAX_LEFTOVERS_REPORTED = 5;
const MAX_REFS_PER_LEFTOVER = 3;

// Too generic to treat a hit on as "the removed thing is still used".
const STOP_NAMES = new Set([
  'value', 'items', 'props', 'state', 'event', 'query', 'params', 'options', 'config', 'input', 'output', 'count',
  'total', 'label', 'title', 'error', 'result', 'index', 'response', 'request', 'status', 'message', 'content',
  'data', 'name', 'child', 'children', 'callback', 'handler', 'target', 'source', 'filter', 'return', 'default',
]);

const JS_EXT_RE = /\.(?:[cm]?js|jsx|ts|tsx)$/i;
const PY_EXT_RE = /\.py$/i;
const IDENT = '[A-Za-z_$][\\w$]*';
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

// ---- diff parsing -----------------------------------------------------------------------------------------------

// { file -> { removed: [line...], added: [line...] } }. Header lines (---/+++) are skipped.
function splitDiffByFile(diff) {
  const out = new Map();
  let cur = null;
  let inHunk = false;
  for (const line of String(diff || '').split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      cur = { file: m[2], removed: [], added: [], deleted: false };
      out.set(m[2], cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (/^deleted file mode /.test(line)) cur.deleted = true;
    if (/^@@ /.test(line)) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('-')) cur.removed.push(line.slice(1));
    else if (line.startsWith('+')) cur.added.push(line.slice(1));
  }
  return out;
}

// ---- declaration extraction -------------------------------------------------------------------------------------

function bindingNames(list, { object }) {
  const names = [];
  for (let part of String(list).split(',')) {
    part = part.replace(/\/\/.*$/gm, '').replace(/^\s*\.\.\./, '').trim();
    if (!part) continue;
    part = part.replace(/=[\s\S]*$/, '').trim();
    if (object && part.includes(':')) part = part.split(':').pop().trim();
    if (/\s+as\s+/.test(part)) part = part.split(/\s+as\s+/).pop().trim();
    if (IDENT_RE.test(part)) names.push(part);
  }
  return names;
}

function declaredInJs(text) {
  const found = [];
  const add = (name, exported) => { if (IDENT_RE.test(name)) found.push({ name, exported: !!exported, kind: 'name' }); };
  // TOP-LEVEL declarations only (the match starts a line, unindented): a `const tempPath` inside a removed function body is that
  // function's local, and a same-spelled local or parameter in a sibling function is not a leftover use of it.
  const top = (m) => m.index === 0 || text[m.index - 1] === '\n';
  for (const m of text.matchAll(new RegExp(`(export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`, 'g'))) if (top(m)) add(m[2], m[1]);
  for (const m of text.matchAll(new RegExp(`(export\\s+)?(?:default\\s+)?class\\s+(${IDENT})`, 'g'))) if (top(m)) add(m[2], m[1]);
  for (const m of text.matchAll(new RegExp(`(export\\s+)?(?:const|let|var)\\s+(${IDENT})`, 'g'))) if (top(m)) add(m[2], m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s*([[{])([\s\S]*?)[\]}]\s*=/g)) {
    if (top(m)) for (const n of bindingNames(m[2], { object: m[1] === '{' })) add(n, false);
  }
  for (const m of text.matchAll(/import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([\s\S]*?)\})?\s*from/g)) {
    if (!top(m)) continue;
    if (m[1]) add(m[1], false);
    if (m[2]) for (const n of bindingNames(m[2], { object: false })) add(n, false);
  }
  for (const m of text.matchAll(new RegExp(`(?:module\\.)?exports\\.(${IDENT})\\s*=`, 'g'))) if (top(m)) add(m[1], true);
  for (const m of text.matchAll(/module\.exports\s*=\s*\{([\s\S]*?)\}/g)) {
    if (top(m)) for (const part of m[1].split(',')) add(part.replace(/\/\/.*$/gm, '').split(':')[0].trim(), true);
  }
  return found;
}

function paramNames(list) {
  const names = [];
  for (let part of String(list).split(',')) {
    part = part.replace(/#.*$/gm, '').replace(/^\s*\*{1,2}/, '').trim();
    part = part.replace(/=[\s\S]*$/, '').replace(/:[\s\S]*$/, '').trim();
    if (/^[A-Za-z_]\w*$/.test(part) && part !== 'self' && part !== 'cls') names.push(part);
  }
  return names;
}

function declaredInPy(text) {
  const found = [];
  const add = (name, exported, kind = 'name') => { found.push({ name, exported: !!exported, kind }); };
  for (const m of text.matchAll(/^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:->[^:\n]*)?:/gm)) {
    add(m[2], m[1] === '' && !m[2].startsWith('_'));
    for (const p of paramNames(m[3])) { add(p, false, 'param'); found[found.length - 1].fn = m[2]; }
  }
  for (const m of text.matchAll(/^([ \t]*)class\s+(\w+)/gm)) add(m[2], m[1] === '' && !m[2].startsWith('_'));
  for (const m of text.matchAll(/^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/gm)) add(m[1], !m[1].startsWith('_'));
  for (const m of text.matchAll(/from\s+[\w.]+\s+import\s+(\([\s\S]*?\)|[^\n]+)/g)) {
    if (!(m.index === 0 || text[m.index - 1] === '\n')) continue; // an import inside a function body is that function's local
    for (const n of bindingNames(m[1].replace(/[()]/g, ''), { object: false })) add(n, false);
  }
  return found;
}

function declaredNames(file, text) {
  if (PY_EXT_RE.test(file)) return declaredInPy(text);
  if (JS_EXT_RE.test(file)) return declaredInJs(text);
  return [];
}

// ---- reference matching -----------------------------------------------------------------------------------------

const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*|#)/;
const MINIFIED_LINE_LEN = 500; // a bundle line, not code anyone edits
const escName = (name) => name.replace(/[$]/g, '\\$');
// A plain binding is not reached through `obj.name`; only an EXPORTED name is used that way (`mod.parseRow(3)`).
const wordRe = (name, { member }) => new RegExp(`(?<![\\w$${member ? '' : '.'}])${escName(name)}(?![\\w$])`);
// A keyword argument, not a local assignment: `f(a, name=1)` / a continuation line `    name=1,`. `name = 1` (spaces) is an assignment.
const kwargRe = (name) => new RegExp(`(?:[(,]\\s*|^\\s*)${name}=(?!=)|[(,]\\s*${name}\\s*=(?!=)`);

function usableName(name) {
  return name.length >= MIN_NAME_LENGTH && !STOP_NAMES.has(name.toLowerCase());
}

// The names (with scope facts) the diff really removes: declared in a file's removed text, not declared again by any
// added text anywhere in the diff.
function removedDeclarations(byFile) {
  const redeclared = new Set();
  const redeclaredParams = new Set();
  for (const f of byFile.values()) {
    for (const d of declaredNames(f.file, f.added.join('\n'))) (d.kind === 'param' ? redeclaredParams : redeclared).add(d.name);
  }
  const removed = new Map(); // name -> { name, files:Set, exported, kind }
  for (const f of byFile.values()) {
    if (f.deleted) continue; // deleting a whole file is the dead-code gate's job (its importers are checked there)
    for (const d of declaredNames(f.file, f.removed.join('\n'))) {
      if (!usableName(d.name)) continue;
      if (d.kind === 'param' ? redeclaredParams.has(d.name) : redeclared.has(d.name)) continue;
      const key = `${d.kind}:${d.name}`;
      const e = removed.get(key) || { name: d.name, kind: d.kind, files: new Set(), exported: false, fns: new Set() };
      e.files.add(f.file);
      if (d.fn) e.fns.add(d.fn);
      e.exported = e.exported || d.exported;
      removed.set(key, e);
    }
  }
  return [...removed.values()];
}

// Remaining references to `name` after the diff, as [{ file, line, text, fromDiff }].
function remainingReferences(entry, byFile, grepBase) {
  const re = wordRe(entry.name, { member: entry.exported });
  const kw = entry.kind === 'param' ? kwargRe(entry.name) : null;
  // A keyword argument counts only on a line that calls THE function it was removed from (`_Settings(coord_only=...)` is another callee's
  // parameter of the same spelling). A continuation line of a multi-line call has no callee on it, so it is left to review.
  const callRe = kw ? new RegExp(`(?<![\\w$])(?:${[...entry.fns].map(escName).join('|')})\\s*\\(`) : null;
  const matches = (text) => (kw ? kw.test(text) && callRe.test(text) : re.test(text));
  const removedLeft = new Map(); // file -> Map(trimmed text -> count)
  for (const f of byFile.values()) {
    const m = new Map();
    for (const l of f.removed) m.set(l.trim(), (m.get(l.trim()) || 0) + 1);
    removedLeft.set(f.file, m);
  }
  const hits = [];
  const baseHits = (grepBase(entry.name) || []).filter((h) => h && typeof h.text === 'string');
  // A file that still declares the name (in base, untouched by this removal) owns its own uses.
  const declaringElsewhere = new Set();
  for (const h of baseHits) {
    if (declaredNames(h.file, h.text).some((d) => d.name === entry.name && d.kind === entry.kind)) declaringElsewhere.add(h.file);
  }
  for (const h of baseHits) {
    const gone = removedLeft.get(h.file);
    const t = h.text.trim();
    if (gone && gone.get(t) > 0) { gone.set(t, gone.get(t) - 1); continue; }
    if (COMMENT_LINE_RE.test(h.text) || h.text.length > MINIFIED_LINE_LEN || !matches(h.text)) continue;
    hits.push({ file: h.file, line: h.line, text: t });
  }
  for (const f of byFile.values()) {
    if (f.deleted) continue;
    for (const l of f.added) {
      if (!COMMENT_LINE_RE.test(l) && matches(l) && !declaredNames(f.file, l).some((d) => d.name === entry.name)) {
        hits.push({ file: f.file, line: null, text: l.trim(), fromDiff: true });
      }
    }
  }
  // Still declared by an untouched declaration -> not a removal at all.
  const stillDeclaredInDeclFile = hits.some((h) => entry.files.has(h.file) && declaredNames(h.file, h.text).some((d) => d.name === entry.name && d.kind === entry.kind));
  if (stillDeclaredInDeclFile) return [];
  return hits.filter((h) => entry.files.has(h.file) || !declaringElsewhere.has(h.file));
}

// -> [{ name, kind, declaredIn, scope:'same-file'|'cross-file'|'kwarg', refs:[...] }]
function findLeftoverReferences({ diff, grepBase }) {
  if (typeof grepBase !== 'function') return [];
  const byFile = splitDiffByFile(diff);
  if (byFile.size === 0) return [];
  const out = [];
  for (const entry of removedDeclarations(byFile).slice(0, MAX_NAMES_CHECKED)) {
    const refs = remainingReferences(entry, byFile, grepBase);
    const same = refs.filter((r) => entry.files.has(r.file));
    const cross = refs.filter((r) => !entry.files.has(r.file));
    const counted = entry.kind === 'param' ? refs : [...same, ...(entry.exported ? cross : [])];
    if (!counted.length) continue;
    out.push({
      name: entry.name,
      kind: entry.kind,
      declaredIn: [...entry.files][0],
      scope: entry.kind === 'param' ? 'kwarg' : (same.length ? 'same-file' : 'cross-file'),
      refs: counted.slice(0, MAX_REFS_PER_LEFTOVER),
    });
    if (out.length >= MAX_LEFTOVERS_REPORTED) break;
  }
  return out;
}

// ---- policy: block / advisory / off -----------------------------------------------------------------------------

function leftoverRefMode(env = process.env) {
  const v = String(env.AGENT_MANAGER_LEFTOVER_REF_MODE || '').trim().toLowerCase();
  return v === 'advisory' || v === 'off' ? v : 'block';
}

const refLabel = (r) => `${r.file}${r.line ? `:${r.line}` : ' (added by your diff)'} -- \`${r.text.slice(0, 120)}\``;

function describe(leftovers) {
  return leftovers.map((l) => {
    const what = l.kind === 'param' ? `the parameter \`${l.name}\`` : `\`${l.name}\``;
    return `${what} (removed from ${l.declaredIn}) is still referenced at ${l.refs.map(refLabel).join('; ')}`;
  });
}

// -> { action: 'none' | 'advisory' | 'block', names, reason, retryFeedback, advisoryText }
// priorNames: the sorted names an earlier attempt on this task was already blocked for. The same set twice in a row means
// the gate and the drafter disagree (a false positive, or a model that will not fix it): never strand the task on it --
// record an advisory and let review decide.
function checkLeftoverReferences({ diff, grepBase, mode = leftoverRefMode(), priorNames = null }) {
  if (mode === 'off') return { action: 'none', names: [] };
  let leftovers;
  try { leftovers = findLeftoverReferences({ diff, grepBase }); } catch { return { action: 'none', names: [] }; }
  if (!leftovers.length) return { action: 'none', names: [] };
  const names = leftovers.map((l) => l.name).sort();
  const lines = describe(leftovers);
  const reason = `diff removes a name that is still referenced -- ${lines.join('; ')}`;
  const repeat = Array.isArray(priorNames) && priorNames.length === names.length && priorNames.every((n, i) => n === names[i]);
  if (mode === 'advisory' || repeat) {
    return { action: 'advisory', names, reason, advisoryText: `leftover-reference gate (${repeat ? 'same names blocked before, not blocking again' : 'advisory mode'}): ${reason}` };
  }
  return {
    action: 'block',
    names,
    reason,
    retryFeedback: `Your diff removed or renamed a name but left a use of it behind: ${lines.join('. ')}. A reference left behind throws at runtime (ReferenceError / TypeError / ImportError). Either update EVERY remaining reference in the same change, or keep the declaration. Re-grep the whole tree for each name before you finish.`,
  };
}

// ---- base-tree grep (injected runGit so tests use a real temp repo) --------------------------------------------

const CODE_PATHSPECS = ['*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.tsx', '*.py', ':(exclude)**/node_modules/**', ':(exclude)**/graphify-out/**', ':(exclude)**/dist/**', ':(exclude)**/build/**'];

// Word-boundary hits for `name` at HEAD of `cwd` (the draft is staged, not committed, so HEAD is the base tree).
function makeGrepBase(runGit, cwd) {
  return (name) => {
    let out;
    try {
      out = runGit(['grep', '-nIw', '--no-color', '-e', name, 'HEAD', '--', ...CODE_PATHSPECS], cwd);
    } catch { return []; } // exit 1 = no match; a timeout / git error reads as "no references found", never a block
    const hits = [];
    for (const row of String(out).split('\n')) {
      const m = row.match(/^HEAD:(.+?):(\d+):(.*)$/);
      if (m) hits.push({ file: m[1], line: Number(m[2]), text: m[3] });
    }
    return hits;
  };
}

module.exports = {
  findLeftoverReferences, checkLeftoverReferences, leftoverRefMode, makeGrepBase,
  splitDiffByFile, declaredNames, MIN_NAME_LENGTH,
};
